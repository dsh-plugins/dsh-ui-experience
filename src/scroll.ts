/**
 * Scripted smooth scrolling for `scrollIntoView`.
 *
 * The browser owns the timing of a smooth reveal: neither CSS nor a `scroll`
 * listener can read its duration or its curve, so a page whose transitions all
 * follow Material curves still glides to a located row on the UA's own ease for
 * an unspecified length. This layer replaces that one call with scripted travel
 * on the same curve family the rest of the bundle applies.
 *
 * WHY ONLY `scrollIntoView`
 *
 * Taking over `scrollTo` / `scrollBy` as well would break the chat transcript.
 * Its follow controller sets a target, then settles on `scrollend`; measured in
 * Chrome 156 over the same 1200px travel, a native smooth scroll delivers 56
 * `scroll` events and exactly 1 `scrollend`, while writing `scrollTop` once per
 * animation frame delivers 21 and **21** — the browser ends each instant scroll on
 * its own. The controller reads the first of those as "the reader stopped short"
 * and drops follow intent on the first frame. The calls that feed that loop
 * therefore stay native.
 *
 * `scrollIntoView` is the one-shot family instead — reveal a trajectory row,
 * centre a plugin card, jump to a session-inspector node.
 *
 * KNOWN CONSEQUENCE, AND WHY THIS SHIPS OFF
 *
 * Those per-frame `scrollend` events reach every listener on the page, and one
 * shipping consumer does count them: the session inspector's reveal highlights a
 * node once scrolling settles (`reveal.ts` → `onEnd` → `finish`). Measured against
 * the built bundle in Chrome 156, its settle callback fires at 1 ms with the
 * scrollport still at its origin, so the highlight is placed on a row that has not
 * arrived yet. The instant jump also contributes one `scroll`/`scrollend` pair
 * before the first animation frame, which is enough on its own.
 *
 * There is no way for this layer to keep the timing and deny those events, so the
 * setting defaults to off. Turning it on is a deliberate trade: locating jumps on
 * the page curve, at the cost of any consumer that settles on `scrollend`.
 *
 * Two rules are fixed and are not configurable:
 *
 * 1. The reader wins. A wheel or touch over a container being scrolled, or a
 *    scroll key outside a text field, cancels the scripted run outright — it does
 *    not blend, and it does not resume. A position change this layer did not write
 *    cancels it too, which catches what the event list cannot see: a scrollbar
 *    drag, an assistive-technology scroll, a container that reflowed mid-run.
 * 2. The curve is the effects curve, never the spatial one. A spatial curve
 *    overshoots, and overshoot while scrolling sends the content past the row the
 *    reader was sent to before it settles back — the destination lands wrong
 *    twice. The family still applies; the overshooting half never does.
 */

import { type MotionSettings } from './shared.ts'
import { easeCurve, effectCurvePoints, quantizeMs } from './motion-plan.ts'

/** `ScrollIntoViewOptions`, restated so this file needs no DOM lib. */
interface ScrollIntoViewOptions {
  behavior?: 'auto' | 'instant' | 'smooth'
  block?: 'start' | 'center' | 'end' | 'nearest'
  inline?: 'start' | 'center' | 'end' | 'nearest'
}

/** The element face this module reads. */
interface ElementLike {
  scrollTop: number
  scrollLeft: number
  readonly scrollHeight: number
  readonly scrollWidth: number
  readonly clientHeight: number
  readonly clientWidth: number
  readonly parentElement: ElementLike | null
  contains(other: unknown): boolean
  closest(selectors: string): unknown
  scrollIntoView(options?: boolean | ScrollIntoViewOptions): void
}

/** One container's animated axis pair. */
interface Leg {
  readonly element: ElementLike
  readonly fromTop: number
  readonly fromLeft: number
  readonly toTop: number
  readonly toLeft: number
}

/** The run currently in flight. */
interface Run {
  readonly legs: readonly Leg[]
  readonly started: number
  readonly duration: number
  /** The last position this run wrote per leg, to notice a foreign scroll. */
  readonly written: Array<{ top: number; left: number }>
  frame: number
  readonly done: () => void
}

/** A minimal event face: only the type, the target and, for keys, the key. */
interface EventLike {
  readonly type: string
  readonly target: EventTarget | null
  readonly key?: string
}

/** Shortest scripted reveal; below this the motion reads as a jump anyway. */
const MIN_MS = 180
/** Longest scripted reveal, so a full-pane jump never drags. */
const MAX_MS = 460
/** Distance the floor covers; travel past it adds time. */
const FREE_PX = 240
/** Extra duration per pixel beyond `FREE_PX`. */
const GROWTH_MS_PER_PX = 0.2

/**
 * Slack for comparing two positions that both came back from the browser. They
 * are already quantized to its pixel grid (measured: assigning 1234.5 reads back
 * 1235 at dpr 1, 0.6666 at dpr 1.5), so this only absorbs a fractional device
 * pixel at dpr 2, where the grid step is 0.5.
 */
const MOTION_EPSILON = 0.5

/** Difference past which a position the layer did not write is a foreign scroll. */
const FOREIGN_TOLERANCE = 1

/** Keys that scroll the page, by `KeyboardEvent.key`. */
const SCROLL_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'PageUp', 'PageDown', 'Home', 'End', ' ',
])

/** Fields where those keys edit text instead of scrolling. A checkbox or a
 *  button is an `input` too, but a scroll key over one still scrolls the page. */
const EDITABLE = [
  'input:not([type=checkbox]):not([type=radio]):not([type=button])',
  ':not([type=submit]):not([type=reset]):not([type=file]):not([type=range])',
  'textarea', 'select',
  '[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
].join(', ')

/** Inputs that mean the reader has taken over the container. */
const TAKEOVER_EVENTS = ['wheel', 'touchstart', 'keydown'] as const

declare const Element: {
  prototype: ElementLike
  new (): ElementLike
}
declare const window: {
  requestAnimationFrame(callback: (time: number) => void): number
  cancelAnimationFrame(handle: number): void
  addEventListener(kind: string, listener: (event: EventLike) => void, capture: boolean | { capture: boolean; passive: boolean }): void
  removeEventListener(kind: string, listener: (event: EventLike) => void, capture: boolean): void
  matchMedia(query: string): { readonly matches: boolean }
}

declare const performance: { now(): number }

/**
 * Travel distance of a run: the longest single-axis move any leg must make.
 * @param legs - the legs of the run.
 * @returns the distance in CSS pixels.
 */
function scrollDistance(legs: readonly Leg[]): number {
  let distance = 0
  for (const leg of legs) {
    distance = Math.max(distance, Math.abs(leg.toTop - leg.fromTop), Math.abs(leg.toLeft - leg.fromLeft))
  }
  return distance
}

/**
 * Duration for one run: a floor for short hops, then a slow linear growth so a
 * long jump gains travel time without turning into a drag.
 * @param distance - pixels to travel.
 * @param settings - the settings in force.
 * @returns the duration in milliseconds.
 */
function scrollDurationMs(distance: number, settings: MotionSettings): number {
  const grown = MIN_MS + Math.max(0, distance - FREE_PX) * GROWTH_MS_PER_PX
  const scaled = Math.min(MAX_MS, grown) * settings.durationScale
  // A scroll that ignored the ladder would be the one animation off the grid.
  return settings.quantize ? quantizeMs(scaled) : scaled
}

/**
 * The farthest offset a container can scroll to on each axis.
 * @param element - the scroll container.
 * @returns the top and left maxima.
 */
function maxima(element: ElementLike): { top: number; left: number } {
  return {
    top: Math.max(0, element.scrollHeight - element.clientHeight),
    left: Math.max(0, element.scrollWidth - element.clientWidth),
  }
}

/**
 * Every scroll container a reveal of this element would move, innermost first.
 * @param element - the element being revealed.
 * @returns its scrollable ancestors.
 */
function containers(element: ElementLike): ElementLike[] {
  const out: ElementLike[] = []
  let node = element.parentElement
  while (node !== null) {
    const max = maxima(node)
    if (max.top > 0 || max.left > 0) out.push(node)
    node = node.parentElement
  }
  return out
}

/**
 * Build the scripted-reveal layer. It starts inert; `apply` installs the patch.
 * @returns the handle the client keeps for the bundle's lifetime.
 */
export function createScrollMotion(): {
  apply(settings: MotionSettings): void
  restore(): void
} {
  const shipped = Element.prototype.scrollIntoView as unknown as
    (this: ElementLike, ...args: unknown[]) => Promise<void> | undefined
  let settings: MotionSettings | undefined
  let run: Run | undefined
  let installed = false

  /** Stop the in-flight run where it is, resolving its promise. */
  function cancel(): void {
    const active = run
    if (active === undefined) return
    window.cancelAnimationFrame(active.frame)
    run = undefined
    active.done()
  }

  /**
   * One animation frame: advance every leg, or land on the target.
   * @param now - the frame timestamp the browser supplies.
   */
  function step(now: number): void {
    const active = run
    if (active === undefined) return
    const elapsed = now - active.started
    const progress = active.duration <= 0 ? 1 : Math.min(1, elapsed / active.duration)
    const eased = easeCurve(effectCurvePoints((settings as MotionSettings).mode), progress)
    // Check every leg before writing any of them: writing an inner container can
    // move an ancestor through scroll anchoring, and a check interleaved with the
    // writes would read that as the reader having taken over.
    for (let index = 0; index < active.legs.length; index += 1) {
      const leg = active.legs[index]
      const written = active.written[index]
      if (leg === undefined || written === undefined) continue
      if (Math.abs(leg.element.scrollTop - written.top) > FOREIGN_TOLERANCE
        || Math.abs(leg.element.scrollLeft - written.left) > FOREIGN_TOLERANCE) {
        cancel()
        return
      }
    }
    for (const leg of active.legs) {
      const top = progress >= 1 ? leg.toTop : leg.fromTop + (leg.toTop - leg.fromTop) * eased
      const left = progress >= 1 ? leg.toLeft : leg.fromLeft + (leg.toLeft - leg.fromLeft) * eased
      if (leg.element.scrollTop !== top) leg.element.scrollTop = top
      if (leg.element.scrollLeft !== left) leg.element.scrollLeft = left
    }
    for (let index = 0; index < active.legs.length; index += 1) {
      const leg = active.legs[index]
      const written = active.written[index]
      if (leg === undefined || written === undefined) continue
      written.top = leg.element.scrollTop
      written.left = leg.element.scrollLeft
    }
    if (progress >= 1) {
      // The final frame writes the un-eased target. The browser may snap it to a
      // whole pixel, so the landing position can differ by less than one.
      run = undefined
      active.done()
      return
    }
    active.frame = window.requestAnimationFrame(step)
  }

  /**
   * Start one run, replacing any run in flight. Legs are captured from the
   * current position, so a second reveal mid-flight retargets.
   * @param legs - the legs to animate.
   * @param done - resolves the caller's promise when the run ends or is cancelled.
   */
  function start(legs: readonly Leg[], done: () => void): void {
    cancel()
    // `apply` only installs the patch when it has settings, so a run cannot begin
    // without them.
    const active = settings as MotionSettings
    run = {
      legs,
      started: performance.now(),
      duration: scrollDurationMs(scrollDistance(legs), active),
      written: legs.map(leg => ({ top: leg.element.scrollTop, left: leg.element.scrollLeft })),
      frame: window.requestAnimationFrame(step),
      done,
    }
  }

  /** Whether the reduced-motion policy asks for instant travel. */
  function wantsInstant(): boolean {
    const active = settings as MotionSettings
    if (active.reduced === 'always') return true
    return active.reduced === 'system' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  /**
   * The patched `scrollIntoView`.
   *
   * The final offset depends on alignment, `scroll-margin`, nested containers and
   * the element's own box; recomputing that is how a scripted scroll ends up on
   * the wrong row. Instead the browser is asked for an instant jump, every moved
   * container's landing position is read, all of them are put back, and those
   * captured positions are animated. Jump and restore happen inside one task, so
   * the intermediate position never paints.
   *
   * Takes the arguments as a rest list so the patched function keeps the native
   * `length` of 0; a library that inspects the signature still sees what it
   * expects.
   */
  function scrollIntoView(this: ElementLike, ...args: unknown[]): Promise<void> | undefined {
    const options = args[0]
    const requested = typeof options === 'object' && options !== null
      ? options as ScrollIntoViewOptions
      : undefined
    const active = settings
    if (active === undefined || requested?.behavior !== 'smooth') return shipped.apply(this, args)
    const jump: ScrollIntoViewOptions = { ...requested, behavior: 'instant' }
    // Reduced motion turns a smooth reveal into the jump it would have been.
    if (wantsInstant()) return shipped.call(this, jump)
    const tracked = containers(this)
    const before = tracked.map(element => ({ top: element.scrollTop, left: element.scrollLeft }))
    shipped.call(this, jump)
    const legs: Leg[] = []
    for (let index = 0; index < tracked.length; index += 1) {
      const element = tracked[index]
      const origin = before[index]
      if (element === undefined || origin === undefined) continue
      const landed = { top: element.scrollTop, left: element.scrollLeft }
      // Put the container back before anything paints, then animate to the place
      // the browser said it belonged.
      element.scrollTop = origin.top
      element.scrollLeft = origin.left
      const moved = Math.abs(landed.top - origin.top) > MOTION_EPSILON
        || Math.abs(landed.left - origin.left) > MOTION_EPSILON
      if (!moved) continue
      legs.push({ element, fromTop: origin.top, fromLeft: origin.left, toTop: landed.top, toLeft: landed.left })
    }
    if (legs.length === 0) return undefined
    return new Promise<void>(resolve => { start(legs, resolve) })
  }

  /**
   * Reader input ends the scripted run before the browser processes it, so its
   * own scrolling starts from where this layer stopped.
   * @param event - the candidate takeover event.
   */
  function onTakeover(event: EventLike): void {
    const active = run
    if (active === undefined) return
    if (event.type === 'keydown') {
      // Keys scroll only when focus is not in a field that consumes them.
      if (event.key === undefined || !SCROLL_KEYS.has(event.key)) return
      const target = event.target
      if (target instanceof Element && target.closest(EDITABLE) !== null) return
      cancel()
      return
    }
    // A wheel or touch only means "the reader took this container" when it lands
    // on a container this run is moving; one over a side panel is somebody else's
    // scrollport and must not stop the reveal.
    const target = event.target
    if (target === null || !active.legs.some(leg => leg.element.contains(target))) return
    cancel()
  }

  /** Install the patch and the takeover listeners. */
  function install(): void {
    if (installed) return
    installed = true
    ;(Element.prototype as unknown as Record<string, unknown>).scrollIntoView = scrollIntoView
    for (const kind of TAKEOVER_EVENTS) {
      window.addEventListener(kind, onTakeover, { capture: true, passive: true })
    }
  }

  /** Remove the patch and the listeners, and stop any run in flight. */
  function uninstall(): void {
    cancel()
    if (!installed) return
    installed = false
    ;(Element.prototype as unknown as Record<string, unknown>).scrollIntoView = shipped
    for (const kind of TAKEOVER_EVENTS) {
      window.removeEventListener(kind, onTakeover, true)
    }
  }

  return {
    apply(next: MotionSettings): void {
      uninstall()
      settings = next
      if (!next.scroll || next.mode === 'off') return
      install()
    },
    restore: uninstall,
  }
}
