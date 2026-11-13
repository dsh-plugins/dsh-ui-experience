/**
 * Scripted smooth scrolling.
 *
 * The browser owns the timing of `behavior: 'smooth'`: neither CSS nor a
 * `scroll` listener can read its duration or its curve, so a page that gives its
 * transitions Material curves would still scroll on the UA's own ease for an
 * unspecified length. This layer replaces that motion with scripted scrolling
 * that follows the same curve family the rest of the bundle applies.
 *
 * Two rules are fixed and are not configurable:
 *
 * 1. Native motion wins the moment the reader scrolls. A wheel, a touch, or a
 *    scroll key cancels the scripted animation outright — it does not blend, and
 *    it does not resume. Any position change this layer did not write cancels it
 *    as well, which catches what the event list cannot see: a scrollbar drag, an
 *    assistive-technology scroll, or a container that reflowed under the run.
 * 2. The curve is the effects curve, never the spatial one. A spatial curve
 *    overshoots, and overshoot while scrolling means the content travels past
 *    the row the reader was sent to and comes back — the destination lands wrong
 *    twice. The curve family still applies, but the overshooting half never does.
 *
 * `scrollend` is left to the browser. Scrolling by assigning `scrollTop` every
 * animation frame is a series of instant scrolls, so the UA's own end-of-scroll
 * detection fires once the last frame lands; consumers that settle their state
 * on `scrollend` (the chat transcript's follow controller) see exactly the
 * sequence they see for a native smooth scroll.
 */

import { type MotionSettings } from './shared.ts'
import { easeCurve, effectCurvePoints } from './motion-plan.ts'

/** `ScrollToOptions`, restated so the file needs no DOM lib. */
interface ScrollToOptions {
  top?: number
  left?: number
  behavior?: 'auto' | 'instant' | 'smooth'
}

/** `ScrollIntoViewOptions`, restated for the same reason. */
interface ScrollIntoViewOptions {
  behavior?: 'auto' | 'instant' | 'smooth'
  block?: 'start' | 'center' | 'end' | 'nearest'
  inline?: 'start' | 'center' | 'end' | 'nearest'
}

/** The scrollable-element face this module patches and reads. */
interface ElementLike {
  scrollTop: number
  scrollLeft: number
  readonly scrollHeight: number
  readonly scrollWidth: number
  readonly clientHeight: number
  readonly clientWidth: number
  readonly parentElement: ElementLike | null
  scrollTo(options?: ScrollToOptions | number, y?: number): void
  scrollBy(options?: ScrollToOptions | number, y?: number): void
  scrollIntoView(options?: boolean | ScrollIntoViewOptions): void
}

/** One element's animated axis pair. */
interface Leg {
  readonly element: ElementLike
  readonly fromTop: number
  readonly fromLeft: number
  readonly toTop: number
  readonly toLeft: number
}

/** The animation currently running, if any. */
interface Run {
  readonly legs: readonly Leg[]
  /** `performance.now()` of the first frame. */
  readonly started: number
  readonly duration: number
  /** The last position this run wrote per leg, to notice a foreign scroll. */
  readonly written: Array<{ top: number; left: number }>
  frame: number
}

/** A minimal event face: the patch only reads the type and, for keys, the key. */
interface EventLike {
  readonly type: string
  readonly key?: string
}

/** Shortest scripted scroll; below this the motion reads as a jump anyway. */
const MIN_MS = 180
/** Longest scripted scroll, so a full-page jump never drags. */
const MAX_MS = 460
/** Distance covered by `MIN_MS`; travel past it adds time. */
const FREE_PX = 240
/** Extra duration per pixel travelled beyond `FREE_PX`. */
const GROWTH_MS_PER_PX = 0.2

/** Keys a reader uses to scroll, by `KeyboardEvent.key`. */
const SCROLL_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'PageUp', 'PageDown', 'Home', 'End', ' ',
])

/**
 * Inputs that mean the reader has taken over the scrollport.
 *
 * `pointerdown` is deliberately absent. A press anywhere in the page is a click,
 * not necessarily a scroll — cancelling on it would cut a scripted follow short
 * every time the reader clicks a button while new output arrives, where the
 * browser's own smooth scroll would have finished. Dragging a scrollbar still
 * ends the run, because the drag moves a position this layer did not write and
 * the foreign-position guard catches that on the next frame.
 */
const TAKEOVER_EVENTS = ['wheel', 'touchstart', 'keydown'] as const

declare const Element: { prototype: ElementLike }
declare const window: {
  requestAnimationFrame(callback: (time: number) => void): number
  cancelAnimationFrame(handle: number): void
  addEventListener(kind: string, listener: (event: EventLike) => void, capture: boolean): void
  removeEventListener(kind: string, listener: (event: EventLike) => void, capture: boolean): void
  matchMedia(query: string): { readonly matches: boolean }
}

declare const performance: { now(): number }

/**
 * Travel distance of a run, in CSS pixels: the longest single-axis move any of
 * its legs has to make.
 * @param legs - the legs of the run.
 * @returns the distance in pixels.
 */
export function scrollDistance(legs: readonly Leg[]): number {
  let distance = 0
  for (const leg of legs) {
    distance = Math.max(distance, Math.abs(leg.toTop - leg.fromTop), Math.abs(leg.toLeft - leg.fromLeft))
  }
  return distance
}

/**
 * Duration for one scripted scroll: a floor for short hops, then a slow linear
 * growth so a long jump gains travel time without turning into a drag.
 * @param distance - pixels to travel.
 * @param settings - the settings in force.
 * @returns the duration in milliseconds.
 */
export function scrollDurationMs(distance: number, settings: MotionSettings): number {
  const grown = MIN_MS + Math.max(0, distance - FREE_PX) * GROWTH_MS_PER_PX
  return Math.min(MAX_MS, grown) * settings.durationScale
}

/**
 * The farthest offset an element can scroll to on each axis.
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
 * Whether an element has overflow to scroll.
 * @param element - the candidate.
 * @returns whether either axis can move.
 */
function scrollable(element: ElementLike): boolean {
  const max = maxima(element)
  return max.top > 0 || max.left > 0
}

/**
 * Every scroll container a `scrollIntoView` on this element would move,
 * innermost first.
 * @param element - the element being revealed.
 * @returns its scrollable ancestors.
 */
function containers(element: ElementLike): ElementLike[] {
  const out: ElementLike[] = []
  let node = element.parentElement
  while (node !== null) {
    if (scrollable(node)) out.push(node)
    node = node.parentElement
  }
  return out
}

/**
 * Build the scripted-scroll layer. It starts inert; `apply` installs the patches.
 * @returns the handle the client keeps for the bundle's lifetime.
 */
export function createScrollMotion(): {
  apply(settings: MotionSettings): void
  restore(): void
} {
  /** The shipped methods, captured so uninstall puts back exactly what was there. */
  const shipped = {
    scrollTo: Element.prototype.scrollTo,
    scrollBy: Element.prototype.scrollBy,
    scrollIntoView: Element.prototype.scrollIntoView,
  }
  let settings: MotionSettings | undefined
  let run: Run | undefined
  let installed = false

  /** Stop the running animation where it is, without snapping to the target. */
  function cancel(): void {
    if (run === undefined) return
    window.cancelAnimationFrame(run.frame)
    run = undefined
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
    const eased = easeCurve(effectCurvePoints(settings?.mode ?? 'm3e'), progress)
    for (let index = 0; index < active.legs.length; index += 1) {
      const leg = active.legs[index]
      const written = active.written[index]
      if (leg === undefined || written === undefined) continue
      // Anything the reader moved behind this run's back ends it here rather than
      // fighting over the same scrollport.
      if (Math.abs(leg.element.scrollTop - written.top) > 1
        || Math.abs(leg.element.scrollLeft - written.left) > 1) {
        cancel()
        return
      }
      const top = progress >= 1 ? leg.toTop : leg.fromTop + (leg.toTop - leg.fromTop) * eased
      const left = progress >= 1 ? leg.toLeft : leg.fromLeft + (leg.toLeft - leg.fromLeft) * eased
      if (leg.element.scrollTop !== top) leg.element.scrollTop = top
      if (leg.element.scrollLeft !== left) leg.element.scrollLeft = left
      written.top = leg.element.scrollTop
      written.left = leg.element.scrollLeft
    }
    if (progress >= 1) {
      // The final frame writes the exact target, so the position the UA reports at
      // scrollend is the requested one rather than a rounded neighbour.
      run = undefined
      return
    }
    active.frame = window.requestAnimationFrame(step)
  }

  /**
   * Start one run, replacing any animation in flight. The legs are captured from
   * the current position, so a second request mid-flight retargets the way the
   * native one does.
   * @param legs - the legs to animate.
   */
  function start(legs: readonly Leg[]): void {
    cancel()
    const active = settings
    if (active === undefined) return
    run = {
      legs,
      started: performance.now(),
      duration: scrollDurationMs(scrollDistance(legs), active),
      written: legs.map(leg => ({ top: leg.element.scrollTop, left: leg.element.scrollLeft })),
      frame: window.requestAnimationFrame(step),
    }
  }

  /**
   * Whether a call must run shipped instead: the layer is not active, the reader
   * asked for less motion, or the call did not ask for smooth scrolling.
   * @param behavior - the requested behavior.
   * @returns whether to defer to the browser.
   */
  function defer(behavior: ScrollToOptions['behavior']): boolean {
    if (settings === undefined) return true
    if (behavior !== 'smooth') return true
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  /**
   * Legs for an explicit offset request, or undefined when nothing would move.
   * @param element - the scroll container.
   * @param top - requested top offset, already resolved against the element.
   * @param left - requested left offset, resolved the same way.
   * @returns the leg, or undefined.
   */
  function legsFor(element: ElementLike, top: number | undefined, left: number | undefined): Leg[] | undefined {
    const max = maxima(element)
    const toTop = top === undefined ? element.scrollTop : Math.min(max.top, Math.max(0, top))
    const toLeft = left === undefined ? element.scrollLeft : Math.min(max.left, Math.max(0, left))
    if (Math.abs(toTop - element.scrollTop) < 1 && Math.abs(toLeft - element.scrollLeft) < 1) return undefined
    return [{ element, fromTop: element.scrollTop, fromLeft: element.scrollLeft, toTop, toLeft }]
  }

  /**
   * Read either calling convention into one offset pair. `scrollTo` resolves
   * against the container's origin, `scrollBy` against its current position.
   * @param options - the options object or the legacy x argument.
   * @param y - the legacy y argument.
   * @param base - the origin the request is relative to.
   * @returns the resolved offsets; `undefined` means "leave this axis alone".
   */
  function readOffsets(
    options: ScrollToOptions | number | undefined,
    y: number | undefined,
    base: { top: number; left: number },
  ): { top: number | undefined; left: number | undefined } {
    if (typeof options === 'number') {
      return { left: base.left + options, top: y === undefined ? undefined : base.top + y }
    }
    if (options === undefined || options === null) return { top: undefined, left: undefined }
    return {
      left: options.left === undefined ? undefined : base.left + options.left,
      top: options.top === undefined ? undefined : base.top + options.top,
    }
  }

  /** The patched `scrollTo`. */
  function patchedScrollTo(this: ElementLike, options?: ScrollToOptions | number, y?: number): void {
    const behavior = typeof options === 'object' && options !== null ? options.behavior : undefined
    if (defer(behavior)) {
      ;(shipped.scrollTo as unknown as (this: ElementLike, a?: unknown, b?: unknown) => void)
        .call(this, options, y)
      return
    }
    const request = readOffsets(options, y, { top: 0, left: 0 })
    const legs = legsFor(this, request.top, request.left)
    if (legs !== undefined) start(legs)
  }

  /** The patched `scrollBy`. */
  function patchedScrollBy(this: ElementLike, options?: ScrollToOptions | number, y?: number): void {
    const behavior = typeof options === 'object' && options !== null ? options.behavior : undefined
    if (defer(behavior)) {
      ;(shipped.scrollBy as unknown as (this: ElementLike, a?: unknown, b?: unknown) => void)
        .call(this, options, y)
      return
    }
    const request = readOffsets(options, y, { top: this.scrollTop, left: this.scrollLeft })
    const legs = legsFor(this, request.top, request.left)
    if (legs !== undefined) start(legs)
  }

  /**
   * The patched `scrollIntoView`.
   *
   * The final offset depends on alignment, `scroll-margin`, nested containers and
   * the element's own box; reimplementing that is how a scripted scroll ends up
   * on the wrong row. Instead the browser is asked for an instant jump, every
   * moved container's landing position is read, all of them are put back, and the
   * captured positions are animated. Jump and restore happen inside one task, so
   * the intermediate position never paints.
   */
  function patchedScrollIntoView(this: ElementLike, options?: boolean | ScrollIntoViewOptions): void {
    const behavior = typeof options === 'object' && options !== null ? options.behavior : undefined
    if (defer(behavior)) {
      ;(shipped.scrollIntoView as unknown as (this: ElementLike, o?: unknown) => void).call(this, options)
      return
    }
    const instant = { ...(typeof options === 'object' && options !== null ? options : {}), behavior: 'instant' as const }
    const tracked = containers(this)
    const before = tracked.map(element => ({ top: element.scrollTop, left: element.scrollLeft }))
    ;(shipped.scrollIntoView as unknown as (this: ElementLike, o?: unknown) => void).call(this, instant)
    const legs: Leg[] = []
    for (let index = 0; index < tracked.length; index += 1) {
      const element = tracked[index]
      const origin = before[index]
      if (element === undefined || origin === undefined) continue
      const landed = { top: element.scrollTop, left: element.scrollLeft }
      element.scrollTop = origin.top
      element.scrollLeft = origin.left
      if (Math.abs(landed.top - origin.top) < 1 && Math.abs(landed.left - origin.left) < 1) continue
      legs.push({ element, fromTop: origin.top, fromLeft: origin.left, toTop: landed.top, toLeft: landed.left })
    }
    if (legs.length > 0) start(legs)
  }

  /**
   * Reader input ends the scripted animation before the browser processes it, so
   * its own scrolling starts from where this layer stopped.
   * @param event - the takeover event.
   */
  function onTakeover(event: EventLike): void {
    if (run === undefined) return
    if (event.type !== 'keydown') {
      cancel()
      return
    }
    if (event.key !== undefined && SCROLL_KEYS.has(event.key)) cancel()
  }

  /** Install the patches and the takeover listeners. */
  function install(): void {
    if (installed) return
    installed = true
    const prototype = Element.prototype as unknown as Record<string, unknown>
    prototype.scrollTo = patchedScrollTo
    prototype.scrollBy = patchedScrollBy
    prototype.scrollIntoView = patchedScrollIntoView
    for (const kind of TAKEOVER_EVENTS) {
      window.addEventListener(kind, onTakeover, true)
    }
  }

  /** Remove the patches and the listeners, and drop any animation in flight. */
  function uninstall(): void {
    cancel()
    if (!installed) return
    installed = false
    const prototype = Element.prototype as unknown as Record<string, unknown>
    prototype.scrollTo = shipped.scrollTo
    prototype.scrollBy = shipped.scrollBy
    prototype.scrollIntoView = shipped.scrollIntoView
    for (const kind of TAKEOVER_EVENTS) {
      window.removeEventListener(kind, onTakeover, true)
    }
  }

  return {
    apply(next: MotionSettings): void {
      uninstall()
      settings = next
      if (!next.scroll || next.mode === 'off') return
      // A reader who asked the system for less motion has already told the page
      // that scripted travel is unwelcome; their scrolling stays native.
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      install()
    },
    restore: uninstall,
  }
}
