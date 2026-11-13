/**
 * Client half of the UI experience bundle. Renders the Matugen palette switch
 * and the palette-path editor as one Settings → General row, overlays the system
 * matugen palette on whichever built-in theme is active, and keeps both updated
 * as matugen regenerates colors or the configuration changes.
 *
 * The native theme preference is never touched: the palette is an override
 * layer stacked on top of it, and the row's controls are the bundle's own — no
 * Harness Client package is imported as a module.
 */

import {
  BOOT_ATTRIBUTE, DEFAULT_COLORS_PATH, DEFAULT_TOKENS_PATH, REMOTE_SERVICE,
  type PalettePaths, type PollArgs, type PollResult, type SetActiveArgs, type SetActiveResult,
  type SetPathsArgs, type SetPathsResult, type ThemeTokenModes,
} from './shared.ts'
import { ROW_CSS } from './styles.ts'

/** Minimal React face the bundle uses (the real React arrives from the loader). */
interface ReactLike {
  createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown
  useState<T>(initial: T | (() => T)): [T, (next: T) => void]
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
}

/** The zod face the wire codecs need (zod is a shell seed word). */
interface ZodLike {
  object(shape: Record<string, unknown>): unknown
  strictObject(shape: Record<string, unknown>): unknown
  string(): { optional(): unknown }
  boolean(): { optional(): unknown }
}

/** The loader-supplied synchronous module-table require (platform seeds). */
type BundleRequire = ((name: 'react') => ReactLike) & ((name: 'zod') => ZodLike)

declare const window: {
  __ModuleLoader__: {
    load(registration: {
      id: string
      factory: (require: BundleRequire) => unknown
    }): void
  }
}

/** Host half's Remote namespace, typed against the shared protocol. */
interface UiExperienceRemoteNamespace {
  poll(args: PollArgs): Promise<PollResult>
  setActive(args: SetActiveArgs): Promise<SetActiveResult>
  setPaths(args: SetPathsArgs): Promise<SetPathsResult>
}

/** Theme registry subset this bundle consumes. */
interface ThemeLike {
  overrideTokens(source: string, tokens: Record<string, { light: string; dark: string }>): () => void
}

/** The gateway's contribution mount face (subset of ClientRemote). */
interface ClientRemoteLike {
  $mount(contribution: { package: string; descriptors: readonly RemoteDescriptor[] }): Promise<() => Promise<void>>
}

/** Restricted Cordis context face of a dynamic client bundle. */
interface ClientContext {
  get(name: string): unknown
  effect(setup: () => (() => void) | void, label?: string): () => void
  locale: {
    register(ns: string, dicts: Record<string, Record<string, string>>): () => void
    bind(ns: string): (key: string) => string
  }
  timer: { interval(callback: () => void, delay: number): () => void }
  slots: {
    inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void
    register(options: { name: string; id: string; order?: number; locale?: string }, component: unknown): () => void
  }
  remote: ClientRemoteLike
}

declare const console: { error(...values: unknown[]): void }

declare const document: {
  head: { appendChild(node: unknown): unknown }
  createElement(tag: 'style'): { textContent: string; remove(): void }
  documentElement: {
    setAttribute(name: string, value: string): void
    removeAttribute(name: string): void
  }
}

const SOURCE = '@dsh-plugin/dsh-ui-experience'
const POLL_MS = 2000
/** Heartbeat multiplier while the switch is off: 15 × 2 s = 30 s. */
const IDLE_TICKS = 15
/** Border width accepted from configuration, duplicated from the Host schema. */
const BORDER_WIDTH = /^(?:0|[0-9]+(?:\.[0-9]+)?(?:px|rem|em))$/

/** Wire codec metadata carried on every Remote value. */
interface RemoteCodec {
  mode: 'strict'
  typeSymbol: string
  create: () => unknown
}

/** One Remote method descriptor for the client gateway's contribution mount. */
interface RemoteDescriptor {
  id: string
  service: string
  namespace: string
  method: string
  invocation: { kind: 'direct' }
  parameters: readonly [{
    name: string
    wire: string
    source: 'json'
    codec: RemoteCodec
    strictCodec: RemoteCodec
  }]
  result: RemoteCodec
}

/** Everything the settings row renders from. */
interface ViewState {
  active: boolean
  borderWidth: string
  paths: PalettePaths
  problem: string
  notice: string
  saving: boolean
}

/**
 * Remote contribution for the host half's service. Static client bundles
 * cannot pull the generated typert.remote-client module through the shell's
 * module table, so the InvocationDescriptor rows are authored by hand in the
 * same shape. Each strict codec carries a lazy zod factory: mount validation
 * only checks `create` is a function, and the plain JSON request/response path
 * never instantiates a parser.
 * @param zod - the shell's zod seed.
 * @returns the contribution to mount on the gateway.
 */
function uiExperienceRemoteContribution(zod: ZodLike): { package: string; descriptors: readonly RemoteDescriptor[] } {
  const codec = (name: string, schema: () => unknown): RemoteCodec => ({
    mode: 'strict',
    typeSymbol: `${SOURCE}/shared#${name}`,
    create: schema,
  })
  const descriptor = (method: 'poll' | 'setActive' | 'setPaths', shape: () => Record<string, unknown>, typeName: string): RemoteDescriptor => ({
    id: `${SOURCE}#${REMOTE_SERVICE}/${method}`,
    service: REMOTE_SERVICE,
    namespace: REMOTE_SERVICE,
    method,
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'args',
      wire: 'args',
      source: 'json',
      codec: codec(typeName, () => zod.object(shape())),
      strictCodec: codec(typeName, () => zod.strictObject(shape())),
    }],
    result: codec(`${method}Result`, () => zod.object({})),
  })
  return {
    package: SOURCE,
    descriptors: [
      descriptor('poll', () => ({ known: zod.string().optional() }), 'PollArgs'),
      descriptor('setActive', () => ({ active: zod.boolean().optional() }), 'SetActiveArgs'),
      descriptor('setPaths', () => ({ colorsPath: zod.string().optional(), tokensPath: zod.string().optional() }), 'SetPathsArgs'),
    ],
  }
}

const DICTS: Record<string, Record<string, string>> = {
  zh: {
    'palette.title': 'Matugen 配色跟随',
    'palette.description': '将系统 matugen 生成的 Material You 配色叠加在当前主题上，配色文件重新生成后自动跟随',
    'palette.persist-failed': '开关状态保存失败',
    'palette.save-failed': '路径保存失败',
    'palette.saved': '已保存',
    'palette.paths': '配色文件路径',
    'palette.colors-path': 'matugen 颜色文件',
    'palette.tokens-path': 'DSH 令牌文件（存在时优先）',
    'palette.save': '保存',
    'palette.reset': '恢复默认',
    'palette.paths-hint': '支持以 ~ 开头的路径，或绝对路径。令牌文件存在时优先使用，否则读取颜色文件并映射。',
  },
  en: {
    'palette.title': 'Matugen palette sync',
    'palette.description': 'Overlay the system matugen Material You palette on the current theme; follows the file when matugen regenerates it',
    'palette.persist-failed': 'Failed to save the switch state',
    'palette.save-failed': 'Failed to save the paths',
    'palette.saved': 'Saved',
    'palette.paths': 'Palette file paths',
    'palette.colors-path': 'matugen colors file',
    'palette.tokens-path': 'DSH token file (preferred when present)',
    'palette.save': 'Save',
    'palette.reset': 'Restore defaults',
    'palette.paths-hint': 'Paths may start with ~, or be absolute. The token file wins when it exists; otherwise the colors file is read and mapped.',
  },
}

function registerClient(): void {
  window.__ModuleLoader__.load({
    id: SOURCE,
    factory(require) {
      const React = require('react')
      const zod = require('zod')
      const h = React.createElement

      /**
       * Bundle body, mounted inside the injected Remote scope so every
       * registration and listener shares the namespace's lifetime.
       * @param registry - the theme registry the override layer is stacked on.
       * @param ctx - the bundle's restricted client context.
       * @param gateway - the currently running instance of our own service.
       */
      function run(registry: ThemeLike, ctx: ClientContext, gateway: UiExperienceRemoteNamespace): void {
        const t = ctx.locale.bind('ui-experience')
        ctx.effect(() => ctx.locale.register('ui-experience', DICTS), 'ui-experience: dictionaries')
        ctx.effect(() => {
          const sheet = document.createElement('style')
          sheet.textContent = ROW_CSS
          document.head.appendChild(sheet)
          return () => { sheet.remove() }
        }, 'ui-experience: row styles')

        /** Set once the bundle unmounts; in-flight work stops repainting after it. */
        let disposed = false
        /** Palette version the last applied override was built from. */
        let known: string | undefined
        /** Whether the startup poll adopted the persisted switch state. */
        let bootstrapped = false
        /** True while a configuration write is in flight, so polls do not fight it. */
        let writing = false
        /** Guards against overlapping polls. */
        let inflight = false
        /** Slow-heartbeat counter used while the switch is off. */
        let idleTick = 0
        /** Last reported RPC failure, so a repeat logs once instead of every tick. */
        let lastRpcProblem = ''
        /** Last reported palette problem, for the same reason. */
        let lastPaletteProblem = ''
        /** Border width currently painted. */
        let paintedWidth = ''
        let disposeOverride: (() => void) | undefined
        let borderSheet: { textContent: string; remove(): void } | undefined

        let view: ViewState = {
          active: false,
          borderWidth: '0.5px',
          paths: { colors: DEFAULT_COLORS_PATH, tokens: DEFAULT_TOKENS_PATH },
          problem: '',
          notice: '',
          saving: false,
        }
        const listeners = new Set<() => void>()
        /**
         * Replace the rendered state and notify every mounted row.
         * @param patch - fields to change.
         */
        const publish = (patch: Partial<ViewState>): void => {
          view = { ...view, ...patch }
          for (const listener of listeners) listener()
        }

        /**
         * Convert host-side { light, dark } tables into the per-token mode pairs
         * the override layer expects.
         * @param modes - validated token modes.
         * @returns token → mode pair.
         */
        const toOverrides = (modes: ThemeTokenModes): Record<string, { light: string; dark: string }> => {
          const out: Record<string, { light: string; dark: string }> = {}
          for (const [token, dark] of Object.entries(modes.dark)) {
            const light = modes.light[token] ?? dark
            if (typeof light === 'string' && light !== '') out[token] = { light, dark }
          }
          return out
        }

        /** Drop the palette override layer, if one is mounted. */
        const clearOverride = (): void => {
          disposeOverride?.()
          disposeOverride = undefined
        }

        /**
         * Stack the matugen palette over whatever theme is active. The layer is
         * independent of the theme preference, so the native light/dark/system
         * choice keeps working underneath it.
         * @param modes - validated token modes.
         */
        const applyPalette = (modes: ThemeTokenModes): void => {
          if (disposed) return
          clearOverride()
          try {
            disposeOverride = registry.overrideTokens(SOURCE, toOverrides(modes))
          } catch (error) {
            const message = `theme override rejected: ${(error as Error).message}`
            console.error(`ui-experience: ${message}`)
            publish({ problem: message })
          }
        }

        /**
         * Paint the border-width sheet, replacing the previous one. An invalid
         * width is reported rather than written into a stylesheet.
         * @param width - configured border width.
         */
        const applyBorder = (width: string): void => {
          if (disposed) return
          if (!BORDER_WIDTH.test(width)) {
            const message = `borderWidth ${JSON.stringify(width)} is not a CSS length; borders left untouched`
            console.error(`ui-experience: ${message}`)
            publish({ problem: message })
            return
          }
          if (width === paintedWidth) return
          paintedWidth = width
          borderSheet?.remove()
          borderSheet = document.createElement('style')
          // Elements may opt out with data-dsh-uix-keep-border; thick decorative
          // borders such as markdown quote rules are otherwise narrowed too.
          borderSheet.textContent = `body :where(*:not([data-dsh-uix-keep-border])){border-width:${width} !important}`
          document.head.appendChild(borderSheet)
        }

        /** Remove the border-width sheet. */
        const clearBorder = (): void => {
          borderSheet?.remove()
          borderSheet = undefined
          paintedWidth = ''
        }

        /**
         * Toggle the boot-paint attribute the host's injected CSS is scoped by.
         * @param on - whether the palette is active.
         */
        const setBootAttribute = (on: boolean): void => {
          if (on) document.documentElement.setAttribute(BOOT_ATTRIBUTE, '')
          else document.documentElement.removeAttribute(BOOT_ATTRIBUTE)
        }

        /** Undo every page-level change this bundle made. */
        const teardown = (): void => {
          clearOverride()
          clearBorder()
          setBootAttribute(false)
        }

        /**
         * Unwrap the RPC envelope `{ ok, value }` the gateway returns; a failed
         * call carries `{ ok: false, error }`, surfaced through the caller.
         * @param raw - the envelope.
         * @returns the payload.
         */
        const unwrap = <T,>(raw: unknown): T => {
          const envelope = raw as { ok: boolean; value?: T; error?: { message?: string } }
          if (envelope.ok === false) throw new Error(envelope.error?.message ?? 'remote call failed')
          return envelope.value as T
        }

        /**
         * Fold one poll payload into the rendered state and the page.
         * @param answer - the poll payload.
         */
        const adopt = (answer: PollResult): void => {
          if (answer.paths.colors !== view.paths.colors
            || answer.paths.tokens !== view.paths.tokens
            || answer.borderWidth !== view.borderWidth) {
            publish({ paths: answer.paths, borderWidth: answer.borderWidth })
          }
          if (!bootstrapped) {
            bootstrapped = true
            setBootAttribute(answer.active)
            publish({ active: answer.active })
          } else if (!writing && view.active !== answer.active) {
            // The switch changed elsewhere (another tab, or a configuration
            // edit): follow it, in both directions.
            publish({ active: answer.active })
            if (answer.active) {
              setBootAttribute(true)
              if (answer.status === 'ok' && answer.tokens !== undefined) applyPalette(answer.tokens)
              applyBorder(answer.borderWidth)
            } else {
              teardown()
            }
          }
          if (answer.status !== 'ok') {
            if (answer.message !== lastPaletteProblem) {
              lastPaletteProblem = answer.message
              console.error(`ui-experience: palette unavailable: ${answer.message}`)
            }
            publish({ problem: answer.message })
            return
          }
          if (lastPaletteProblem !== '') {
            lastPaletteProblem = ''
            publish({ problem: '' })
          }
          if (answer.changed) {
            known = answer.version
            if (view.active && answer.tokens !== undefined) applyPalette(answer.tokens)
          }
          if (view.active) applyBorder(answer.borderWidth)
        }

        /** Poll the host half, throttled to a heartbeat while the switch is off. */
        const poll = async (): Promise<void> => {
          if (disposed || inflight) return
          if (bootstrapped && !view.active) {
            idleTick = (idleTick + 1) % IDLE_TICKS
            if (idleTick !== 0) return
          } else {
            idleTick = 0
          }
          inflight = true
          let answer: PollResult
          try {
            answer = unwrap<PollResult>(await gateway.poll({ known }))
          } catch (error) {
            const message = (error as Error).message
            if (message !== lastRpcProblem) {
              lastRpcProblem = message
              console.error(`ui-experience: poll RPC failed: ${message}`)
            }
            return
          } finally {
            inflight = false
          }
          if (disposed) return
          lastRpcProblem = ''
          adopt(answer)
        }

        /**
         * Persist the switch, then apply it. Persisting first keeps the row, the
         * page, and the stored configuration from disagreeing when a write fails.
         * @param next - the requested state.
         */
        const setActive = async (next: boolean): Promise<void> => {
          if (disposed || writing) return
          writing = true
          publish({ saving: true, problem: '', notice: '' })
          try {
            if (!next) {
              await gateway.setActive({ active: false })
              if (disposed) return
              publish({ active: false })
              teardown()
              return
            }
            // A fresh poll carries the tokens regardless of `known`.
            const answer = unwrap<PollResult>(await gateway.poll({}))
            if (disposed) return
            if (answer.status !== 'ok') {
              publish({ problem: answer.message })
              return
            }
            const tokens = answer.tokens
            if (tokens === undefined) throw new Error('poll returned no tokens for an activation request')
            await gateway.setActive({ active: true })
            if (disposed) return
            known = answer.version
            bootstrapped = true
            setBootAttribute(true)
            publish({ active: true, paths: answer.paths, notice: t('palette.saved') })
            applyPalette(tokens)
            applyBorder(answer.borderWidth)
          } catch (error) {
            const message = (error as Error).message
            console.error(`ui-experience: failed to save the switch state: ${message}`)
            publish({ problem: `${t('palette.persist-failed')}: ${message}` })
          } finally {
            writing = false
            publish({ saving: false })
          }
        }

        /**
         * Persist both palette paths, then re-read the palette with them.
         * @param colors - the colors file path.
         * @param tokens - the token file path.
         */
        const savePaths = async (colors: string, tokens: string): Promise<void> => {
          if (disposed || writing) return
          writing = true
          publish({ saving: true, problem: '', notice: '' })
          try {
            const saved = unwrap<SetPathsResult>(await gateway.setPaths({ colorsPath: colors, tokensPath: tokens }))
            if (disposed) return
            const probe = unwrap<PollResult>(await gateway.poll({}))
            if (disposed) return
            known = probe.status === 'ok' ? probe.version : undefined
            publish({
              paths: saved.paths,
              notice: probe.status === 'ok' ? t('palette.saved') : '',
              problem: probe.status === 'ok' ? '' : probe.message,
            })
            if (probe.status === 'ok' && view.active && probe.tokens !== undefined) applyPalette(probe.tokens)
          } catch (error) {
            const message = (error as Error).message
            console.error(`ui-experience: failed to save the palette paths: ${message}`)
            publish({ problem: `${t('palette.save-failed')}: ${message}` })
          } finally {
            writing = false
            publish({ saving: false })
          }
        }

        /**
         * Switch row: its own setting cell, leaving the built-in rows untouched.
         * The slot supplies `t` once the row is registered with a locale, so a
         * language switch re-renders the row instead of waiting for a remount.
         * @param props - slot props; `t` is present because of the registered locale.
         */
        function PaletteRow(props: { t?: (key: string) => string }) {
          const tr = props.t ?? t
          const [state, setState] = React.useState(view)
          const [open, setOpen] = React.useState(false)
          const [colors, setColors] = React.useState(view.paths.colors)
          const [tokens, setTokens] = React.useState(view.paths.tokens)
          React.useEffect(() => {
            const listener = (): void => { setState(view) }
            listeners.add(listener)
            return () => { listeners.delete(listener) }
          }, [])
          React.useEffect(() => {
            setColors(state.paths.colors)
            setTokens(state.paths.tokens)
          }, [state.paths])

          const status = state.problem !== ''
            ? h('p', { className: 'dsh-uix-problem', role: 'alert' }, state.problem)
            : state.notice !== ''
              ? h('p', { className: 'dsh-uix-notice' }, state.notice)
              : null

          const field = (
            label: string, value: string, placeholder: string, set: (next: string) => void, hint?: unknown,
          ): unknown =>
            h('label', { className: 'dsh-uix-field' },
              h('span', { className: 'dsh-uix-label' }, label),
              h('input', {
                className: 'dsh-uix-input',
                type: 'text',
                value,
                placeholder,
                spellCheck: false,
                onChange: (event: { target: { value: string } }) => { set(event.target.value) },
              }),
              hint ?? null,
            )

          const editor = open
            ? h('div', { className: 'dsh-uix-form' },
              field(tr('palette.colors-path'), colors, DEFAULT_COLORS_PATH, setColors),
              field(tr('palette.tokens-path'), tokens, DEFAULT_TOKENS_PATH, setTokens,
                h('p', { className: 'dsh-uix-hint' }, tr('palette.paths-hint'))),
              h('div', { className: 'dsh-uix-footer' },
                h('button', {
                  type: 'button',
                  className: 'dsh-uix-save',
                  disabled: state.saving,
                  onClick: () => { void savePaths(colors.trim(), tokens.trim()) },
                }, tr('palette.save')),
                h('button', {
                  type: 'button',
                  className: 'dsh-uix-reset',
                  disabled: state.saving,
                  onClick: () => { void savePaths(DEFAULT_COLORS_PATH, DEFAULT_TOKENS_PATH) },
                }, tr('palette.reset')),
              ),
            )
            : null

          return h('div', { className: 'dsh-uix-row' },
            h('div', { className: 'dsh-uix-head' },
              h('div', { className: 'dsh-uix-text' },
                h('div', { className: 'dsh-uix-title' }, tr('palette.title')),
                h('div', { className: 'dsh-uix-desc' }, tr('palette.description')),
              ),
              h('button', {
                type: 'button',
                role: 'switch',
                'aria-checked': state.active,
                'aria-label': tr('palette.title'),
                disabled: state.saving,
                className: 'dsh-uix-switch',
                onClick: () => { void setActive(!state.active) },
              }, h('span', { className: 'dsh-uix-switch-thumb', 'aria-hidden': true })),
            ),
            status,
            h('button', {
              type: 'button',
              className: 'dsh-uix-disclosure',
              'aria-expanded': open,
              onClick: () => { setOpen(!open) },
            }, `${open ? '▾' : '▸'} ${tr('palette.paths')}`),
            editor,
          )
        }

        // Registers inside the slot's declaration lifetime and re-registers when
        // the declaration collapses and returns.
        ctx.effect(() => ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: 'ui-experience.palette',
          order: 10.5,
          locale: 'ui-experience',
        }, PaletteRow)), 'ui-experience: settings row')
        ctx.effect(() => ctx.timer.interval(() => { void poll() }, POLL_MS), 'ui-experience: palette polling')
        ctx.effect(() => {
          return () => {
            disposed = true
            teardown()
          }
        }, 'ui-experience: palette override')
        void poll()
      }

      return {
        inject: ['slots', 'locale', 'timer', 'theme', 'remote'],
        async apply(ctx: ClientContext) {
          const theme = ctx.get('theme') as ThemeLike | undefined
          if (theme === undefined) {
            console.error('ui-experience: ctx.theme is unavailable; the bundle cannot apply palettes')
            return
          }
          const unmount = await ctx.remote.$mount(uiExperienceRemoteContribution(zod))
          ctx.effect(() => () => {
            unmount().catch((error: unknown) => {
              console.error(`ui-experience: remote unmount failed: ${(error as Error).message}`)
            })
          }, 'ui-experience: remote namespace')
          // $mount awaits namespace installation; the service fiber is ACTIVE
          // by the time it resolves.
          const gateway = ctx.get(`remote.${REMOTE_SERVICE}`) as UiExperienceRemoteNamespace | undefined
          if (gateway === undefined) {
            console.error('ui-experience: the remote namespace was not installed after mounting the contribution')
            return
          }
          run(theme, ctx, gateway)
        },
      }
    },
  })
}

registerClient()
