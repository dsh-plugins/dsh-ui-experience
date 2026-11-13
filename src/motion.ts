/**
 * The motion layer: rewrites every transition and animation timing function the
 * page actually declares, in place, through CSSOM.
 *
 * Why CSSOM instead of an injected override stylesheet: a sheet keyed on class
 * names has to win the cascade against the rule it is replacing, so it needs
 * either equal-or-greater specificity per selector — which means transcribing
 * every component's selector, and that transcription is exactly what rots when
 * DSH ships a redesign — or `!important` on everything, which would also flatten
 * the deliberate exceptions such as the discrete `steps()` animations. Mutating
 * the declaration already in the cascade changes the value at the original
 * specificity and nowhere else, and the shipped selector list stays the single
 * source of truth for which elements animate.
 *
 * The consequence worth stating plainly: this layer never needs updating when
 * DSH adds, renames, or restyles a component. It follows whatever declarations
 * exist at runtime, including those a plugin bundle injects after this one
 * mounted.
 */

import { MOTION_ATTRIBUTE, type MotionSettings } from './shared.ts'
import {
  classify, classifyAll, curveFor, entryAt, isDiscrete, parseDurationMs, retime, splitList,
} from './motion-plan.ts'

/** The slice of a CSS declaration block this module reads and writes. */
interface StyleDeclarationLike {
  cssText: string
  length: number
  item(index: number): string
  getPropertyValue(name: string): string
  setProperty(name: string, value: string): void
}

/** A style rule, or a grouping rule such as `@media` holding more of them. */
interface RuleLike {
  /** `CSSRule.type`; `7` is `CSSKeyframesRule`, which also carries `name` and
   *  `cssRules` and would otherwise be confused with a named `@layer` block. */
  type?: number
  style?: StyleDeclarationLike
  cssRules?: RuleListLike
  name?: string
}

/** `CSSRule.KEYFRAMES_RULE`. */
const KEYFRAMES_RULE = 7

/** An indexed list of rules, as CSSOM exposes it. */
interface RuleListLike {
  readonly length: number
  readonly [index: number]: RuleLike | undefined
}

/** A stylesheet whose rules are readable. */
interface SheetLike {
  readonly cssRules: RuleListLike
  readonly href?: string | null
}

/** One longhand family: transitions and animations differ only in names. */
interface FamilySpec {
  readonly selector: 'transition-property' | 'animation-name'
  readonly duration: 'transition-duration' | 'animation-duration'
  readonly timing: 'transition-timing-function' | 'animation-timing-function'
  readonly iterations?: 'animation-iteration-count'
}

const TRANSITIONS: FamilySpec = {
  selector: 'transition-property',
  duration: 'transition-duration',
  timing: 'transition-timing-function',
}

const ANIMATIONS: FamilySpec = {
  selector: 'animation-name',
  duration: 'animation-duration',
  timing: 'animation-timing-function',
  iterations: 'animation-iteration-count',
}

/** The duration custom properties the shipped sheets reference. */
const DURATION_TOKENS = [
  '--ds-transition-duration',
  '--ds-transition-duration-fast',
  '--ds-transition-duration-slow',
] as const

/** One rewritten declaration block, with the text needed to restore it. */
interface Patch {
  readonly declaration: StyleDeclarationLike
  /** The block before the first write, restored verbatim. */
  readonly before: string
  /** The block after the last write, to detect a foreign edit before restoring. */
  readonly after: string
}

declare const queueMicrotask: (callback: () => void) => void

declare const document: {
  readonly styleSheets: { readonly length: number; readonly [index: number]: SheetLike | undefined }
  readonly adoptedStyleSheets?: readonly SheetLike[]
  readonly documentElement: {
    readonly style: {
      setProperty(name: string, value: string): void
      removeProperty(name: string): string
    }
    setAttribute(name: string, value: string): void
    removeAttribute(name: string): void
  }
  readonly head: { appendChild(node: unknown): unknown }
  readonly body: unknown
  createElement(tag: 'style'): { textContent: string; remove(): void }
}

declare const window: {
  matchMedia(query: string): {
    readonly matches: boolean
    addEventListener(kind: 'change', listener: () => void): void
    removeEventListener(kind: 'change', listener: () => void): void
  }
  getComputedStyle(element: unknown): { getPropertyValue(name: string): string }
}

declare const MutationObserver: new (callback: () => void) => {
  observe(target: unknown, options: { childList: boolean; subtree: boolean }): void
  disconnect(): void
}

/** Interfaces a motion layer offers its owner. */
export interface MotionRuntime {
  /**
   * Replace the active settings, restoring the shipped declarations first so a
   * mode change never stacks rewrites.
   * @param settings - the settings to realize.
   */
  apply(settings: MotionSettings): void
  /**
   * Rewrite declarations that appeared since the last scan — a lazily mounted
   * panel, a client plugin that injected its own sheet — without disturbing the
   * ones already rewritten.
   */
  refresh(): void
  /** Put every rewritten declaration back exactly as it was authored. */
  restore(): void
  /** Restore and drop the observers. */
  dispose(): void
}

/**
 * Build the motion layer. It starts inert; `apply` is what makes it act.
 * @returns the runtime handle the client keeps for the plugin's lifetime.
 */
export function createMotion(): MotionRuntime {
  /** Every declaration block this layer has written, keyed by its rule. */
  const patches = new Map<RuleLike, Patch>()
  /** Sheets already reported as unreadable, so the log gets one line each. */
  const unreadable = new Set<string>()
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  let settings: MotionSettings | undefined
  let reducedSheet: { textContent: string; remove(): void } | undefined
  let reducedActive = false
  let observer: { disconnect(): void } | undefined
  let mediaListener: (() => void) | undefined
  let refreshPending = false

  /**
   * Collect the rules of one list, descending into grouping rules.
   * @param rules - the rule list.
   * @param visit - called once per rule, depth first.
   */
  function walk(rules: RuleListLike, visit: (rule: RuleLike) => void): void {
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index]
      if (rule === undefined) continue
      visit(rule)
      if (rule.cssRules !== undefined) walk(rule.cssRules, visit)
    }
  }

  /**
   * The page's readable stylesheets in cascade order, plus adopted sheets. A
   * cross-origin sheet throws on `cssRules`; it is reported once and skipped,
   * because a silent skip would leave part of the page on the shipped curves
   * with nothing in the log to explain why.
   * @returns the readable sheets.
   */
  function readableSheets(): SheetLike[] {
    const out: SheetLike[] = []
    const collect = (sheet: SheetLike | undefined): void => {
      if (sheet === undefined) return
      try {
        const rules = sheet.cssRules
        if (rules === undefined) return
        out.push(sheet)
      } catch (error) {
        const key = sheet.href ?? '(inline)'
        if (unreadable.has(key)) return
        unreadable.add(key)
        console.error(`ui-experience: motion cannot read stylesheet ${key}: ${(error as Error).message}`)
      }
    }
    for (let index = 0; index < document.styleSheets.length; index += 1) {
      collect(document.styleSheets[index])
    }
    for (const sheet of document.adoptedStyleSheets ?? []) collect(sheet)
    return out
  }

  /**
   * Map every `@keyframes` name to the properties it animates. An animation's
   * curve has to follow what its frames move: a fade that also translates is a
   * spatial animation, a pure opacity pulse is not. A name defined in a sheet
   * this layer cannot read stays absent, and its animation is treated as an
   * effect.
   * @param sheets - the readable sheets.
   * @returns name → animated properties.
   */
  function keyframeProperties(sheets: readonly SheetLike[]): Map<string, string[]> {
    const frames = new Map<string, string[]>()
    for (const sheet of sheets) {
      walk(sheet.cssRules, (rule) => {
        if (rule.type !== KEYFRAMES_RULE || rule.name === undefined || rule.cssRules === undefined) return
        const properties = frames.get(rule.name) ?? []
        walk(rule.cssRules, (frame) => {
          const declaration = frame.style
          if (declaration === undefined) return
          for (let index = 0; index < declaration.length; index += 1) {
            const name = declaration.item(index)
            if (name !== '' && !properties.includes(name)) properties.push(name)
          }
        })
        frames.set(rule.name, properties)
      })
    }
    return frames
  }

  /**
   * Rewrite the timing functions and durations of one longhand family.
   * @param declaration - the rule's declaration block.
   * @param family - which family to process.
   * @param frames - keyframe property map, for animation classification.
   * @param active - the settings in force.
   * @returns whether anything was written.
   */
  function rewriteFamily(
    declaration: StyleDeclarationLike,
    family: FamilySpec,
    frames: ReadonlyMap<string, string[]>,
    active: MotionSettings,
  ): boolean {
    const selectors = splitList(declaration.getPropertyValue(family.selector))
    const durations = splitList(declaration.getPropertyValue(family.duration))
    const timings = splitList(declaration.getPropertyValue(family.timing))
    const iterations = family.iterations === undefined
      ? []
      : splitList(declaration.getPropertyValue(family.iterations))
    if (selectors.length === 0 && durations.length === 0 && timings.length === 0) return false

    const count = Math.max(selectors.length, durations.length, timings.length, 1)
    const nextTimings: string[] = []
    const nextDurations: string[] = []
    let timingChanged = false
    let durationChanged = false

    for (let index = 0; index < count; index += 1) {
      const selector = entryAt(selectors, index) ?? 'all'
      const originalTiming = entryAt(timings, index)
      const originalDuration = entryAt(durations, index)
      const originalMs = originalDuration === undefined ? undefined : parseDurationMs(originalDuration)
      const infinite = entryAt(iterations, index) === 'infinite'

      // `none` disables the slot, so its timing and duration are inert; they keep
      // whatever they had rather than being rewritten for no effect.
      if (selector === 'none') {
        if (originalTiming !== undefined) nextTimings.push(originalTiming)
        if (originalDuration !== undefined) nextDurations.push(originalDuration)
        continue
      }

      // Three declarations are choices rather than defaults and are left alone:
      // a discrete curve is the effect itself (a terminal cursor, a dot reveal);
      // `linear` on an endless loop is what keeps a spinner from stuttering; and
      // a zero duration is a visibility gate whose curve cannot be observed.
      const keepTiming = originalTiming !== undefined && (isDiscrete(originalTiming)
        || (infinite && originalTiming === 'linear')
        || originalMs === 0)

      // An endless animation is ambient — a spinner, a pulse, a skeleton — never
      // a discrete movement, so it takes the effect curve whatever it animates.
      // Pairing a looping progress bar with an overshooting spatial curve would
      // push it past its own track on every cycle.
      const domain = infinite
        ? 'effects'
        : family.selector === 'transition-property'
          ? classify(selector)
          : classifyAll(frames.get(selector) ?? ['opacity'])
      const curve = keepTiming && originalTiming !== undefined
        ? originalTiming
        : curveFor(active.mode, domain, active.spatialSplit, originalMs)
      nextTimings.push(curve)
      if (curve !== originalTiming) timingChanged = true

      if (originalDuration === undefined) continue
      // Loops keep their period: a 1 s spinner is a speed the design chose, not a
      // transition to retime, and the configured scale would turn it into a slog.
      const retimed = infinite ? undefined : retime(originalDuration, active.durationScale, active.quantize)
      nextDurations.push(retimed ?? originalDuration)
      if (retimed !== undefined) durationChanged = true
    }

    let changed = false
    if (timingChanged) {
      declaration.setProperty(family.timing, nextTimings.join(', '))
      changed = true
    }
    if (durationChanged) {
      declaration.setProperty(family.duration, nextDurations.join(', '))
      changed = true
    }
    return changed
  }

  /** One full scan: rewrite every rule not yet touched. */
  function scan(): void {
    const active = settings
    if (active === undefined || active.mode === 'off') return
    const sheets = readableSheets()
    const frames = keyframeProperties(sheets)
    for (const sheet of sheets) {
      walk(sheet.cssRules, (rule) => {
        const declaration = rule.style
        if (declaration === undefined || patches.has(rule)) return
        const before = declaration.cssText
        // Both families are evaluated before the results are combined: a rule may
        // legitimately declare a transition and an animation at once (the status
        // indicator and the dock hint both do), and short-circuiting on the first
        // hit would leave the second family on the shipped curve.
        const movedTransition = rewriteFamily(declaration, TRANSITIONS, frames, active)
        const movedAnimation = rewriteFamily(declaration, ANIMATIONS, frames, active)
        if (!movedTransition && !movedAnimation) return
        patches.set(rule, { declaration, before, after: declaration.cssText })
      })
    }
  }

  /** Scale the duration custom properties the shipped sheets reference. */
  function applyDurationTokens(): void {
    const active = settings
    if (active === undefined || active.durationScale === 1) return
    const root = document.documentElement
    // The base value is read from the page rather than assumed: DSH owns those
    // three tokens, and a release that retunes them must not be scaled from a
    // number this layer remembered from an older one.
    const computed = window.getComputedStyle(root)
    for (const token of DURATION_TOKENS) {
      const base = parseDurationMs(computed.getPropertyValue(token).trim())
      if (base === undefined) {
        console.error(`ui-experience: motion cannot read ${token}; durations using it keep their shipped value`)
        continue
      }
      root.style.setProperty(token, `${Math.round(base * active.durationScale)}ms`)
    }
  }

  /** Put the duration custom properties back to the shipped values. */
  function clearDurationTokens(): void {
    for (const token of DURATION_TOKENS) document.documentElement.style.removeProperty(token)
  }

  /** Whether the reduced-motion policy currently asks for a still page. */
  function wantsReduced(): boolean {
    const active = settings
    if (active === undefined) return false
    if (active.reduced === 'always') return true
    return active.reduced === 'system' && media.matches
  }

  /**
   * Install or remove the still-page sheet. This is the one thing a rule-by-rule
   * rewrite cannot express, because it has to silence declarations this layer
   * never wrote; it is also the one place `!important` is correct.
   */
  function setReducedSheet(want: boolean): void {
    if (want === reducedActive) return
    reducedActive = want
    reducedSheet?.remove()
    reducedSheet = undefined
    if (!want) return
    const sheet = document.createElement('style')
    sheet.textContent = '*,*::before,*::after{transition-duration:1ms !important;'
      + 'animation-duration:1ms !important;animation-iteration-count:1 !important;'
      + 'scroll-behavior:auto !important}'
    document.head.appendChild(sheet)
    reducedSheet = sheet
  }

  /**
   * Bring the page in line with the current settings: nothing while the layer is
   * off, only the still-page sheet while the policy holds the page still, and
   * tokens plus a full scan otherwise.
   */
  function realize(): void {
    const active = settings
    if (active === undefined || active.mode === 'off') return
    const want = wantsReduced()
    setReducedSheet(want)
    if (want) {
      // Every duration is forced to 1ms under the still-page policy, so rewritten
      // curves would be invisible work. Undoing them here means lifting the policy
      // is a plain rescan against the authored declarations.
      restoreDeclarations()
      clearDurationTokens()
      return
    }
    applyDurationTokens()
    scan()
    observer ??= observeDocument()
  }

  /**
   * Rescan for new declarations without disturbing the existing patches. Bursts
   * of appended nodes collapse into one scan on the next microtask.
   */
  function refresh(): void {
    if (refreshPending) return
    refreshPending = true
    queueMicrotask(() => {
      refreshPending = false
      scan()
    })
  }

  /**
   * Watch for stylesheets that appear after the first scan. A client plugin
   * bundle mounts on its own schedule and appends a `<style>` long after this
   * one; without the observer its rows would keep the shipped curves until the
   * next full apply.
   * @returns the observer handle.
   */
  function observeDocument(): { disconnect(): void } {
    const instance = new MutationObserver(() => { refresh() })
    // `head` covers a bundle that appends a `<style>`; `body` covers one that
    // appends it next to its own slot instead. `adoptedStyleSheets` is not a DOM
    // mutation at all, so it is only picked up by the scan in `realize`.
    instance.observe(document.head, { childList: true, subtree: true })
    instance.observe(document.body, { childList: true, subtree: true })
    return { disconnect: () => { instance.disconnect() } }
  }

  /** Drop the system preference listener. */
  function unwatchPreference(): void {
    if (mediaListener === undefined) return
    media.removeEventListener('change', mediaListener)
    mediaListener = undefined
  }

  /** Register (once) the system preference listener the `system` policy needs. */
  function watchPreference(): void {
    if (mediaListener !== undefined) return
    // The listener re-realizes the whole layer, not just the still-page sheet: a
    // page that started still never got tokens or a scan, so lifting the policy
    // has to run that work rather than merely dropping the sheet.
    mediaListener = (): void => { realize() }
    media.addEventListener('change', mediaListener)
  }

  /** Put every rewritten declaration back exactly as it was authored. */
  function restoreDeclarations(): void {
    for (const patch of patches.values()) {
      if (patch.declaration.cssText !== patch.after) {
        console.error('ui-experience: motion restore overwrote a declaration that changed after this layer wrote it')
      }
      patch.declaration.cssText = patch.before
    }
    patches.clear()
  }

  /** Undo every page-level change and stop following the page. */
  function restore(): void {
    restoreDeclarations()
    clearDurationTokens()
    setReducedSheet(false)
    unwatchPreference()
    observer?.disconnect()
    observer = undefined
    settings = undefined
    document.documentElement.removeAttribute(MOTION_ATTRIBUTE)
  }

  return {
    apply(next: MotionSettings): void {
      restore()
      settings = next
      if (next.mode === 'off') return
      watchPreference()
      // The attribute records the family even while the still-page policy is
      // holding the page still, so an inspector can tell the two states apart.
      document.documentElement.setAttribute(MOTION_ATTRIBUTE, next.mode)
      realize()
    },
    refresh,
    restore,
    dispose(): void { restore() },
  }
}
