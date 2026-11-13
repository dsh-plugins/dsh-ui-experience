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
import z from '@deepseek-ai/schemastery'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  BOOT_ATTRIBUTE, DEFAULT_COLORS_PATH, DEFAULT_TOKENS_PATH, REMOTE_SERVICE,
  type PalettePaths, type PollArgs, type PollResult, type SetActiveArgs, type SetActiveResult,
  type SetPathsArgs, type SetPathsResult, type ThemeTokenModes, type ThemeTokenTable,
} from './shared.ts'

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

/** Plugin configuration. Every field is volatile, so edits apply in place. */
export const Config = z.object({
  active: z.boolean().default(false).volatile(),
  borderWidth: z.string().pattern(BORDER_WIDTH).default('0.5px').volatile(),
  colorsPath: z.string().pattern(PATH_PATTERN).default(DEFAULT_COLORS_PATH).volatile(),
  tokensPath: z.string().pattern(PATH_PATTERN).default(DEFAULT_TOKENS_PATH).volatile(),
})

/** Resolved configuration: each field is a live getter. */
type Config = {
  active: VolatileValue<boolean>
  borderWidth: VolatileValue<string>
  colorsPath: VolatileValue<string>
  tokensPath: VolatileValue<string>
}

/** Material You color roles the mapping consumes. */
const REQUIRED_COLOR_KEYS = [
  'surface_container_lowest', 'surface_container_low', 'surface_container',
  'surface_container_high', 'surface_container_highest', 'surface_bright',
  'on_surface', 'on_surface_variant', 'outline', 'outline_variant',
  'primary', 'primary_container', 'on_primary',
  'secondary', 'secondary_container',
  'tertiary', 'tertiary_container',
  'error', 'error_container',
  'inverse_surface', 'inverse_on_surface',
  'scrim', 'shadow',
] as const

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

/** One matugen colors table, keyed by Material color role. */
type MatugenColors = Record<string, string>

/**
 * DSW token mapping from one Material You scheme. The palette matugen emits
 * is a dark scheme, so the theme registers with colorScheme 'dark'; the
 * override layer still requires both modes, hence the same values on light.
 * @param colors - matugen colors table.
 * @returns DSW token overrides for one mode.
 */
function mapColors(colors: MatugenColors): ThemeTokenTable {
  // Material 的 surface 阶梯，由暗到亮。侧栏取最暗一级，主面板从第二级起，
  // 其余表面按原有相对层级整体上移一级：主面板比原先更亮、侧栏更暗，各层
  // 表面的相对明暗顺序不变。overlay 原本就居顶，阶梯没有更高的档位可用，
  // 因此在最亮一级上加白提亮，保持它高于其余浮层。
  const surface: readonly [string, string, string, string, string, string] = [
    colors.surface_container_lowest!,
    colors.surface_container_low!,
    colors.surface_container!,
    colors.surface_container_high!,
    colors.surface_container_highest!,
    colors.surface_bright!,
  ]
  return {
    // ── surfaces ──────────────────────────────────────────────
    '--dsw-alias-bg-base': surface[1],
    '--dsw-alias-bg-layer-1': surface[2],
    '--dsw-alias-bg-layer-2': surface[3],
    '--dsw-alias-bg-layer-3': surface[4],
    '--dsw-alias-bg-layer-4': surface[5],
    '--dsw-alias-bg-overlay': `color-mix(in srgb, ${surface[5]}, white 8%)`,
    // 内置主题的遮罩是半透明黑，直接取 scrim 会得到不透明纯黑，盖住下层界面。
    '--dsw-alias-bg-mask-1': `color-mix(in srgb, ${colors.scrim!}, transparent 50%)`,
    '--dsw-alias-bg-module-platform': surface[4],
    '--dsw-alias-bg-skeleton': surface[4],
    // ── borders — uniform outline_variant to avoid visual fragmentation ──
    '--dsw-alias-border-l1': colors.outline_variant!,
    '--dsw-alias-border-l2': colors.outline_variant!,
    '--dsw-alias-border-l2-darkmode-thin': colors.outline_variant!,
    '--dsw-alias-border-l3': colors.outline_variant!,
    '--dsw-alias-border-l4': colors.outline_variant!,
    // ── brand & labels ────────────────────────────────────────
    '--dsw-alias-brand-primary': colors.primary!,
    '--dsw-alias-brand-primary-new-colorprimary-new-color': colors.primary!,
    '--dsw-alias-label-primary': colors.on_surface!,
    '--dsw-alias-label-secondary': colors.on_surface_variant!,
    '--dsw-alias-label-tertiary': colors.on_surface_variant!,
    '--dsw-alias-label-caption': colors.on_surface_variant!,
    '--dsw-alias-label-dimmed': colors.outline!,
    '--dsw-alias-label-error': colors.error!,
    '--dsw-alias-label-primary-foreground': colors.on_primary!,
    '--dsw-alias-label-shimmer': colors.on_surface_variant!,
    '--dsw-alias-link': colors.primary!,
    // ── interactive ───────────────────────────────────────────
    '--dsw-alias-interactive-bg-hover': surface[4],
    '--dsw-alias-interactive-bg-active': surface[5],
    '--dsw-alias-interactive-bg-hover-danger': colors.error_container!,
    // ── buttons ───────────────────────────────────────────────
    '--dsw-alias-button-primary-fill': colors.primary!,
    '--dsw-alias-button-primary-hover': colors.primary!,
    '--dsw-alias-button-info-fill': colors.primary!,
    '--dsw-alias-button-ghost-active-fill': surface[4],
    '--dsw-alias-button-ghost-active-border': colors.outline!,
    '--dsw-alias-button-tool-bar-fill': surface[4],
    '--dsw-alias-button-tool-bar-hover': surface[5],
    '--dsw-alias-label-on-color': colors.on_primary!,
    // ── states ────────────────────────────────────────────────
    '--dsw-alias-state-error-primary': colors.error!,
    '--dsw-alias-state-idle-primary': colors.outline!,
    '--dsw-alias-state-success-primary': colors.tertiary!,
    '--dsw-alias-state-success-tertiary': colors.tertiary_container!,
    '--dsw-alias-state-warn-primary': colors.secondary!,
    '--dsw-alias-state-warn-label': colors.secondary!,
    '--dsw-alias-state-warn-tertiary': colors.secondary_container!,
    '--dsw-alias-state-business-primary': colors.primary!,
    // ── switch ────────────────────────────────────────────────
    // switch-thumb 是关闭态滑块色，语义为中性前景，内置主题暗色取
    // neutral-bluish-400（纯灰）、浅色取近白。映射成 primary 会让关闭态带上
    // 强调色，映射成 on_surface_variant 又会把前景色渗进整体观感；这里不做
    // 覆盖，保持原生纯灰，开关只在开启态轨道显示强调色。
    // ── menu & overlay ────────────────────────────────────────
    '--dsw-alias-menu-icon': colors.on_surface_variant!,
    '--dsw-alias-menu-group-header-fill': surface[4],
    '--dsw-alias-hovercard-bg': surface[4],
    '--dsw-alias-hovercard-label-primary': colors.on_surface!,
    // 官方契约里 tooltip 与 toast 始终是深色气泡配浅色文字，key 块是气泡色
    // 混 18% 白。Material 的 inverse_* 在深色调色板下方向相反（浅底深字），
    // 会让继承 label 色的键位提示变成深底深字，故这里改用容器面与前景色。
    '--dsw-alias-tooltip-bg': surface[4],
    '--dsw-alias-tooltip-label': colors.on_surface!,
    '--dsw-alias-tooltip-key-bg': `color-mix(in srgb, ${surface[4]}, white 18%)`,
    '--dsw-alias-toast-bg': surface[4],
    '--dsw-alias-toast-label': colors.on_surface!,
    '--dsw-alias-toast-action': colors.primary!,
    // ── scrollbar ─────────────────────────────────────────────
    '--dsw-alias-scrollbar-bg-l2': surface[2],
    '--dsw-alias-scrollbar-hover-l2': surface[4],
    // ── markdown & code ───────────────────────────────────────
    '--dsw-alias-markdown-code-block': surface[2],
    '--dsw-alias-markdown-code-block-banner': surface[3],
    '--dsw-alias-markdown-inline-code': surface[4],
    '--dsw-alias-markdown-tag': surface[4],
    // ── JSON tree ─────────────────────────────────────────────
    '--dsw-alias-json-tree-hover': surface[4],
    '--dsw-alias-json-tree-icon': colors.on_surface_variant!,
    '--dsw-alias-json-tree-keyword': colors.primary!,
    '--dsw-alias-json-tree-number': colors.tertiary!,
    '--dsw-alias-json-tree-property': colors.on_surface!,
    '--dsw-alias-json-tree-punctuation': colors.on_surface_variant!,
    '--dsw-alias-json-tree-string': colors.secondary!,
    // ── diff ──────────────────────────────────────────────────
    '--dsw-alias-code-diff-added': surface[4],
    '--dsw-alias-code-diff-deleted': surface[4],
    '--dsw-alias-file-diff-added-bg': surface[2],
    '--dsw-alias-file-diff-added-marker': colors.tertiary!,
    '--dsw-alias-file-diff-deleted-bg': surface[2],
    '--dsw-alias-file-diff-deleted-marker': colors.error!,
    // ── app-specific ──────────────────────────────────────────
    '--dsw-specific-sidebar-fill': surface[0],
    '--dsw-specific-input-major': surface[2],
    '--dsw-specific-bubble': surface[2],
    '--dsw-specific-menu': surface[3],
    '--dsw-menu-surface-fill': surface[3],
    '--dsw-focus-ring-color': colors.primary!,
    // ── plugin-side surfaces & fills ──────────────────────────
    '--dsw-alias-bg-document-preview': surface[2],
    '--dsw-alias-bg-l1': surface[2],
    '--dsw-alias-bg-mask-drop': `color-mix(in srgb, ${colors.scrim!}, transparent 30%)`,
    '--dsw-alias-card-fill': surface[2],
    '--dsw-alias-card-fill-hover': surface[3],
    '--dsw-alias-card-tile-fill': surface[2],
    '--dsw-alias-fill-l1': surface[2],
    '--dsw-alias-fill-l2': surface[4],
    '--dsw-alias-fill-tsp-secondary': surface[3],
    '--dsw-alias-settings-card-fill': surface[2],
    '--dsw-alias-settings-card-stroke': colors.outline_variant!,
    '--dsw-alias-illustration-background': surface[1],
    '--dsw-alias-illustration-backing': surface[2],
    '--dsw-alias-illustration-detail': surface[3],
    '--dsw-alias-illustration-inset': surface[0],
    '--dsw-alias-illustration-shadow': colors.shadow!,
    '--dsw-alias-illustration-surface': surface[4],
    // ── plugin-side borders & separators ──────────────────────
    '--dsw-alias-border-inverted': colors.inverse_surface!,
    '--dsw-alias-border-selected': colors.primary!,
    '--dsw-alias-separator-primary': colors.outline_variant!,
    // ── plugin-side buttons ───────────────────────────────────
    '--dsw-alias-button-contrast-fill': colors.inverse_surface!,
    '--dsw-alias-button-elevated-fill': surface[4],
    '--dsw-alias-button-floating-fill': surface[4],
    '--dsw-alias-button-floating-hover': surface[5],
    '--dsw-alias-button-info-hover': colors.primary_container!,
    // ── plugin-side labels ────────────────────────────────────
    '--dsw-alias-label-deep-diving': colors.primary!,
    '--dsw-alias-label-deep-diving-shimmer': colors.secondary!,
    '--dsw-alias-label-primary-bluish': colors.on_surface!,
    '--dsw-alias-label-primary-dimmed': colors.on_surface_variant!,
    '--dsw-alias-label-primary-inverted': colors.inverse_on_surface!,
    '--dsw-alias-label-quaternary': colors.outline!,
    '--dsw-alias-hovercard-label-secondary': colors.on_surface_variant!,
    '--dsw-alias-hovercard-label-tertiary': colors.on_surface_variant!,
    // ── plugin-side interactive & states ──────────────────────
    '--dsw-alias-interactive-bg-hover-accent': colors.primary_container!,
    '--dsw-alias-interactive-bg-hover-solid': surface[5],
    '--dsw-alias-state-business-tertiary': colors.primary_container!,
    '--dsw-alias-state-error-secondary': colors.error_container!,
    '--dsw-alias-state-success-secondary': colors.tertiary_container!,
    '--dsw-alias-state-warn-secondary': colors.secondary_container!,
    '--dsw-alias-trajectory-accent': colors.primary!,
    // ── charts, citations, onboarding, turn triggers ──────────
    '--dsw-alias-chart-messages': colors.primary!,
    '--dsw-alias-chart-system': colors.secondary!,
    '--dsw-alias-chart-tools': colors.tertiary!,
    '--dsw-alias-markdown-citation': surface[4],
    '--dsw-alias-onboarding-accent': colors.primary!,
    '--dsw-alias-onboarding-card-fill': surface[2],
    '--dsw-alias-onboarding-checkbox-border': colors.outline!,
    '--dsw-alias-onboarding-secondary-fill': surface[4],
    '--dsw-alias-turn-trigger-bg': surface[4],
    '--dsw-alias-turn-trigger-bg-hover': surface[5],
    // ── plugin-side scrollbars ────────────────────────────────
    '--dsw-alias-scrollbar-bg-l1': surface[0],
    '--dsw-alias-scrollbar-hover-l1': surface[2],
    // ── diff gutters ──────────────────────────────────────────
    '--dsw-alias-file-diff-added-gutter': colors.tertiary_container!,
    '--dsw-alias-file-diff-deleted-gutter': colors.error_container!,
    // ── sidebar & misc specifics ──────────────────────────────
    // 侧栏玻璃按钮是侧栏内层，取比侧栏底色高一级，避免与底色重合。tint 与
    // wash 只在 macOS 上作为透明渐变叠加在侧栏之上，这里保持与底色同值。
    '--dsw-specific-sidebar-glass-fill': surface[1],
    '--dsw-specific-sidebar-glass-hover': surface[2],
    '--dsw-specific-sidebar-glass-collapsed-fill': surface[1],
    '--dsw-specific-sidebar-glass-collapsed-hover': surface[2],
    '--dsw-specific-sidebar-nav-item-active': surface[4],
    // 该 token 也作为「推荐」徽标等元素的文字底色，文字色是 button-info-fill
    // （映射为 primary），因此这里必须用容器色保证对比。
    '--dsw-specific-sidebar-nav-item-active-accent': colors.primary_container!,
    '--dsw-specific-sidebar-right-flash': surface[3],
    '--dsw-specific-sidebar-tint': surface[0],
    '--dsw-specific-sidebar-wash-bottom': surface[0],
    '--dsw-specific-sidebar-wash-bottom-clear': surface[0],
    '--dsw-specific-sidebar-wash-top': surface[0],
    '--dsw-specific-sidebar-wash-top-clear': surface[0],
    '--dsw-specific-file-upload-track': surface[4],
    '--dsw-specific-guide-hero': colors.primary!,
    '--dsw-specific-selector': surface[4],
  }
}

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
  for (const key of REQUIRED_COLOR_KEYS) {
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
 * Record how much of the palette the dedicated token file actually covers. A
 * sparse file is legitimate, but it silently leaves most tokens on the mapped
 * base (or, with no colors file, on the built-in palette), which looks like the
 * plugin doing nothing.
 * @param composed - the composed per-mode token tables.
 * @param tokens - the parsed token document, when present.
 * @param mapped - the parsed matugen mapping, when present.
 */
function auditCoverage(composed: ThemeTokenModes, tokens: ThemeTokenModes | undefined, mapped: ThemeTokenModes | undefined): void {
  if (tokens === undefined) return
  const provided = Object.keys(tokens.dark).length
  const total = Object.keys(composed.dark).length
  if (mapped === undefined) {
    logLine(`tokensPath has ${provided} tokens and no colorsPath base is present;`
      + ' every other token keeps the built-in palette value')
    return
  }
  logLine(`palette composed from colorsPath mapping (${Object.keys(mapped.dark).length} tokens)`
    + ` + tokensPath overrides (${provided} tokens) = ${total} tokens`)
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
    auditCoverage(modes, tokens.modes, mapped.modes)
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
    auditCoverage(modes, tokens.modes, mapped.modes)
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
   * known version, and always report the live switch, border width, and paths.
   * @param args - the caller's last seen version.
   * @returns the poll payload.
   */
  async poll(args?: PollArgs): Promise<PollResult> {
    const read = await readPalette(this.config)
    const active = this.config.active.get()
    const borderWidth = this.config.borderWidth.get()
    if (!read.ok) {
      return { status: read.status, message: read.message, active, borderWidth, paths: read.paths }
    }
    const { palette, paths } = read
    if (args?.known === palette.version) {
      return { status: 'ok', changed: false, version: palette.version, source: palette.source, active, borderWidth, paths }
    }
    return {
      status: 'ok', changed: true, version: palette.version, tokens: palette.tokens,
      source: palette.source, active, borderWidth, paths,
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
    + ` colorsPath=${config.colorsPath.get()} tokensPath=${config.tokensPath.get()}`)
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
