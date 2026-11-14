/**
 * Host half of the UI experience bundle: resolves the matugen palette files,
 * maps one onto DSW theme tokens, and exposes the palette, the mode switch, and
 * the palette paths to the browser half through a Typert Remote service
 * (`ctx.remote.uiExperience`). The client polls on an interval, so a
 * regeneration or a configuration change is picked up without file watchers.
 *
 * Every configuration field is `.volatile()`: the switch, the border width, and
 * both palette paths apply in place without restarting this plugin, so the
 * client's next poll reads the new values and no restart window exists in which
 * a stale `active` could contradict the switch the user just moved.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { readFile as readFileAsync, stat as statAsync } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  BOOT_ATTRIBUTE, DEFAULT_COLORS_PATH, DEFAULT_TOKENS_PATH, REMOTE_SERVICE,
  type MotionMode, type MotionReduced, type MotionSettings,
  type PalettePaths, type PollArgs, type PollResult, type SetActiveArgs, type SetActiveResult,
  type SetMotionArgs, type SetMotionResult,
  type SetPathsArgs, type SetPathsResult, type ThemeTokenModes, type ThemeTokenTable,
} from './shared.ts'
import { MATUGEN_ROLES, mapColors, PALETTE_TOKENS, type MatugenColors } from './palette.ts'

/** Plugin-owned diagnostics log: the Desktop host discards stdout/stderr, so
 *  operational events land here instead. Truncated once it outgrows the cap. */
const LOG_FILE = join(homedir(), '.dsh', 'ui-experience.log')
const LOG_MAX_BYTES = 512 * 1024

/**
 * Append one line to the plugin log, truncating it first once it is oversized.
 * @param message - the line to record.
 */
function logLine(message: string): void {
  try {
    const dir = dirname(LOG_FILE)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) writeFileSync(LOG_FILE, '')
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`)
  } catch (error) {
    console.error(`[ui-experience] failed to write ${LOG_FILE}: ${(error as Error).message}`)
  }
}

/** Loader entry identity the config editor persists against. */
interface PluginEntryRef {
  options: { id: string }
}

/** One row of the webserver's index-injection table. */
type IndexInjectionRow =
  | { kind: 'style'; text: string }
  | { kind: 'script'; placement: 'head' | 'body'; text: string }

/** The Cordis context face this plugin consumes. */
interface HostContext {
  fiber: { entry?: PluginEntryRef }
  on(name: 'webserver/index-inject', listener: (table: IndexInjectionRow[]) => void): () => void
  configEditor: {
    edit(entry: PluginEntryRef, change: (current: Record<string, unknown>) => Record<string, unknown>): Promise<unknown>
  }
}

/** A volatile configuration field: `.get()` reads its live value. */
interface VolatileValue<T> {
  get(): T
}

/** Valid border width: a number with an explicit CSS unit. */
const BORDER_WIDTH = /^(?:0|[0-9]+(?:\.[0-9]+)?(?:px|rem|em))$/

/** Valid palette path: absolute, or `~` / `~/`-relative. */
const PATH_PATTERN = /^(?:~$|~\/|\/)/

/** Valid motion curve family. */
const MOTION_MODE = /^(?:off|m3|m3e)$/

/** Valid reduced-motion policy. */
const MOTION_REDUCED = /^(?:system|always)$/

/** Plugin configuration. Every field is volatile, so edits apply in place. */
export const Config = z.object({
  active: z.boolean().default(false).volatile(),
  borderWidth: z.string().pattern(BORDER_WIDTH).default('0.5px').volatile(),
  colorsPath: z.string().pattern(PATH_PATTERN).default(DEFAULT_COLORS_PATH).volatile(),
  tokensPath: z.string().pattern(PATH_PATTERN).default(DEFAULT_TOKENS_PATH).volatile(),
  motion: z.string().pattern(MOTION_MODE).default('off').volatile(),
  motionDurationScale: z.number().min(0.5).max(2).default(1).volatile(),
  motionSpatialSplit: z.boolean().default(true).volatile(),
  motionQuantize: z.boolean().default(false).volatile(),
  motionReduced: z.string().pattern(MOTION_REDUCED).default('system').volatile(),
  motionScroll: z.boolean().default(true).volatile(),
  motionStream: z.boolean().default(true).volatile(),
  motionFollowScroll: z.boolean().default(true).volatile(),
  streamRevealMinMs: z.number().min(60).max(2000).default(250).volatile(),
  streamRevealMaxMs: z.number().min(200).max(8000).default(1200).volatile(),
  streamEnterMs: z.number().min(0).max(2000).default(220).volatile(),
  streamRollMs: z.number().min(0).max(2000).default(260).volatile(),
})

/** Resolved configuration: each field is a live getter. */
type Config = {
  active: VolatileValue<boolean>
  borderWidth: VolatileValue<string>
  colorsPath: VolatileValue<string>
  tokensPath: VolatileValue<string>
  motion: VolatileValue<string>
  motionDurationScale: VolatileValue<number>
  motionSpatialSplit: VolatileValue<boolean>
  motionQuantize: VolatileValue<boolean>
  motionReduced: VolatileValue<string>
  motionScroll: VolatileValue<boolean>
  motionStream: VolatileValue<boolean>
  motionFollowScroll: VolatileValue<boolean>
  streamRevealMinMs: VolatileValue<number>
  streamRevealMaxMs: VolatileValue<number>
  streamEnterMs: VolatileValue<number>
  streamRollMs: VolatileValue<number>
}

/** Plain color value: a hex color, or a CSS function with no nested rules. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/

/**
 * A token value that cannot escape the declaration it is written into. Rendered
 * token values may legitimately be `color-mix(…)`, `rgb(…)`, or any other color
 * function, so the rule blocks the characters that would end the declaration or
 * open a nested rule rather than restricting the color syntax itself.
 */
const CSS_VALUE_FORBIDDEN = /[{};<>\n\r]|\/\*|\*\//
const CSS_VALUE_MAX_LENGTH = 256

/**
 * Check one token value for characters that could escape its declaration.
 * @param value - token value from the palette file.
 * @returns whether the value is safe to write into a CSS custom property.
 */
function isSafeTokenValue(value: string): boolean {
  return value.length > 0 && value.length <= CSS_VALUE_MAX_LENGTH && !CSS_VALUE_FORBIDDEN.test(value)
}

/** Prototype property the Typert runtime reads for the Remote method table. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/**
 * Validate a matugen colors table.
 * @param value - parsed JSON value.
 * @returns the validated colors table.
 */
function validateColors(value: unknown): MatugenColors {
  if (typeof value !== 'object' || value === null) {
    throw new Error('matugen colors file is not a JSON object')
  }
  const colors = value as Record<string, unknown>
  for (const key of MATUGEN_ROLES) {
    const color = colors[key]
    if (typeof color !== 'string' || !HEX_COLOR.test(color)) {
      throw new Error(`matugen colors file: role "${key}" is missing or not a hex color`)
    }
  }
  return colors as MatugenColors
}

/**
 * Validate a pre-mapped DSH token document ({ light, dark } token tables). Every
 * value must stay inside its declaration, so a malformed file cannot smuggle
 * rules into the stylesheet the client builds from it.
 * @param value - parsed JSON value.
 * @returns the validated token modes.
 */
function validateTokenDocument(value: unknown): ThemeTokenModes {
  if (typeof value !== 'object' || value === null) {
    throw new Error('dsh-tokens file must be { "light": {...}, "dark": {...} } token tables')
  }
  const document = value as Record<string, unknown>
  for (const mode of ['light', 'dark'] as const) {
    const table = document[mode]
    if (typeof table !== 'object' || table === null) {
      throw new Error(`dsh-tokens file: missing "${mode}" token table`)
    }
    for (const [name, color] of Object.entries(table)) {
      if (!name.startsWith('--dsw-')) {
        throw new Error(`dsh-tokens file: invalid token name ${JSON.stringify(name)}`)
      }
      if (typeof color !== 'string' || !isSafeTokenValue(color)) {
        throw new Error(`dsh-tokens file: token "${name}" must be a CSS value without braces, semicolons, or angle brackets, got ${JSON.stringify(color)}`)
      }
    }
  }
  return document as unknown as ThemeTokenModes
}

/**
 * Expand a configured path and require an absolute result. An unusable value is
 * reported as an error rather than silently skipped.
 * @param raw - path as written in the configuration.
 * @param label - configuration field name, for the message.
 * @returns the absolute path.
 */
function resolvePath(raw: string, label: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') throw new Error(`ui-experience: ${label} is empty; set it in the plugin configuration`)
  const expanded = trimmed === '~'
    ? homedir()
    : trimmed.startsWith('~/') ? join(homedir(), trimmed.slice(2)) : trimmed
  if (!isAbsolute(expanded)) {
    throw new Error(`ui-experience: ${label} must be absolute or start with "~/": ${raw}`)
  }
  return expanded
}

/**
 * Read the live configuration as palette paths, without expanding them.
 * @param config - resolved plugin configuration.
 * @returns the configured paths.
 */
function effectivePaths(config: Config): PalettePaths {
  return { colors: config.colorsPath.get(), tokens: config.tokensPath.get() }
}

/**
 * Read the live motion settings. The schema pins both enumerations and the
 * duration-scale range, so the stored values are already a `MotionSettings`; the
 * casts only narrow the plain strings the resolved configuration exposes.
 * @param config - resolved plugin configuration.
 * @returns the motion settings in force.
 */
function effectiveMotion(config: Config): MotionSettings {
  return {
    mode: config.motion.get() as MotionMode,
    durationScale: config.motionDurationScale.get(),
    spatialSplit: config.motionSpatialSplit.get(),
    quantize: config.motionQuantize.get(),
    reduced: config.motionReduced.get() as MotionReduced,
    scroll: config.motionScroll.get(),
    stream: config.motionStream.get(),
    followScroll: config.motionFollowScroll.get(),
    streamRevealMinMs: config.streamRevealMinMs.get(),
    streamRevealMaxMs: config.streamRevealMaxMs.get(),
    streamEnterMs: config.streamEnterMs.get(),
    streamRollMs: config.streamRollMs.get(),
  }
}

/** One parsed palette, tagged with the file and version it came from. */
interface Palette {
  source: string
  version: string
  tokens: ThemeTokenModes
}

/** Outcome of resolving the palette files. */
type PaletteRead =
  | { ok: true; paths: PalettePaths; palette: Palette }
  | { ok: false; paths: PalettePaths; status: 'missing' | 'error'; message: string }

/** Parsed palette cache keyed by source path and version, so steady-state polls
 *  only stat the file instead of re-parsing and re-mapping it. */
let paletteCache: Palette | undefined

/** Upper bound on a palette file. A larger file is refused rather than read. */
const PALETTE_MAX_BYTES = 4 * 1024 * 1024

/** Read a file's text without blocking the event loop. */
const readFileText = (path: string): Promise<string> => readFileAsync(path, 'utf8')

/** Stat a file without blocking the event loop. */
const statFile = (path: string): Promise<{ mtimeMs: number; size: number }> => statAsync(path)

/** The palette files in effect, expanded to absolute paths. */
interface ResolvedSources {
  paths: PalettePaths
  tokensFile: string
  colorsFile: string
  /** The dedicated token file exists, so its values layer over the mapping. */
  hasTokens: boolean
  /** The raw matugen colors file exists, so the built-in mapping is available. */
  hasColors: boolean
}

/**
 * A palette file's parsed contribution, tagged with the identity used for cache
 * invalidation: path, mtime, and size.
 */
interface LoadedPart {
  key: string
  has: boolean
  modes?: ThemeTokenModes
}

/**
 * Expand the configured paths and report which files exist.
 * @param config - resolved plugin configuration.
 * @returns the resolved files, or the reason they are unusable.
 */
function resolveSources(config: Config): { ok: true; sources: ResolvedSources } | { ok: false; paths: PalettePaths; status: 'error'; message: string } {
  const paths = effectivePaths(config)
  try {
    const tokensFile = resolvePath(paths.tokens, 'tokensPath')
    const colorsFile = resolvePath(paths.colors, 'colorsPath')
    return {
      ok: true,
      sources: {
        paths, tokensFile, colorsFile,
        hasTokens: existsSync(tokensFile),
        hasColors: existsSync(colorsFile),
      },
    }
  } catch (error) {
    return { ok: false, paths, status: 'error', message: (error as Error).message }
  }
}

/**
 * The layer order in effect: the raw matugen mapping is the base, and the
 * dedicated token file layers over it. A token file that omits a token therefore
 * keeps the mapped Material value instead of dropping the token back to the
 * built-in palette — a partial file must not punch holes in the whole theme.
 * @param sources - the resolved palette files in effect.
 * @param mapped - the parsed matugen mapping, when the colors file exists.
 * @param tokens - the parsed token document, when the token file exists.
 * @returns the composed per-mode token tables.
 */
function composePalette(
  sources: ResolvedSources, mapped: ThemeTokenModes | undefined, tokens: ThemeTokenModes | undefined,
): ThemeTokenModes {
  if (mapped === undefined && tokens === undefined) {
    throw new Error(`no palette file at tokensPath (${sources.tokensFile}) or colorsPath (${sources.colorsFile})`)
  }
  if (mapped === undefined) return tokens!
  if (tokens === undefined) return mapped
  return {
    light: { ...mapped.light, ...tokens.light },
    dark: { ...mapped.dark, ...tokens.dark },
  }
}

/**
 * Record what the dedicated token file covers, per mode.
 *
 * With a colors file underneath, a partial token file is exactly the documented
 * use — override the few tokens that matter and let the mapping supply the rest —
 * so this only reports the counts. Without one, there is nothing to fall back on
 * but the shipped palette, and since the colors file carries a single dark scheme
 * the two modes are not interchangeable: naming the tokens that stay on the
 * shipped palette is what makes that visible.
 *
 * @param tokens - the parsed token document, when present.
 * @param mapped - the parsed matugen mapping, when present.
 */
function auditCoverage(tokens: ThemeTokenModes | undefined, mapped: ThemeTokenModes | undefined): void {
  if (tokens === undefined) return
  if (mapped !== undefined) {
    logLine(`palette composed from colorsPath mapping + tokensPath overrides`
      + ` (light ${coverage(tokens.light)}/${PALETTE_TOKENS.length}, dark ${coverage(tokens.dark)}/${PALETTE_TOKENS.length})`)
    return
  }
  const missingLight = PALETTE_TOKENS.filter(token => typeof tokens.light[token] !== 'string')
  const missingDark = PALETTE_TOKENS.filter(token => typeof tokens.dark[token] !== 'string')
  logLine(`no colorsPath base: tokensPath covers light ${coverage(tokens.light)}/${PALETTE_TOKENS.length}`
    + `, dark ${coverage(tokens.dark)}/${PALETTE_TOKENS.length}`)
  if (missingLight.length > 0) {
    logLine(`light mode keeps the shipped palette for ${missingLight.length} token(s): ${summarize(missingLight)}`)
  }
  if (missingDark.length > 0) {
    logLine(`dark mode keeps the shipped palette for ${missingDark.length} token(s): ${summarize(missingDark)}`)
  }
  if (missingLight.length > 0 || missingDark.length > 0) {
    logLine(`a complete template ships at ${templatePath()}; it covers every token in both modes`)
  }
}

/**
 * How many of the mapped tokens one table actually sets.
 * @param table - one mode's token table.
 * @returns the count, for diagnostics.
 */
function coverage(table: ThemeTokenTable): number {
  return PALETTE_TOKENS.filter(token => typeof table[token] === 'string').length
}

/**
 * Render a token list for one log line, truncated so a nearly empty palette does
 * not write hundreds of names.
 * @param tokens - the tokens to name.
 * @returns the names, comma-separated, with a count for the remainder.
 */
function summarize(tokens: readonly string[]): string {
  const shown = tokens.slice(0, LOGGED_TOKEN_NAMES)
  const rest = tokens.length - shown.length
  return rest > 0 ? `${shown.join(', ')}, and ${rest} more` : shown.join(', ')
}

/** Token names one log line spells out before it counts the rest. */
const LOGGED_TOKEN_NAMES = 12

/** Absolute path of the complete matugen template shipped with this bundle. */
function templatePath(): string {
  return fileURLToPath(new URL('../templates/dsh-tokens.json', import.meta.url))
}

/**
 * Parse the matugen colors file into the built-in mapping.
 * @param text - the file contents.
 * @returns the mapped per-mode token tables.
 */
function parseMapped(text: string): ThemeTokenModes {
  // matugen's colors.json carries a single (dark) scheme; both theme modes get
  // the same table, so switching light/dark only moves uncovered tokens.
  const table: ThemeTokenTable = mapColors(validateColors(JSON.parse(text)))
  return { light: table, dark: table }
}

/**
 * Load one palette part and assert its size limit.
 * @param path - absolute file path.
 * @param parse - turns the file text into token modes.
 * @returns the parsed part, or undefined when the file does not exist.
 */
function loadPartSync(path: string, exists: boolean, parse: (text: string) => ThemeTokenModes): LoadedPart {
  if (!exists) return { key: '-', has: false }
  const stat = statSync(path)
  if (stat.size > PALETTE_MAX_BYTES) {
    throw new Error(`${path} is ${stat.size} bytes, over the ${PALETTE_MAX_BYTES} byte limit`)
  }
  return { key: `${path}@${stat.mtimeMs}:${stat.size}`, has: true, modes: parse(readFileSync(path, 'utf8')) }
}

/**
 * Read the palette for the pre-plugin paint. Page renders are occasional, so this
 * stays synchronous, but each file's size is bounded first.
 * @param config - resolved plugin configuration.
 * @returns the palette, or the reason it is unavailable.
 */
function readPaletteSync(config: Config): PaletteRead {
  const resolved = resolveSources(config)
  if (!resolved.ok) return resolved
  const { sources } = resolved
  if (!sources.hasTokens && !sources.hasColors) {
    return {
      ok: false, paths: sources.paths, status: 'missing',
      message: `no palette file at tokensPath (${sources.tokensFile}) or colorsPath (${sources.colorsFile})`,
    }
  }
  try {
    const mapped = loadPartSync(sources.colorsFile, sources.hasColors, parseMapped)
    const tokens = loadPartSync(sources.tokensFile, sources.hasTokens, text => validateTokenDocument(JSON.parse(text)))
    const version = `${mapped.key}|${tokens.key}`
    if (paletteCache !== undefined && paletteCache.version === version) {
      return { ok: true, paths: sources.paths, palette: paletteCache }
    }
    const modes = composePalette(sources, mapped.modes, tokens.modes)
    auditCoverage(tokens.modes, mapped.modes)
    paletteCache = { source: sources.paths.tokens, version, tokens: modes }
    return { ok: true, paths: sources.paths, palette: paletteCache }
  } catch (error) {
    return {
      ok: false, paths: sources.paths, status: 'error',
      message: `cannot read palette: ${(error as Error).message}`,
    }
  }
}

/**
 * Load one palette part without blocking the Host event loop.
 * @param path - absolute file path.
 * @param exists - whether the file is present.
 * @param parse - turns the file text into token modes.
 * @returns the parsed part.
 */
async function loadPart(path: string, exists: boolean, parse: (text: string) => ThemeTokenModes): Promise<LoadedPart> {
  if (!exists) return { key: '-', has: false }
  const stat = await statFile(path)
  if (stat.size > PALETTE_MAX_BYTES) {
    throw new Error(`${path} is ${stat.size} bytes, over the ${PALETTE_MAX_BYTES} byte limit`)
  }
  return { key: `${path}@${stat.mtimeMs}:${stat.size}`, has: true, modes: parse(await readFileText(path)) }
}

/**
 * Read the palette for the poll endpoint without blocking the Host event loop.
 * Steady-state polls only stat the files; the cached tables are reused.
 * @param config - resolved plugin configuration.
 * @returns the palette, or the reason it is unavailable.
 */
async function readPalette(config: Config): Promise<PaletteRead> {
  const resolved = resolveSources(config)
  if (!resolved.ok) return resolved
  const { sources } = resolved
  if (!sources.hasTokens && !sources.hasColors) {
    return {
      ok: false, paths: sources.paths, status: 'missing',
      message: `no palette file at tokensPath (${sources.tokensFile}) or colorsPath (${sources.colorsFile})`,
    }
  }
  try {
    const mapped = await loadPart(sources.colorsFile, sources.hasColors, parseMapped)
    const tokens = await loadPart(sources.tokensFile, sources.hasTokens, text => validateTokenDocument(JSON.parse(text)))
    const version = `${mapped.key}|${tokens.key}`
    if (paletteCache !== undefined && paletteCache.version === version) {
      return { ok: true, paths: sources.paths, palette: paletteCache }
    }
    const modes = composePalette(sources, mapped.modes, tokens.modes)
    auditCoverage(tokens.modes, mapped.modes)
    paletteCache = { source: sources.paths.tokens, version, tokens: modes }
    return { ok: true, paths: sources.paths, palette: paletteCache }
  } catch (error) {
    return {
      ok: false, paths: sources.paths, status: 'error',
      message: `cannot read palette: ${(error as Error).message}`,
    }
  }
}

/**
 * Pick one base background for the pre-plugin paint. Only a plain hex color is
 * embedded in the boot stylesheet; anything else falls back and says so.
 * @param value - token value from the palette.
 * @param mode - palette mode the value came from, for the fallback and log.
 * @returns a hex color.
 */
function bootColor(value: string | undefined, mode: 'light' | 'dark'): string {
  if (value !== undefined && HEX_COLOR.test(value)) return value
  const fallback = mode === 'light' ? '#fff' : '#151517'
  logLine(`boot paint: ${mode} base color ${JSON.stringify(value)} is not a hex color; using ${fallback}`)
  return fallback
}

/**
 * Index rows that repaint the pre-plugin canvas with the palette. The rules are
 * scoped by the attribute the boot script sets, so the client can drop the
 * attribute and hand the canvas back to the built-in boot style immediately.
 * The built-in boot CSS already resolves light/dark from the theme preference
 * and tags `<body data-ds-dark-theme>`, which is the only signal used here.
 * @param palette - palette in effect.
 * @returns the style row and the script row that enables it.
 */
function bootRows(palette: Palette): IndexInjectionRow[] {
  const light = bootColor(palette.tokens.light['--dsw-alias-bg-base'], 'light')
  const dark = bootColor(palette.tokens.dark['--dsw-alias-bg-base'], 'dark')
  const scope = `html[${BOOT_ATTRIBUTE}]`
  const text = `${scope} body[data-ds-dark-theme]{background-color:${dark};--dsh-boot-bg:${dark}}`
    + `${scope} body:not([data-ds-dark-theme]){background-color:${light};--dsh-boot-bg:${light}}`
  return [
    { kind: 'style', text },
    {
      kind: 'script',
      placement: 'body',
      text: `document.documentElement.toggleAttribute(${JSON.stringify(BOOT_ATTRIBUTE)}, true)`,
    },
  ]
}

/** Remote service the browser half polls for palette updates and configuration. */
class UiExperienceService extends TypertRemoteService {
  constructor(
    ctx: HostContext,
    private readonly config: Config,
    /** Entry of THIS plugin's loader row, captured from the apply fiber: the
     *  service context re-parents to the Typert gateway during Remote calls,
     *  so reading `this.ctx.fiber.entry` inside an endpoint would address the
     *  gateway's entry instead of ours. */
    private readonly entry: PluginEntryRef | undefined,
    /** Config editor captured from the apply context, for the same
     *  re-parenting reason as `entry`. */
    private readonly editor: HostContext['configEditor'] | undefined,
  ) {
    super(ctx as never, REMOTE_SERVICE)
  }

  /**
   * Remote poll endpoint: report the palette when it changed since the caller's
   * known version, and always report the live switch, border width, paths, and
   * motion settings.
   * @param args - the caller's last seen version.
   * @returns the poll payload.
   */
  async poll(args?: PollArgs): Promise<PollResult> {
    const read = await readPalette(this.config)
    const active = this.config.active.get()
    const borderWidth = this.config.borderWidth.get()
    const motion = effectiveMotion(this.config)
    if (!read.ok) {
      return { status: read.status, message: read.message, active, borderWidth, paths: read.paths, motion }
    }
    const { palette, paths } = read
    if (args?.known === palette.version) {
      return {
        status: 'ok', changed: false, version: palette.version, source: palette.source,
        active, borderWidth, paths, motion,
      }
    }
    return {
      status: 'ok', changed: true, version: palette.version, tokens: palette.tokens,
      source: palette.source, active, borderWidth, paths, motion,
    }
  }

  /**
   * Remote endpoint persisting the Matugen mode switch.
   * @param args - the requested switch state.
   * @returns the persisted state.
   */
  async setActive(args?: SetActiveArgs): Promise<SetActiveResult> {
    const next = args?.active
    if (typeof next !== 'boolean') throw new Error('ui-experience: setActive requires a boolean `active`')
    await this.persist(current => ({ ...current, active: next }))
    logLine(`setActive(${next}) persisted`)
    return { active: next }
  }

  /**
   * Remote endpoint persisting the palette paths.
   * @param args - the paths to write; an omitted field keeps its value.
   * @returns the paths now in effect.
   */
  async setPaths(args?: SetPathsArgs): Promise<SetPathsResult> {
    const colors = typeof args?.colorsPath === 'string' ? args.colorsPath.trim() : undefined
    const tokens = typeof args?.tokensPath === 'string' ? args.tokensPath.trim() : undefined
    if (colors === undefined && tokens === undefined) {
      throw new Error('ui-experience: setPaths requires `colorsPath` or `tokensPath`')
    }
    if (colors !== undefined) resolvePath(colors, 'colorsPath')
    if (tokens !== undefined) resolvePath(tokens, 'tokensPath')
    await this.persist(current => ({
      ...current,
      ...(colors === undefined ? {} : { colorsPath: colors }),
      ...(tokens === undefined ? {} : { tokensPath: tokens }),
    }))
    const paths: PalettePaths = {
      colors: colors ?? this.config.colorsPath.get(),
      tokens: tokens ?? this.config.tokensPath.get(),
    }
    logLine(`setPaths: colors=${paths.colors} tokens=${paths.tokens}`)
    return { paths }
  }

  /**
   * Remote endpoint persisting the motion layer settings. Every field is
   * optional, and an omitted field keeps its stored value so one control can be
   * changed without resending the rest.
   * @param args - the fields to write.
   * @returns the settings now in effect.
   */
  async setMotion(args?: SetMotionArgs): Promise<SetMotionResult> {
    const mode = args?.mode
    const reduced = args?.reduced
    const scale = args?.durationScale
    const spatialSplit = args?.spatialSplit
    const quantize = args?.quantize
    const scroll = args?.scroll
    const stream = args?.stream
    const followScroll = args?.followScroll
    const streamRevealMinMs = args?.streamRevealMinMs
    const streamRevealMaxMs = args?.streamRevealMaxMs
    const streamEnterMs = args?.streamEnterMs
    const streamRollMs = args?.streamRollMs
    if (mode === undefined && reduced === undefined && scale === undefined
      && spatialSplit === undefined && quantize === undefined && scroll === undefined
      && stream === undefined && followScroll === undefined
      && streamRevealMinMs === undefined && streamRevealMaxMs === undefined
      && streamEnterMs === undefined && streamRollMs === undefined) {
      throw new Error('ui-experience: setMotion requires at least one field')
    }
    for (const [name, value] of [
      ['streamRevealMinMs', streamRevealMinMs], ['streamRevealMaxMs', streamRevealMaxMs],
      ['streamEnterMs', streamEnterMs], ['streamRollMs', streamRollMs],
    ] as const) {
      if (value === undefined) continue
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`ui-experience: ${name} must be a non-negative number, got ${String(value)}`)
      }
    }
    if (mode !== undefined && !MOTION_MODE.test(mode)) {
      throw new Error(`ui-experience: unknown motion mode ${JSON.stringify(mode)}`)
    }
    if (reduced !== undefined && !MOTION_REDUCED.test(reduced)) {
      throw new Error(`ui-experience: unknown reduced-motion policy ${JSON.stringify(reduced)}`)
    }
    if (scale !== undefined && (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.5 || scale > 2)) {
      throw new Error(`ui-experience: durationScale ${String(scale)} is outside 0.5–2`)
    }
    // These two arrive as arbitrary JSON from the page, and the wire contract is
    // plain JSON, so nothing upstream has coerced them to booleans.
    if (spatialSplit !== undefined && typeof spatialSplit !== 'boolean') {
      throw new Error(`ui-experience: spatialSplit must be a boolean, got ${typeof spatialSplit}`)
    }
    if (quantize !== undefined && typeof quantize !== 'boolean') {
      throw new Error(`ui-experience: quantize must be a boolean, got ${typeof quantize}`)
    }
    if (scroll !== undefined && typeof scroll !== 'boolean') {
      throw new Error(`ui-experience: scroll must be a boolean, got ${typeof scroll}`)
    }
    if (stream !== undefined && typeof stream !== 'boolean') {
      throw new Error(`ui-experience: stream must be a boolean, got ${typeof stream}`)
    }
    if (followScroll !== undefined && typeof followScroll !== 'boolean') {
      throw new Error(`ui-experience: followScroll must be a boolean, got ${typeof followScroll}`)
    }
    for (const [name, value] of [
      ['streamRevealMinMs', streamRevealMinMs], ['streamRevealMaxMs', streamRevealMaxMs],
      ['streamEnterMs', streamEnterMs], ['streamRollMs', streamRollMs],
    ] as const) {
      if (value === undefined) continue
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`ui-experience: ${name} must be a non-negative number, got ${String(value)}`)
      }
    }
    for (const [name, value] of [
      ['streamRevealMinMs', streamRevealMinMs], ['streamRevealMaxMs', streamRevealMaxMs],
      ['streamEnterMs', streamEnterMs], ['streamRollMs', streamRollMs],
    ] as const) {
      if (value === undefined) continue
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`ui-experience: ${name} must be a non-negative number, got ${String(value)}`)
      }
    }
    await this.persist(current => ({
      ...current,
      ...(mode === undefined ? {} : { motion: mode }),
      ...(reduced === undefined ? {} : { motionReduced: reduced }),
      ...(scale === undefined ? {} : { motionDurationScale: scale }),
      ...(spatialSplit === undefined ? {} : { motionSpatialSplit: spatialSplit }),
      ...(quantize === undefined ? {} : { motionQuantize: quantize }),
      ...(scroll === undefined ? {} : { motionScroll: scroll }),
      ...(stream === undefined ? {} : { motionStream: stream }),
      ...(followScroll === undefined ? {} : { motionFollowScroll: followScroll }),
      ...(streamRevealMinMs === undefined ? {} : { streamRevealMinMs }),
      ...(streamRevealMaxMs === undefined ? {} : { streamRevealMaxMs }),
      ...(streamEnterMs === undefined ? {} : { streamEnterMs }),
      ...(streamRollMs === undefined ? {} : { streamRollMs }),
    }))
    const applied = effectiveMotion(this.config)
    logLine(`setMotion: mode=${applied.mode} durationScale=${String(applied.durationScale)}`
      + ` spatialSplit=${String(applied.spatialSplit)} quantize=${String(applied.quantize)}`
      + ` reduced=${applied.reduced} scroll=${String(applied.scroll)} stream=${String(applied.stream)}`)
    return applied
  }

  /**
   * Write one configuration change through the config editor, logging the
   * failure before it reaches the caller.
   * @param change - derives the next raw config from the current one.
   */
  private async persist(change: (current: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
    const { entry, editor } = this
    if (entry === undefined || editor === undefined) {
      throw new Error('ui-experience: the plugin entry or the config editor is unavailable; configuration cannot be saved in this profile')
    }
    try {
      await editor.edit(entry, change)
    } catch (error) {
      logLine(`config edit FAILED: ${(error as Error).stack ?? (error as Error).message}`)
      throw error
    }
  }
}

Object.defineProperty(UiExperienceService.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      Object.freeze({ method: 'poll', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'setActive', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'setPaths', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'setMotion', invocation: Object.freeze({ kind: 'direct' }) }),
    ]),
  }),
})

export const inject = ['configEditor']

/**
 * Plugin apply: register the Remote service, then repaint the pre-plugin canvas
 * with the palette while the switch is on.
 * @param ctx - owning Cordis context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: HostContext, config: Config): void {
  logLine(`apply: active=${String(config.active.get())} borderWidth=${config.borderWidth.get()}`
    + ` colorsPath=${config.colorsPath.get()} tokensPath=${config.tokensPath.get()}`
    + ` motion=${config.motion.get()} durationScale=${String(config.motionDurationScale.get())}`)
  // Register the service directly instead of ctx.plugin(class) so constructor
  // failures surface immediately instead of disappearing into a parked fiber.
  try {
    new UiExperienceService(ctx, config, ctx.fiber.entry, ctx.configEditor)
  } catch (error) {
    console.error(`[ui-experience] failed to register host service: ${(error as Error).message}`)
    throw error
  }
  ctx.on('webserver/index-inject', (table) => {
    if (!config.active.get()) return
    const read = readPaletteSync(config)
    if (!read.ok) {
      logLine(`boot paint skipped: ${read.message}`)
      return
    }
    table.push(...bootRows(read.palette))
  })
}
