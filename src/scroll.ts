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
  legs: Leg[]
  started: number
  duration: number
  /** The last position this run wrote per leg, to notice a foreign scroll. */
  written: Array<{ top: number; left: number }>
  frame: number
  /** Callers whose promise settles when this run ends, however it ends. */
  readonly done: Array<() => void>
}

/**
 * One container's withholding state. `until: Infinity` means a run is moving it
 * right now; otherwise it records where the run left it, so the end the browser
 * still owes for that final write can be told apart from a later scroll's end.
 */
interface Shadow {
  until: number
  top: number
  left: number
}

/** A minimal event face: the type, the target and, for keys, the key. */
interface EventLike {
  readonly type: string
  readonly target: EventTarget | null
  readonly key?: string
  /** Present on real events; the shadowing path is the only caller that needs it. */
  stopImmediatePropagation(): void
}

/** The wheel fields this layer reads. */
interface WheelLike extends EventLike {
  readonly deltaX: number
  readonly deltaY: number
  readonly deltaMode: number
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  /** Set by a handler closer to the target that already took this notch. */
  readonly defaultPrevented: boolean
  preventDefault(): void
}

/**
 * A wheel stream. Each notch re-aims one segment from where the viewport is to
 * the accumulated target, the way Chromium's own `UpdateTarget` does: the curve
 * restarts from the current position, so the velocity stays continuous instead
 * of jumping back to the curve's start.
 */
interface WheelRun {
  readonly element: ElementLike
  /** Accumulated target, clamped to the container's range. */
  top: number
  left: number
  /** Where the current segment began. */
  fromTop: number
  fromLeft: number
  /** Timestamp the current segment began, for its progress. */
  started: number
  /** Duration of the current segment. */
  duration: number
  frame: number
}

/** The native `scrollTop` / `scrollLeft` accessors, captured before patching. */
interface AxisAccessor {
  readonly get: (this: ElementLike) => number
  readonly set: (this: ElementLike, value: number) => void
  readonly enumerable: boolean
  readonly configurable: boolean
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

/**
 * Shortest travel this layer turns into an animation when a caller asks for an
 * immediate jump. Anything smaller is a layout correction — a measurement cached
 * a pixel ago, an anchoring fix, a follow that is already at the floor — and
 * animating those would leave the viewport chasing its own content.
 */
const JUMP_ANIMATE_MIN = 24

/** Wheel travel below this lands immediately, so the stream can end. */
const WHEEL_SETTLE_PX = 0.5

/**
 * Pixels one `deltaMode: DOM_DELTA_LINE` unit moves, from Chromium's
 * `cc::kPixelsPerLineStep`. A coarse wheel reports lines, so without this a notch
 * would read as 3px and the layer would decline it.
 */
const PIXELS_PER_LINE = 40

/** Fraction of the viewport one `DOM_DELTA_PAGE` unit moves, from Chromium's
 *  `kMinFractionToStepWhenPaging`. */
const PAGE_FRACTION = 0.875

/** Overlap Chromium leaves between pages, from `kMaxOverlapBetweenPages`. */
const PAGE_OVERLAP = 40

/** How long a wheel run may coast after the last notch before it is cut short. */
const WHEEL_MAX_MS = 900

declare const Element: {
  prototype: ElementLike
  new (): ElementLike
}
declare const Event: new (type: string, init?: { bubbles?: boolean }) => unknown

/** The listener-options shape this file passes to `addEventListener`. */
interface AddEventListenerOptionsLike {
  capture: boolean
  passive: boolean
}
declare const window: {
  requestAnimationFrame(callback: (time: number) => void): number
  cancelAnimationFrame(handle: number): void
  addEventListener(kind: string, listener: (event: never) => void, capture: boolean | AddEventListenerOptionsLike): void
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
  /** The shipped axis accessors, captured so internal writes bypass the patch. */
  const topAxis = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop') as unknown as AxisAccessor | undefined
  const leftAxis = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft') as unknown as AxisAccessor | undefined
  let settings: MotionSettings | undefined
  let run: Run | undefined
  let wheel: WheelRun | undefined
  let installed = false
  /** Non-zero while this layer writes a position, so its own patches stay out of the way. */
  let writing = 0
  /**
   * Containers whose real `scrollend` is withheld right now, and until when.
   * `Infinity` means "for as long as the run moves it"; a timestamp means "this
   * long after the run ended", which covers the end the browser still owes for
   * the final position write.
   */
  const shadowed = new WeakMap<ElementLike, Shadow>()
  /** Set while this layer dispatches its own end, so it does not withhold it. */
  let dispatching = false

  /**
   * How long the end the browser owes for a run's last write may take to arrive.
   * That end follows the final position write by a frame or two; the deadline is
   * only a backstop for a stalled main thread, and the position check below is
   * what actually decides.
   */
  const END_GRACE_MS = 400

  /** Slack for deciding a container was sitting at its floor before a write. */
  const FOLLOW_PIN_TOLERANCE = 4

  /**
   * Growth below this is one or two lines arriving mid-stream, which is written
   * straight through.
   *
   * The transcript already animates that arrival — the mask reveal makes the text
   * appear progressively — so gliding the scrollport for the same few pixels adds a
   * second motion on top of the first. During continuous output the glides would
   * also chain end to end, leaving the viewport in permanent motion. Only a
   * discrete block that lands in one go, a tool result or a whole paragraph, is
   * worth easing into view.
   */
  const FOLLOW_GLIDE_MIN_PX = 48

  /** Longest a single follow glide may take. */
  const FOLLOW_MAX_MS = 260

  /** Floor each container was last seen at, so "was pinned" can be answered. */
  const lastFloor = new WeakMap<ElementLike, number>()

  /**
   * Containers currently inside that grace window. A `WeakMap` cannot be walked,
   * and a reader who starts scrolling right after a run lands must not have their
   * own end swallowed, so the same members are listed here to be cleared.
   */
  const graceful = new Set<ElementLike>()

  /**
   * Write an offset without going through this layer's own patches.
   * @param element - the container.
   * @param axis - which axis to write.
   * @param value - the offset.
   */
  function writeAxis(element: ElementLike, axis: 'top' | 'left', value: number): void {
    const accessor = axis === 'top' ? topAxis : leftAxis
    if (accessor !== undefined) {
      writing += 1
      try {
        accessor.set.call(element, value)
      } finally {
        writing -= 1
      }
      return
    }
    // No accessor means the property lives somewhere other than the prototype;
    // assigning plainly is the only thing left, and it is still correct.
    if (axis === 'top') element.scrollTop = value
    else element.scrollLeft = value
  }

  /** Stop withholding ends from every container still inside the grace window. */
  function clearGrace(): void {
    for (const element of graceful) shadowed.delete(element)
    graceful.clear()
  }

  /** Shadow one container for as long as a run is moving it. */
  function hold(element: ElementLike): void {
    shadowed.set(element, { until: Number.POSITIVE_INFINITY, top: 0, left: 0 })
  }

  /**
   * Release one container.
   *
   * The end the browser still owes for the final write is recognised by position,
   * not by a fixed delay: it is the one that arrives while the container is still
   * exactly where the run left it. A scroll that starts afterwards moves the
   * container, and its end is let through no matter how soon it arrives.
   *
   * @param element - the container a run has stopped moving.
   * @param notify - whether to hand its consumer the single end the run owes. A
   * run that is handing the container back to the browser must stay silent, since
   * the native scroll about to start raises its own end.
   */
  function release(element: ElementLike, notify: boolean): void {
    if (!shadowed.has(element)) return
    shadowed.set(element, {
      until: performance.now() + END_GRACE_MS,
      top: element.scrollTop,
      left: element.scrollLeft,
    })
    graceful.add(element)
    if (!notify) return
    // Async so the position write that ended the run is visible to the listener,
    // the way it is when the browser raises the real event.
    queueMicrotask(() => {
      // A run may have taken this container back between the release and now. It
      // has not stopped, so it owes its consumer nothing yet.
      if (shadowed.get(element)?.until === Number.POSITIVE_INFINITY) return
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
    stopWheel()
    const active = run
    if (active === undefined) return
    window.cancelAnimationFrame(active.frame)
    run = undefined
    for (const leg of active.legs) release(leg.element, notify)
    for (const settle of active.done) settle()
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
      if (leg.element.scrollTop !== top) writeAxis(leg.element, 'top', top)
      if (leg.element.scrollLeft !== left) writeAxis(leg.element, 'left', left)
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
      for (const settle of active.done) settle()
      return
    }
    active.frame = window.requestAnimationFrame(step)
  }

  /**
   * Start one run, replacing any run in flight.
   * @param legs - the legs to animate.
   * @param done - settles the caller's promise when the run ends or is cancelled.
   */
  function start(legs: readonly Leg[], done: () => void): void {
    cancel()
    // `apply` only installs the patches when it has settings, so a run cannot begin
    // without them.
    const active = settings as MotionSettings
    for (const leg of legs) hold(leg.element)
    run = {
      legs: [...legs],
      started: performance.now(),
      duration: scrollDurationMs(scrollDistance(legs), active),
      written: legs.map(leg => ({ top: leg.element.scrollTop, left: leg.element.scrollLeft })),
      frame: window.requestAnimationFrame(step),
      done: [done],
    }
  }

  /**
   * Fold a new request into the run already moving this container, the way a
   * native smooth scroll re-aims instead of starting over.
   *
   * Restarting would be wrong twice: the curve would begin again from zero on
   * every retarget, and a caller that retargets on each content change — the
   * streaming follow loop, or a virtualizer correcting a row it just measured —
   * would never let a single run finish, so its consumer would never see an end.
   *
   * @param leg - the request's leg.
   * @param done - settles this caller's promise with the run.
   * @returns whether the request was folded in; false means the caller must start
   * a fresh run.
   */
  function merge(legs: readonly Leg[], done: () => void): boolean {
    const active = run
    if (active === undefined) return false
    // Only a run moving exactly the same containers can absorb the request: a
    // different container means a different scrollport with its own story.
    if (active.legs.length !== legs.length) return false
    for (let index = 0; index < legs.length; index += 1) {
      if (active.legs[index]?.element !== legs[index]?.element) return false
    }
    active.legs = [...legs]
    active.started = performance.now()
    active.duration = scrollDurationMs(scrollDistance(legs), settings as MotionSettings)
    active.written = legs.map(leg => ({ top: leg.element.scrollTop, left: leg.element.scrollLeft }))
    active.done.push(done)
    return true
  }

  /** Whether the reduced-motion policy asks for instant travel. */
  function wantsInstant(): boolean {
    const active = settings as MotionSettings
    if (active.reduced === 'always') return true
    return active.reduced === 'system' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  /** One container's in-flight follow glide. */
  const followGlides = new Map<ElementLike, { frame: number; from: number; to: number; started: number; duration: number }>()

  /**
   * Whether a write to `scrollTop` is the streaming tail being followed.
   *
   * The transcript follows by assigning the floor on every content change, so the
   * pattern is specific: the value is the container's maximum, and the container
   * was already sitting within a few lines of it. A jump from further away is a
   * deliberate move and is left alone.
   *
   * @param element - the container.
   * @param value - the value being written.
   * @returns whether to glide to it instead of jumping.
   */
  function isFollowWrite(element: ElementLike, value: number): boolean {
    const active = settings
    if (active === undefined) return false
    if (wantsInstant()) return false
    const max = maxima(element)
    if (max.top <= 0) return false
    // Must land on the floor, which is what the follow loop writes.
    if (Math.abs(value - max.top) > 1) return false
    // Was the container sitting at its floor before this content arrived? Recorded
    // floor to floor, because by the time the write happens the floor has already
    // moved by however much was inserted.
    const known = lastFloor.get(element)
    const wasPinned = known === undefined
      ? element.scrollTop >= max.top - FOLLOW_PIN_TOLERANCE
      : element.scrollTop >= known - FOLLOW_PIN_TOLERANCE
    lastFloor.set(element, max.top)
    if (!wasPinned) return false
    // A discrete block is worth easing; continuous one-line growth is not.
    return Math.abs(value - element.scrollTop) >= FOLLOW_GLIDE_MIN_PX
  }

  /**
   * Glide a container to its new floor over one frame chain.
   * @param element - the container.
   * @param to - the value the caller wrote.
   */
  function startFollow(element: ElementLike, to: number): void {
    const active = settings as MotionSettings
    const existing = followGlides.get(element)
    if (existing !== undefined) window.cancelAnimationFrame(existing.frame)
    else hold(element)
    const from = element.scrollTop
    const glide = {
      frame: 0,
      from,
      to,
      started: performance.now(),
      // Short: the tail moves one line at a time, and a long glide would still be
      // running when the next line arrives.
      duration: Math.min(FOLLOW_MAX_MS, scrollDurationMs(Math.abs(to - from) * 4, active)),
    }
    followGlides.set(element, glide)
    const step = (now: number): void => {
      const current = followGlides.get(element)
      if (current !== glide) return
      const progress = Math.min(1, (now - glide.started) / glide.duration)
      const eased = easeCurve(effectCurvePoints(active.mode), progress)
      writeAxis(element, 'top', glide.from + (glide.to - glide.from) * eased)
      if (progress >= 1) {
        followGlides.delete(element)
        writeAxis(element, 'top', glide.to)
        release(element, true)
        return
      }
      glide.frame = window.requestAnimationFrame(step)
    }
    glide.frame = window.requestAnimationFrame(step)
  }

  /** Stop every follow glide, leaving the viewports where they are. */
  function stopFollows(): void {
    for (const [element, glide] of followGlides) {
      window.cancelAnimationFrame(glide.frame)
      release(element, true)
    }
    followGlides.clear()
  }

  /** Stop the wheel run without landing, leaving the viewport where it is. */
  function stopWheel(): void {
    const active = wheel
    if (active === undefined) return
    window.cancelAnimationFrame(active.frame)
    wheel = undefined
    release(active.element, true)
  }

  /**
   * One wheel frame: close a fixed fraction of the remaining distance, so the
   * stream slows as it lands and a new notch simply adds to the remainder.
   * @param now - the frame timestamp the browser supplies.
   */
  function wheelStep(now: number): void {
    const active = wheel
    if (active === undefined) return
    const element = active.element
    const progress = active.duration <= 0 ? 1 : Math.min(1, (now - active.started) / active.duration)
    const eased = easeCurve(effectCurvePoints((settings as MotionSettings).mode), progress)
    if (progress >= 1) {
      writeAxis(element, 'top', active.top)
      writeAxis(element, 'left', active.left)
      wheel = undefined
      release(element, true)
      return
    }
    writeAxis(element, 'top', active.fromTop + (active.top - active.fromTop) * eased)
    writeAxis(element, 'left', active.fromLeft + (active.left - active.fromLeft) * eased)
    active.frame = window.requestAnimationFrame(wheelStep)
  }

  /**
   * Ease a wheel notch onto its landing position.
   *
   * The browser applies wheel deltas itself, so this cannot be a `scroll` patch:
   * what it can do is take the delta the page is about to apply and drive the
   * same distance on the effect curve instead of instantly.
   *
   * @param event - the wheel event.
   * @returns whether this layer took the notch.
   */
  function onWheel(event: WheelLike): boolean {
    const active = settings
    if (active === undefined) return false
    // Zoom gestures arrive as ctrl+wheel and must keep their native meaning.
    if (event.ctrlKey || event.metaKey) return false
    if (wantsInstant()) return false
    const target = event.target
    if (target === null) return false
    // Text fields scroll themselves while the reader edits; easing that fights the
    // caret. Anything else the app explicitly claimed is already gone by here.
    if (target instanceof Element && target.closest(EDITABLE) !== null) return false
    if (event.deltaX === 0 && event.deltaY === 0) return false
    // Look for a container that can move on the axis this gesture asks about, so a
    // horizontally scrolling child cannot make the layer decline a vertical notch.
    const element = scrollportOf(target as unknown as ElementLike, {
      top: event.deltaY !== 0,
      left: event.deltaX !== 0,
    })
    if (element === null) return false
    const max = maxima(element)
    const delta = pixelDelta(event, element)
    const base = wheel?.element === element ? wheel : undefined
    const fromTop = element.scrollTop
    const fromLeft = element.scrollLeft
    const top = Math.min(max.top, Math.max(0, (base?.top ?? fromTop) + delta.y))
    const left = Math.min(max.left, Math.max(0, (base?.left ?? fromLeft) + delta.x))
    if (Math.abs(top - fromTop) < WHEEL_SETTLE_PX && Math.abs(left - fromLeft) < WHEEL_SETTLE_PX) return false
    event.preventDefault()
    // A wheel notch supersedes whatever was animating: the reader is in charge.
    const stopped = run
    if (stopped !== undefined) {
      window.cancelAnimationFrame(stopped.frame)
      run = undefined
      for (const leg of stopped.legs) release(leg.element, true)
      for (const settle of stopped.done) settle()
    }
    if (base === undefined) hold(element)
    else window.cancelAnimationFrame(base.frame)
    // The segment starts from where the viewport stands now, so a burst of notches
    // keeps the position continuous; each notch re-aims the curve rather than
    // restarting it from an origin the viewport already left behind.
    const travelled = Math.max(Math.abs(top - fromTop), Math.abs(left - fromLeft))
    const segment: WheelRun = {
      element,
      top,
      left,
      fromTop,
      fromLeft,
      started: performance.now(),
      duration: Math.min(WHEEL_MAX_MS, scrollDurationMs(travelled, active)),
      frame: 0,
    }
    wheel = segment
    segment.frame = window.requestAnimationFrame(wheelStep)
    return true
  }

  /**
   * The nearest ancestor that can scroll, starting at the event target itself.
   * @param node - the event target.
   * @returns the scroll container, or null.
   */
  function scrollportOf(
    node: ElementLike | null, axis: { top: boolean; left: boolean },
  ): ElementLike | null {
    let current = node
    while (current !== null) {
      const max = maxima(current)
      // Only a container that can move on the axis the gesture asks for counts.
      // A horizontally scrolling child — a code block, a wide table — must not
      // swallow a vertical notch: the browser would chain it to the parent, and
      // this layer declining would leave that parent on the native curve.
      if ((axis.top && max.top > 0) || (axis.left && max.left > 0)) return current
      current = current.parentElement
    }
    return null
  }

  /**
   * One page step, matching Chromium's `ScrollUtils::CalculatePageStep`.
   * @param length - the viewport extent on the axis.
   * @returns the pixels one page unit moves.
   */
  function pageStep(length: number): number {
    return Math.max(1, Math.max(length * PAGE_FRACTION, length - PAGE_OVERLAP))
  }

  /**
   * A wheel delta in pixels. A precise (trackpad, Wayland, macOS) event already
   * is; a coarse wheel reports lines, and a page-scroll reports pages.
   * @param event - the wheel event.
   * @param element - the container the gesture will move, for its viewport size.
   * @returns the delta in pixels.
   */
  function pixelDelta(event: WheelLike, element: ElementLike): { x: number; y: number } {
    if (event.deltaMode === 0) return { x: event.deltaX, y: event.deltaY }
    const unitY = event.deltaMode === 1 ? PIXELS_PER_LINE : pageStep(element.clientHeight)
    const unitX = event.deltaMode === 1 ? PIXELS_PER_LINE : pageStep(element.clientWidth)
    return { x: event.deltaX * unitX, y: event.deltaY * unitY }
  }

  /**
   * Whether a caller's immediate jump should be animated. Only a request that
   * says "instant" and asks for real travel qualifies; a plain property write or
   * an `auto` request stays immediate, because layout code uses those for
   * corrections where a delayed position would be a bug rather than a nicety.
   * @param behavior - the requested behavior.
   * @param distance - how far the request would move each axis.
   * @returns whether to animate it.
   */
  function animates(behavior: ScrollToOptions['behavior'], distance: { top: number; left: number }): boolean {
    return behavior === 'instant'
      && Math.max(distance.top, distance.left) >= JUMP_ANIMATE_MIN
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
      writeAxis(element, 'top', origin.top)
      writeAxis(element, 'left', origin.left)
      const moved = Math.abs(landed.top - origin.top) > MOTION_EPSILON
        || Math.abs(landed.left - origin.left) > MOTION_EPSILON
      if (!moved) {
        // A container a live run is still moving has not stopped; leave its shadow
        // alone. Otherwise nothing moved here, so no end is owed.
        if (run?.legs.some(leg => leg.element === element)) continue
        release(element, false)
        continue
      }
      legs.push({ element, fromTop: origin.top, fromLeft: origin.left, toTop: landed.top, toLeft: landed.left })
    }
    // The native call resolves even when nothing moved, so `await` never sees a
    // different contract here than it does without this layer.
    if (legs.length === 0) return Promise.resolve()
    // A reveal repeated on the same containers — a timeline dragged across rows,
    // a chat that keeps re-revealing — re-aims the run in flight. Restarting it
    // would reset the curve every call and owe its consumer an end every call,
    // which is the per-frame end storm this layer exists to remove.
    return new Promise<void>(resolve => {
      if (!merge(legs, resolve)) start(legs, resolve)
    })
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
    // This layer's own writes and a caller's re-entrant write during one must not
    // be eased again.
    if (writing > 0) return shippedMethod.apply(element, args)
    const options = args[0] as ScrollToOptions | number | undefined
    const behavior = typeof options === 'object' && options !== null ? options.behavior : undefined
    const active = settings
    if (active === undefined || wantsInstant()) return shippedMethod.apply(element, args)
    const base = relative
      ? { top: element.scrollTop, left: element.scrollLeft }
      : { top: 0, left: 0 }
    const request = readOffsets(options as ScrollToOptions, base)
    const leg = legFor(element, request.top, request.left)
    // A request that changes nothing still resolves, like the native call.
    if (leg === undefined) return Promise.resolve()
    if (behavior === 'smooth') {
      // One promise per caller, settled with whichever run finishes the travel.
      return new Promise<void>(resolve => {
        if (!merge([leg], resolve)) start([leg], resolve)
      })
    }
    if (!animates(behavior, {
      top: Math.abs(leg.toTop - leg.fromTop),
      left: Math.abs(leg.toLeft - leg.fromLeft),
    })) {
      // Small immediate jumps are layout corrections: they must land now, and the
      // caller may read the position back on the next line.
      shippedMethod.apply(element, args)
      return Promise.resolve()
    }
    // A long immediate jump — a control that sends the viewport to the far end of
    // a document — reads as movement, so it is eased like one.
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
   * The element a scroll event is really about. A viewport scroll reports
   * `document` as its target, while this layer holds the scrolling element it
   * animated.
   * @param target - the event's target.
   * @returns the container to look up, or null.
   */
  function resolveTarget(target: EventTarget | null): ElementLike | null {
    if (target === null) return null
    return target as unknown as ElementLike
  }

  /**
   * Withhold the real end of a scroll this layer is animating, so a consumer sees
   * the single end a native smooth scroll would have produced.
   * @param event - a `scrollend` event.
   */
  function onScrollEnd(event: EventLike): void {
    if (dispatching) return
    const target = resolveTarget(event.target)
    if (target === null) return
    const entry = shadowed.get(target)
    if (entry === undefined) return
    if (entry.until === Number.POSITIVE_INFINITY) {
      event.stopImmediatePropagation()
      return
    }
    // An end owed for the run's final write arrives while the container is still
    // where the run left it. Anything that moved it since belongs to a later
    // scroll, and is released even inside the deadline.
    const unmoved = Math.abs(target.scrollTop - entry.top) <= FOREIGN_TOLERANCE
      && Math.abs(target.scrollLeft - entry.left) <= FOREIGN_TOLERANCE
    if (!unmoved || performance.now() > entry.until) {
      shadowed.delete(target)
      graceful.delete(target)
      return
    }
    event.stopImmediatePropagation()
  }

  /**
   * Bubble adapter for the wheel path.
   *
   * Bubble, not capture: several places in the app handle wheel before the
   * viewport gets it — the draft editor forwards a notch to the transcript when
   * it is already at its own edge, a width handle turns one into a resize scroll
   * — and those handlers register on the element. Running last lets them claim
   * the notch first; `defaultPrevented` is then the answer to "is this mine".
   * @param event - the wheel event.
   */
  function onWheelBubble(event: WheelLike): void {
    // A notch another handler already claimed still means the reader is scrolling,
    // so a run on that container stops either way; only taking the notch is gated.
    cancelIfOwned(event.target)
    if (event.defaultPrevented) return
    onWheel(event)
  }

  /**
   * Reader input ends the scripted run before the browser processes it, so its
   * own scrolling starts from where this layer stopped.
   * @param event - the candidate takeover event.
   */
  /**
   * Stop a run when reader input lands on a container it is moving.
   *
   * One over a side panel is somebody else's scrollport and must not stop the
   * run, and a key only scrolls when focus is not in a field that consumes it.
   *
   * @param target - the event target.
   * @returns whether this input belongs to the run and was stopped.
   */
  function cancelIfOwned(target: EventTarget | null): boolean {
    const active = run
    for (const [element, glide] of followGlides) {
      if (target !== null && element.contains(target)) {
        window.cancelAnimationFrame(glide.frame)
        followGlides.delete(element)
        release(element, true)
      }
    }
    if (active === undefined || target === null) return false
    if (!active.legs.some(leg => leg.element.contains(target))) return false
    cancel()
    return true
  }

  /** Route a non-wheel takeover event through the shared cancellation test. */
  function onTakeover(event: EventLike): void {
    const key = event.type === 'keydown'
    if (key) {
      // Keys scroll whatever has focus, so they are not matched against the run's
      // containers — but a field that consumes the key does not scroll at all.
      if (event.key === undefined || !SCROLL_KEYS.has(event.key)) return
      const focus = event.target
      if (focus instanceof Element && focus.closest(EDITABLE) !== null) return
    }
    if (run === undefined) {
      // No run to stop, but an end still owed for the last one must not be
      // withheld from the scroll this input is about to start.
      clearGrace()
      return
    }
    if (key) cancel()
    else cancelIfOwned(event.target)
  }

  /**
   * Whether the prototypes still hold this layer's own functions. A second
   * instance, or a hot reload that installed a replacement before this one was
   * uninstalled, leaves someone else's wrappers in place; writing back a captured
   * `shipped` then would strand the page on a wrapper with no listener behind it.
   * @returns whether every patched method is ours.
   */
  function ownsPatches(): boolean {
    const prototype = Element.prototype as unknown as Record<string, unknown>
    return prototype.scrollTo === scrollTo
      && prototype.scrollBy === scrollBy
      && prototype.scrollIntoView === scrollIntoView
  }

  /** Install the patches and the listeners. */
  function install(): void {
    if (installed) return
    const current = Element.prototype as unknown as Record<string, unknown>
    if (current.scrollTo !== shipped.scrollTo || current.scrollIntoView !== shipped.scrollIntoView) {
      // Reported rather than layered on top: patching a patched prototype would
      // chain two layers and neither could restore the real methods.
      console.error('ui-experience: scroll methods were already replaced when the motion layer started; '
        + 'scripted scrolling is left off until the page reloads')
      return
    }
    installed = true
    const prototype = Element.prototype as unknown as Record<string, unknown>
    prototype.scrollTo = scrollTo
    prototype.scrollBy = scrollBy
    prototype.scrollIntoView = scrollIntoView
    // The transcript follows with `scrollTop = floor`, not with a method call, so
    // that one write is the only way to reach the streaming tail. The setter below
    // glides it; everything else passes straight through to the real accessor.
    if (topAxis !== undefined) {
      Object.defineProperty(Element.prototype, 'scrollTop', {
        configurable: true,
        enumerable: topAxis.enumerable,
        get: topAxis.get,
        set(this: ElementLike, value: number) {
          if (writing > 0 || !isFollowWrite(this, value)) {
            topAxis.set.call(this, value)
            return
          }
          startFollow(this, value)
        },
      })
    }
    // Capture on the window reaches the scroller before any listener the consumer
    // registered, whether it listens on the element or on the window.
    window.addEventListener('scrollend', onScrollEnd, true)
    // Non-passive and bubbling: a taken notch has to cancel the browser's own
    // scroll, and every handler closer to the target gets its turn first.
    ;(window.addEventListener as (kind: string, listener: unknown, capture: unknown) => void)(
      'wheel', onWheelBubble, { capture: false, passive: false },
    )
    for (const kind of ['touchstart', 'keydown'] as const) {
      window.addEventListener(kind, onTakeover, { capture: true, passive: true })
    }
  }

  /** Remove the patches and the listeners, and stop any run in flight. */
  function uninstall(): void {
    cancel(false)
    clearGrace()
    if (!installed) return
    installed = false
    if (!ownsPatches()) {
      console.error('ui-experience: the scroll methods were replaced while scripted scrolling was active; '
        + 'leaving the current implementations in place instead of restoring stale ones')
      return
    }
    stopFollows()
    const prototype = Element.prototype as unknown as Record<string, unknown>
    prototype.scrollTo = shipped.scrollTo
    prototype.scrollBy = shipped.scrollBy
    prototype.scrollIntoView = shipped.scrollIntoView
    if (topAxis !== undefined) {
      Object.defineProperty(Element.prototype, 'scrollTop', {
        configurable: true,
        enumerable: topAxis.enumerable,
        get: topAxis.get,
        set: topAxis.set,
      })
    }
    window.removeEventListener('scrollend', onScrollEnd, true)
    ;(window.removeEventListener as (kind: string, listener: unknown, capture: unknown) => void)(
      'wheel', onWheelBubble, false,
    )
    for (const kind of ['touchstart', 'keydown'] as const) {
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
    restore(): void {
      uninstall()
      settings = undefined
    },
  }
}
