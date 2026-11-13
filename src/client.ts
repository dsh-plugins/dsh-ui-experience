/**
 * Client half of the UI experience bundle. Renders the Matugen palette
 * switch as its own Settings → General row, overlays the system matugen
 * palette (fetched through the host half's Remote service) on whichever
 * built-in theme is active, and keeps it updated as matugen regenerates
 * colors. The native theme preference is never touched.
 *
 * The build wraps this module in the `window.__ModuleLoader__` registration
 * call; this source stays plain ESM with explicit interfaces for the
 * services the bundle consumes.
 */

import type { PollArgs, PollResult, SetActiveArgs, SetActiveResult, ThemeTokenModes } from './shared.ts'
import { REMOTE_SERVICE } from './shared.ts'

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
  number(): { optional(): unknown }
  boolean(): { optional(): unknown }
}

/** The loader-supplied synchronous module-table require (platform seeds). */
type BundleRequire = ((name: 'react') => ReactLike)
  & ((name: 'zod') => ZodLike)
  & ((name: '@deepseek-ai/dsh-client-ui-primitives') => UiPrimitives)

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
}

/** Theme registry subset this bundle consumes. */
interface ThemeLike {
  overrideTokens(source: string, tokens: Record<string, { light: string; dark: string }>): () => void
}

interface ThemeSnapshot {
  preference: string
}

/** The gateway's contribution mount face (subset of ClientRemote). */
interface ClientRemoteLike {
  $mount(contribution: { package: string; descriptors: readonly RemoteDescriptor[] }): Promise<() => Promise<void>>
}

/** Restricted Cordis context face of a dynamic client bundle. */
interface ClientContext {
  get(name: 'theme'): ThemeLike | undefined
  get(name: string): unknown
  on(name: 'theme/change', listener: (snapshot: ThemeSnapshot) => void): () => void
  effect(setup: () => (() => void) | void, label?: string): () => void
  locale: {
    register(ns: string, dicts: Record<string, Record<string, string>>): () => void
    bind(ns: string): (key: string) => string
  }
  timer: { interval(callback: () => void, delay: number): () => void }
  slots: {
    register(options: { name: string; id: string; order?: number; priority?: number }, component: unknown): () => void
  }
  remote: ClientRemoteLike
}

declare const console: { error(...values: unknown[]): void }

declare const document: {
  head: { appendChild(node: unknown): unknown }
  createElement(tag: 'style'): { textContent: string; remove(): void }
}

const SOURCE = '@local/dsh-ui-experience'
const POLL_MS = 2000

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

/**
 * Remote contribution for the host half's service. Static client bundles
 * cannot pull the generated typert.remote-client module through the shell's
 * module table, so the two InvocationDescriptor rows are authored by hand in
 * the same shape. Every strict codec carries a lazy zod factory (zod is a
 * shell seed word): mount validation only checks `create` is a function, and
 * the plain JSON request/response path never instantiates a parser.
 */
function uiExperienceRemoteContribution(zod: ZodLike): { package: string; descriptors: readonly RemoteDescriptor[] } {
  const argCodec = (name: string, schema: () => unknown): RemoteCodec => ({
    mode: 'strict',
    typeSymbol: `${SOURCE}/shared#${name}`,
    create: schema,
  })
  const resultCodec = (name: string): RemoteCodec => ({
    mode: 'strict',
    typeSymbol: `${SOURCE}/shared#${name}`,
    create: () => zod.object({}),
  })
  const descriptor = (method: 'poll' | 'setActive'): RemoteDescriptor => {
    const name = method === 'poll' ? 'PollArgs' : 'SetActiveArgs'
    const field = method === 'poll'
      ? { known: zod.number().optional() }
      : { active: zod.boolean().optional() }
    return {
      id: `${SOURCE}#${REMOTE_SERVICE}/${method}`,
      service: REMOTE_SERVICE,
      namespace: REMOTE_SERVICE,
      method,
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'args',
        wire: 'args',
        source: 'json',
        codec: argCodec(name, () => zod.object(field)),
        strictCodec: argCodec(name, () => zod.strictObject(field)),
      }],
      result: resultCodec(method === 'poll' ? 'PollResult' : 'SetActiveResult'),
    }
  }
  return { package: SOURCE, descriptors: [descriptor('poll'), descriptor('setActive')] }
}

const DICTS: Record<string, Record<string, string>> = {
  zh: {
    'palette.title': 'Matugen 配色跟随',
    'palette.description': '将系统 matugen 生成的 Material You 配色叠加在当前主题上',
    'palette.unavailable': '未找到 matugen 颜色文件',
    'palette.persist-failed': '开关状态保存失败',
  },
  en: {
    'palette.title': 'Matugen palette sync',
    'palette.description': 'Overlay the system matugen Material You palette on the current theme',
    'palette.unavailable': 'matugen colors file not found',
    'palette.persist-failed': 'Failed to persist the switch state',
  },
}

/** The primitives module the shell module table exposes to client bundles. */
interface UiPrimitives {
  Switch: (props: { checked: boolean; disabled?: boolean; label: string; onChange: (next: boolean) => void }) => unknown
}

const CSS = `
.dsh-uix-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.dsh-uix-title{font-size:14px;line-height:20px}
.dsh-uix-desc{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsh-uix-error{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
`

function registerClient(): void {
  window.__ModuleLoader__.load({
    id: SOURCE,
    factory(require) {
      const React = require('react')
      const zod = require('zod')
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      const h = React.createElement

      /**
      * Bundle body, mounted inside the injected Remote scope so every
      * registration and listener shares the namespace's lifetime.
      */
      function run(registry: ThemeLike, ctx: ClientContext, gateway: UiExperienceRemoteNamespace): void {
        ctx.effect(() => ctx.locale.register('ui-experience', DICTS), 'ui-experience: dictionaries')
        ctx.effect(() => {
          const sheet = document.createElement('style')
          sheet.textContent = CSS
          document.head.appendChild(sheet)
          return () => { sheet.remove() }
        }, 'ui-experience: row styles')
        const t = ctx.locale.bind('ui-experience')

        let known = -1
        let on = false
        /** Border width currently painted, so steady-state polls can refresh it. */
        let borderWidth = ''
        let disposeOverride: (() => void) | undefined
        let borderSheet: { textContent: string; remove(): void } | undefined
        /** Rendered switch rows mirroring the shared state. */
        const listeners = new Set<(on: boolean) => void>()
        /** Flip the shared switch state and notify rendered rows. */
        const setOn = (next: boolean): void => {
          if (on === next) return
          on = next
          for (const listener of listeners) listener(next)
        }
        /** Convert host-side { light: TokenTable, dark: TokenTable } into the
         *  per-token mode pairs the override layer expects. matugen emits one
         *  dark scheme; both modes carry it. */
        const toOverrides = (modes: ThemeTokenModes): Record<string, { light: string; dark: string }> => {
          const out: Record<string, { light: string; dark: string }> = {}
          for (const token of Object.keys(modes.dark)) {
            const dark = modes.dark[token]
            const light = modes.light[token] ?? dark
            if (dark === undefined || light === undefined) continue
            out[token] = { light, dark }
          }
          return out
        }
        /** Paint the border-width sheet; a no-op when the width is unchanged. */
        const applyBorder = (width: string): void => {
          if (width === borderWidth) return
          borderWidth = width
          borderSheet?.remove()
          borderSheet = document.createElement('style')
          borderSheet.textContent = `body *{border-width:${width} !important}`
          document.head.appendChild(borderSheet)
        }
        /** Stack the matugen palette over whatever theme is active. The layer
         *  is independent of the theme preference, so the native light/dark/system
         *  cubes keep working underneath it. */
        const applyPalette = (answer: { tokens: ThemeTokenModes; borderWidth: string }): void => {
          disposeOverride?.()
          disposeOverride = registry.overrideTokens(SOURCE, toOverrides(answer.tokens))
          applyBorder(answer.borderWidth)
        }
        const teardown = (): void => {
          disposeOverride?.()
          disposeOverride = undefined
          borderWidth = ''
          borderSheet?.remove()
          borderSheet = undefined
        }
        /** Unwrap the RPC envelope `{ ok, value }` the gateway returns; a failed
         *  call carries `{ ok: false, error }`, surfaced through the caller's catch. */
        const unwrap = <T,>(raw: unknown): T => {
          const envelope = raw as { ok: boolean; value?: T; error?: { message?: string } }
          if (envelope.ok === false) throw new Error(envelope.error?.message ?? 'remote call failed')
          return envelope.value as T
        }
        /** Whether the startup poll adopted the persisted switch state. Later
         *  polls never switch on by themselves: turning on is the toggle's
         *  explicit gesture, and the host plugin needs a restart window to
         *  apply a turn-off, during which it still reports the stale `active`. */
        let bootstrapped = false
        /** Last reported palette problem, so the failure logs once per change. */
        let lastProblem: string | undefined
        const poll = async (): Promise<void> => {
          let answer: PollResult
          try {
            answer = unwrap<PollResult>(await gateway.poll({ known }))
          } catch (error) {
            console.error(`ui-experience: poll RPC failed: ${(error as Error).message}`)
            return
          }
          if (!bootstrapped) {
            bootstrapped = true
            setOn(answer.active === true)
          } else if (on && answer.active !== true) {
            // Host-side deactivation (config edit): tear down locally.
            setOn(false)
            teardown()
          }
          if ('error' in answer || 'missing' in answer) {
            const problem = 'error' in answer ? answer.error : 'matugen colors file missing'
            if (problem !== lastProblem) {
              lastProblem = problem
              console.error(`ui-experience: palette unavailable: ${problem}`)
            }
            return
          }
          lastProblem = undefined
          if (answer.changed === true) {
            known = answer.version
            if (on) applyPalette(answer)
          } else if (on) {
            applyBorder(answer.borderWidth)
          }
        }
        ctx.effect(() => ctx.timer.interval(() => { void poll() }, POLL_MS), 'ui-experience: palette polling')
        ctx.effect(() => teardown, 'ui-experience: palette override')
        void poll()

        /** In-flight guard serializing toggle gestures. */
        let toggling = false

        /** Switch row rendered as its own settings cell; the built-in
         *  appearance row is left untouched. */
        function PaletteRow() {
          const [enabled, setEnabled] = React.useState(on)
          const [busy, setBusy] = React.useState(false)
          const [error, setError] = React.useState<string | null>(null)
          React.useEffect(() => {
            listeners.add(setEnabled)
            return () => { listeners.delete(setEnabled) }
          }, [])
          const toggle = (): void => {
            if (toggling) return
            toggling = true
            setBusy(true)
            void (async () => {
              try {
                if (on) {
                  setOn(false)
                  teardown()
                  setError(null)
                  try {
                    unwrap<SetActiveResult>(await gateway.setActive({ active: false }))
                  } catch (rpcError) {
                    console.error(`ui-experience: failed to persist deactivation: ${(rpcError as Error).message}`)
                    setError(`${t('palette.persist-failed')}: ${(rpcError as Error).message}`)
                  }
                  return
                }
                let answer: PollResult
                try {
                  answer = unwrap<PollResult>(await gateway.poll({ known: -1 }))
                } catch (rpcError) {
                  console.error(`ui-experience: activation poll failed: ${(rpcError as Error).message}`)
                  setError(`${t('palette.unavailable')}: ${(rpcError as Error).message}`)
                  return
                }
                if ('error' in answer || 'missing' in answer || answer.changed !== true) {
                  setError(t('palette.unavailable'))
                  return
                }
                setError(null)
                known = answer.version
                bootstrapped = true
                setOn(true)
                applyPalette(answer)
                try {
                  unwrap<SetActiveResult>(await gateway.setActive({ active: true }))
                } catch (rpcError) {
                  console.error(`ui-experience: failed to persist activation: ${(rpcError as Error).message}`)
                  setError(`${t('palette.persist-failed')}: ${(rpcError as Error).message}`)
                }
              } finally {
                toggling = false
                setBusy(false)
              }
            })()
          }
          return h('div', { className: 'dsh-uix-row' },
            h('div', null,
              h('div', { className: 'dsh-uix-title' }, t('palette.title')),
              h('div', { className: 'dsh-uix-desc' }, t('palette.description')),
              error !== null ? h('div', { className: 'dsh-uix-error', role: 'alert' }, error) : null,
            ),
            h(primitives.Switch, { checked: enabled, disabled: busy, label: t('palette.title'), onChange: () => { toggle() } }),
          )
        }

        ctx.effect(() => ctx.slots.register({
          name: 'settings.general.item',
          id: 'ui-experience.palette',
          order: 10.5,
        }, PaletteRow), 'ui-experience: settings row')
      }

      return {
        inject: ['slots', 'locale', 'timer', 'theme', 'remote'],
        async apply(ctx: ClientContext) {
          const theme: ThemeLike | undefined = ctx.get('theme')
          if (theme === undefined) {
            console.error('ui-experience: ctx.theme is unavailable; the bundle cannot apply palettes')
            return
          }
          const registry: ThemeLike = theme
          const unmount = await ctx.remote.$mount(uiExperienceRemoteContribution(zod))
          ctx.effect(() => () => { void unmount() }, 'ui-experience: remote namespace')
          // $mount awaits namespace installation; the service fiber is ACTIVE
          // by the time it resolves.
          const gateway = ctx.get(`remote.${REMOTE_SERVICE}`) as UiExperienceRemoteNamespace | undefined
          if (gateway === undefined) {
            console.error('ui-experience: the remote namespace was not installed after mounting the contribution')
            return
          }
          run(registry, ctx, gateway)
        },
      }
    },
  })
}

registerClient()
