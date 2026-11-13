/**
 * Scripted smooth scrolling, and the `scrollend` semantics that make it safe.
 *
 * The browser owns the timing of `behavior: 'smooth'`: neither CSS nor a
 * `scroll` listener can read its duration or its curve, so a page whose
 * transitions all follow Material curves still glides on the UA's own ease for
 * an unspecified length. This layer replaces that motion with scripted travel on
 * the same curve family the rest of the bundle applies.
 *
 * WHY SCRIPTED SCROLLING NEEDED A SECOND PIECE
 *
 * Scrolling by writing `scrollTop` once per frame is a series of *instant*
 * scrolls, and the browser ends each of them on its own. Measured in Chrome 156
 * over the same 1200px of travel:
 *
 *   native `behavior: 'smooth'`        56 `scroll` events, 1 `scrollend`
 *   one `scrollTop` write per frame    21 `scroll` events, 21 `scrollend`
 *
 * Everything on this page that decides "the scroll has come to rest" listens for
 * `scrollend`: the chat transcript's follow controller settles its target on it,
 * and the session inspector's reveal places its highlight on it. Feeding them 21
 * ends per gesture makes each of them conclude the reader stopped short, on the
 * first frame.
 *
 * So the layer also *shadows* `scrollend`: while it is moving a container, that
 * container's real `scrollend` events are stopped at the capture phase, and one
 * synthetic event is dispatched when the run actually finishes or is cancelled.
 * Every consumer sees the sequence a native smooth scroll would have produced —
 * one `scroll` stream, exactly one end.
 *
 * WHAT IS TAKEN OVER
 *
 * `scrollTo` and `scrollBy` cover both one-shot locating (a virtualized table
 * jumping to a row) and the streaming follow loop, which retargets itself many
 * times a second. Only the first kind is worth scripting: a run that is retargeted
 * every frame would be restarted every frame, so its curve never plays. The
 * discriminator is the call pattern — a second smooth request on the same
 * container inside `RETARGET_WINDOW` is a controller chasing a moving target, and
 * from then on that container's scrolling is handed back to the browser.
 *
 * FIXED RULES, NOT CONFIGURABLE
 *
 * 1. The reader wins. A wheel or touch over a container being moved, or a scroll
 *    key outside a text field, cancels the run outright — it does not blend, and
 *    it does not resume. A position change this layer did not write cancels it
 *    too, which catches a scrollbar drag, an assistive-technology scroll, or a
 *    container that reflowed mid-run.
 * 2. The curve is the effects curve, never the spatial one. A spatial curve
 *    overshoots, and overshoot while scrolling sends the content past the row the
 *    reader was sent to before settling back — the destination lands wrong twice.
 */

import { type MotionSettings } from './shared.ts'
import { easeCurve, effectCurvePoints, quantizeMs } from './motion-plan.ts'

/** `ScrollToOptions`, restated so this file needs no DOM lib. */
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
  contains(other: unknown): boolean
  closest(selectors: string): unknown
  dispatchEvent(event: unknown): boolean
  scrollTo(options?: ScrollToOptions | number, y?: number): void
  scrollBy(options?: ScrollToOptions | number, y?: number): void
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
  /** Resolves the caller's promise and releases the shadowed ends. */
  readonly done: () => void
}

/** A minimal event face: the type, the target and, for keys, the key. */
interface EventLike {
  readonly type: string
  readonly target: EventTarget | null
  readonly key?: string
  /** Present on real events; the shadowing path is the only caller that needs it. */
  stopImmediatePropagation(): void
}

/** Shortest scripted scroll; below this the motion reads as a jump anyway. */
const MIN_MS = 180
/** Longest scripted scroll, so a full-pane jump never drags. */
const MAX_MS = 460
/** Distance the floor covers; travel past it adds time. */
const FREE_PX = 240
/** Extra duration per pixel beyond `FREE_PX`. */
const GROWTH_MS_PER_PX = 0.2

/**
 * Slack for comparing two positions that both came back from the browser. They
 * are already snapped to its pixel grid: a whole pixel at dpr 1, a 2/3 step at
 * dpr 1.5, half a pixel at dpr 2. This absorbs the finest of those, so a genuine
 * half-pixel move on a dpr 2 display reads as no movement — accepted, it is not
 * visible.
 */
const MOTION_EPSILON = 0.5

/** Difference past which a position this layer did not write is a foreign scroll. */
const FOREIGN_TOLERANCE = 1

/**
 * Window in which a second smooth request on the same container is read as a
 * controller retargeting a moving target rather than a person asking to be taken
 * somewhere once. Measured follow loops retarget on every content change, which
 * during streaming is far inside this window.
 */
const RETARGET_WINDOW = 300

/** Keys that scroll the page, by `KeyboardEvent.key`. */
const SCROLL_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'PageUp', 'PageDown', 'Home', 'End', ' ',
])

/**
 * Fields where those keys edit text instead of scrolling.
 *
 * Every exclusion is part of the same compound selector, so all of them apply to
 * `input` alone. Split across two comma-separated entries, the second one would
 * be a bare `:not(...)` — a compound selector in its own right — and would match
 * every element on the page, turning the whole keyboard cancellation path off.
 * A checkbox or a button is an `input` too, but a scroll key over one still
 * scrolls the page, so those types stay out of the list.
 */
const EDITABLE = [
  'input:not([type=checkbox]):not([type=radio]):not([type=button])'
    + ':not([type=submit]):not([type=reset]):not([type=file]):not([type=range])',
  'textarea', 'select',
  '[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
].join(', ')

/** Inputs that mean the reader has taken over the container. */
const TAKEOVER_EVENTS = ['wheel', 'touchstart', 'keydown'] as const

declare const Element: {
  prototype: ElementLike
  new (): ElementLike
}
declare const Event: new (type: string, init?: { bubbles?: boolean }) => unknown
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
 * Build the scripted-scroll layer. It starts inert; `apply` installs the patches.
 * @returns the handle the client keeps for the bundle's lifetime.
 */
export function createScrollMotion(): {
  apply(settings: MotionSettings): void
  restore(): void
} {
  const shipped = {
    scrollTo: Element.prototype.scrollTo as (this: ElementLike, ...args: unknown[]) => Promise<void> | undefined,
    scrollBy: Element.prototype.scrollBy as (this: ElementLike, ...args: unknown[]) => Promise<void> | undefined,
    scrollIntoView: Element.prototype.scrollIntoView as (this: ElementLike, ...args: unknown[]) => Promise<void> | undefined,
  }
  let settings: MotionSettings | undefined
  let run: Run | undefined
  let installed = false
  /**
   * Containers whose real `scrollend` is withheld right now, and until when.
   * `Infinity` means "for as long as the run moves it"; a timestamp means "this
   * long after the run ended", which covers the end the browser still owes for
   * the final position write.
   */
  const shadowed = new WeakMap<ElementLike, number>()
  /** Last smooth request per container, for the retarget discriminator. */
  const lastRequest = new WeakMap<ElementLike, number>()
  /** Set while this layer dispatches its own end, so it does not withhold it. */
  let dispatching = false

  /**
   * How long the end the browser owes for a run's last write is withheld after
   * the run finishes. That end lands within a frame or two; a native scroll
   * started afterwards ends hundreds of milliseconds later, so it passes.
   */
  const END_GRACE_MS = 120

  /**
   * Containers currently inside that grace window. A `WeakMap` cannot be walked,
   * and a reader who starts scrolling right after a run lands must not have their
   * own end swallowed, so the same members are listed here to be cleared.
   */
  const graceful = new Set<ElementLike>()

  /** Stop withholding ends from every container still inside the grace window. */
  function clearGrace(): void {
    for (const element of graceful) shadowed.delete(element)
    graceful.clear()
  }

  /** Shadow one container for as long as a run is moving it. */
  function hold(element: ElementLike): void {
    shadowed.set(element, Number.POSITIVE_INFINITY)
  }

  /**
   * Release one container.
   * @param element - the container a run has stopped moving.
   * @param notify - whether to hand its consumer the single end the run owes. A
   * run that is handing the container back to the browser must stay silent, since
   * the native scroll about to start raises its own end.
   */
  function release(element: ElementLike, notify: boolean): void {
    if (!shadowed.has(element)) return
    shadowed.set(element, performance.now() + END_GRACE_MS)
    graceful.add(element)
    if (!notify) return
    // Async so the position write that ended the run is visible to the listener,
    // the way it is when the browser raises the real event.
    queueMicrotask(() => {
      dispatching = true
      try {
        element.dispatchEvent(new Event('scrollend'))
      } finally {
        dispatching = false
      }
    })
  }

  /**
   * Stop the in-flight run where it is.
   * @param notify - whether its containers owe their consumer an end.
   */
  function cancel(notify = true): void {
    const active = run
    if (active === undefined) return
    window.cancelAnimationFrame(active.frame)
    run = undefined
    for (const leg of active.legs) release(leg.element, notify)
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
    // Verify every leg before writing any of them, so no leg is judged against a
    // position this same frame just changed. Writing one container does not move
    // another synchronously, but keeping the check ahead of the writes makes that
    // independence an invariant of the loop rather than a property of the browser.
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
      for (const leg of active.legs) release(leg.element, true)
      active.done()
      return
    }
    active.frame = window.requestAnimationFrame(step)
  }

  /**
   * Start one run, replacing any run in flight. Legs are captured from the
   * current position, so a second request mid-flight retargets.
   * @param legs - the legs to animate.
   * @param done - resolves the caller's promise when the run ends or is cancelled.
   */
  function start(legs: readonly Leg[], done: () => void): void {
    cancel()
    // `apply` only installs the patches when it has settings, so a run cannot begin
    // without them.
    const active = settings as MotionSettings
    for (const leg of legs) hold(leg.element)
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
   * Whether a smooth request is a controller retargeting rather than a one-shot
   * locate. Records the request either way.
   * @param element - the container the request names.
   * @returns whether the browser should take this one.
   */
  function isRetarget(element: ElementLike): boolean {
    const now = performance.now()
    const previous = lastRequest.get(element)
    lastRequest.set(element, now)
    return previous !== undefined && now - previous < RETARGET_WINDOW
  }

  /**
   * The patched `scrollIntoView`.
   *
   * The final offset depends on alignment, `scroll-margin`, nested containers and
   * the element's own box; recomputing that is how a scripted scroll ends up on
   * the wrong row. Instead the browser is asked for an instant jump, every moved
   * container's landing position is read, all of them are put back, and those
   * captured positions are animated. Jump and restore happen inside one task, so
   * the intermediate position never paints — and the ends the jump raises are
   * shadowed along with the rest of the run.
   *
   * Takes the arguments as a rest list so the patched function keeps the native
   * `length` of 0 and, being named `scrollIntoView`, the native `name`.
   */
  function scrollIntoView(this: ElementLike, ...args: unknown[]): Promise<void> | undefined {
    const options = args[0]
    const requested = typeof options === 'object' && options !== null
      ? options as ScrollIntoViewOptions
      : undefined
    const active = settings
    if (active === undefined || requested?.behavior !== 'smooth') return shipped.scrollIntoView.apply(this, args)
    const jump: ScrollIntoViewOptions = { ...requested, behavior: 'instant' }
    // Reduced motion turns a smooth reveal into the jump it would have been.
    if (wantsInstant()) return shipped.scrollIntoView.call(this, jump)
    const tracked = containers(this)
    // Shadow before the jump: its own end must not reach a consumer that is about
    // to be told the run finished.
    for (const element of tracked) hold(element)
    const before = tracked.map(element => ({ top: element.scrollTop, left: element.scrollLeft }))
    shipped.scrollIntoView.call(this, jump)
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
      if (!moved) {
        // Nothing moved here, so the browser would have raised no end either.
        release(element, false)
        continue
      }
      legs.push({ element, fromTop: origin.top, fromLeft: origin.left, toTop: landed.top, toLeft: landed.left })
    }
    // The native call resolves even when nothing moved, so `await` never sees a
    // different contract here than it does without this layer.
    if (legs.length === 0) return Promise.resolve()
    return new Promise<void>(resolve => { start(legs, resolve) })
  }

  /**
   * Resolve a request's offsets against an origin.
   *
   * Only the object form reaches here: `behavior: 'smooth'` cannot be expressed by
   * the legacy `scrollTo(x, y)` call, which is forwarded to the browser instead.
   * @param options - the options object.
   * @param base - the origin the request is resolved against.
   * @returns the resolved offsets; `undefined` leaves that axis alone.
   */
  function readOffsets(
    options: ScrollToOptions,
    base: { top: number; left: number },
  ): { top: number | undefined; left: number | undefined } {
    return {
      left: options.left === undefined ? undefined : base.left + options.left,
      top: options.top === undefined ? undefined : base.top + options.top,
    }
  }

  /**
   * Turn an offset request into a single leg, or nothing when it would not move.
   * @param element - the container.
   * @param top - requested top offset, or undefined to keep it.
   * @param left - requested left offset, or undefined to keep it.
   * @returns the leg, or undefined.
   */
  function legFor(element: ElementLike, top: number | undefined, left: number | undefined): Leg | undefined {
    const max = maxima(element)
    const toTop = top === undefined ? element.scrollTop : Math.min(max.top, Math.max(0, top))
    const toLeft = left === undefined ? element.scrollLeft : Math.min(max.left, Math.max(0, left))
    if (Math.abs(toTop - element.scrollTop) < MOTION_EPSILON
      && Math.abs(toLeft - element.scrollLeft) < MOTION_EPSILON) return undefined
    return { element, fromTop: element.scrollTop, fromLeft: element.scrollLeft, toTop, toLeft }
  }

  /**
   * Shared body of the patched `scrollTo` and `scrollBy`.
   * @param element - the receiver.
   * @param args - the caller's arguments.
   * @param shippedMethod - the method to defer to.
   * @param relative - whether offsets are resolved against the current position.
   * @returns the promise the native call would have returned.
   */
  function patchedOffset(
    element: ElementLike,
    args: unknown[],
    shippedMethod: (this: ElementLike, ...rest: unknown[]) => Promise<void> | undefined,
    relative: boolean,
  ): Promise<void> | undefined {
    const options = args[0] as ScrollToOptions | number | undefined
    const behavior = typeof options === 'object' && options !== null ? options.behavior : undefined
    const active = settings
    if (active === undefined || behavior !== 'smooth') return shippedMethod.apply(element, args)
    if (wantsInstant()) return shippedMethod.apply(element, args)
    // A controller chasing a moving floor owns this container: its run would be
    // restarted every frame and its curve would never play.
    if (isRetarget(element)) {
      // Drop our run silently — the native scroll about to start raises its own end.
      cancel(false)
      return shippedMethod.apply(element, args)
    }
    const base = relative
      ? { top: element.scrollTop, left: element.scrollLeft }
      : { top: 0, left: 0 }
    const request = readOffsets(options as ScrollToOptions, base)
    const leg = legFor(element, request.top, request.left)
    // A request that changes nothing still resolves, like the native call.
    if (leg === undefined) return Promise.resolve()
    return new Promise<void>(resolve => { start([leg], resolve) })
  }

  /** The patched `scrollTo`. */
  function scrollTo(this: ElementLike, ...args: unknown[]): Promise<void> | undefined {
    return patchedOffset(this, args, shipped.scrollTo, false)
  }

  /** The patched `scrollBy`. */
  function scrollBy(this: ElementLike, ...args: unknown[]): Promise<void> | undefined {
    return patchedOffset(this, args, shipped.scrollBy, true)
  }

  /**
   * Withhold the real end of a scroll this layer is animating, so a consumer sees
   * the single end a native smooth scroll would have produced.
   * @param event - a `scrollend` event.
   */
  function onScrollEnd(event: EventLike): void {
    if (dispatching) return
    const target = event.target as unknown as ElementLike | null
    if (target === null) return
    const until = shadowed.get(target)
    if (until === undefined) return
    if (until !== Number.POSITIVE_INFINITY && performance.now() > until) {
      // The grace window has passed: this end belongs to whatever scrolled next.
      shadowed.delete(target)
      graceful.delete(target)
      return
    }
    event.stopImmediatePropagation()
  }

  /**
   * Reader input ends the scripted run before the browser processes it, so its
   * own scrolling starts from where this layer stopped.
   * @param event - the candidate takeover event.
   */
  function onTakeover(event: EventLike): void {
    const active = run
    if (active === undefined) {
      // No run to stop, but an end still owed for the last one must not be
      // withheld from the scroll this input is about to start.
      clearGrace()
      return
    }
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
    // scrollport and must not stop the run.
    const target = event.target
    if (target === null || !active.legs.some(leg => leg.element.contains(target))) return
    cancel()
  }

  /** Install the patches and the listeners. */
  function install(): void {
    if (installed) return
    installed = true
    const prototype = Element.prototype as unknown as Record<string, unknown>
    prototype.scrollTo = scrollTo
    prototype.scrollBy = scrollBy
    prototype.scrollIntoView = scrollIntoView
    // Capture on the window reaches the scroller before any listener the consumer
    // registered, whether it listens on the element or on the window.
    window.addEventListener('scrollend', onScrollEnd, true)
    for (const kind of TAKEOVER_EVENTS) {
      window.addEventListener(kind, onTakeover, { capture: true, passive: true })
    }
  }

  /** Remove the patches and the listeners, and stop any run in flight. */
  function uninstall(): void {
    cancel(false)
    clearGrace()
    if (!installed) return
    installed = false
    const prototype = Element.prototype as unknown as Record<string, unknown>
    prototype.scrollTo = shipped.scrollTo
    prototype.scrollBy = shipped.scrollBy
    prototype.scrollIntoView = shipped.scrollIntoView
    window.removeEventListener('scrollend', onScrollEnd, true)
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
