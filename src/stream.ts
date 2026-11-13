/**
 * Streaming output motion: the transcript reveals its text character by
 * character, and every live one-line label in the work steps rolls its previous
 * line out when the text behind it changes.
 *
 * WHY THIS ONLY TOUCHES THE VISUAL LAYER
 *
 * The obvious implementation — cut a text node down to the first N characters and
 * grow N over time — changes what React owns. React would keep issuing the full
 * string, the two would fight, and in the meantime selection, copying, and
 * assistive technology would all read a truncated transcript.
 *
 * So the text is never truncated. Every character stays in the DOM from the moment
 * the model produces it, and only a `mask-image` moves. Layout is therefore final
 * the instant a chunk arrives, and the animation cannot disagree with it.
 *
 * CHARACTER GRANULARITY, WITHOUT SPLITTING TEXT
 *
 * A horizontal reveal line can only advance a whole line at a time, which reads as
 * a line flashing in rather than as typing. Tilting the line solves that: with the
 * mask tilted so that it falls exactly one line height across the element's width,
 * the boundary crosses one line from start to end while it descends by that same
 * line height. Exactly one line is partly revealed at any moment, and characters
 * within it appear left to right.
 *
 * The tilt is derived per element from its width and line height, so a narrow
 * panel gets the same character-level sweep a wide one does.
 *
 * The reveal is driven by a transition on a registered custom property, so it runs
 * off the main thread. This layer only computes a duration each time text arrives
 * — a function of how far behind the reveal is — which is the flow smoothing: a
 * burst of output gives a faster catch-up, a trickle gives a slow crawl.
 */

import { type MotionSettings } from './shared.ts'
import { easeCurve, effectCurvePoints, quantizeMs } from './motion-plan.ts'

/** The attribute this layer writes to mark what it is animating. */
const STREAM_ATTRIBUTE = 'data-dsh-uix-stream'

/** Remembers the text an element showed before its current update. */
const LAST_ATTRIBUTE = 'data-dsh-uix-last'

/** Remembers how wide that text was, so an append knows where to start. */
const WIDTH_ATTRIBUTE = 'data-dsh-uix-width'

/** How long a label's appended text takes to arrive, before the configured scale. */
const APPEND_BASE_MS = 260

/** Marks a row this layer is unveiling after it was inserted. */
const ENTER_ATTRIBUTE = 'data-dsh-uix-enter'

/**
 * Rows the transcript appends while it is following its tail.
 *
 * A row enters by fading and rising a couple of pixels. `transform` and `opacity`
 * do not touch layout, which matters more than it looks: the transcript writes the
 * scroll position and then reads it straight back to record where it landed
 * (`use-chat-viewport.ts` `write`), so any entrance that changed height would make
 * that read-back disagree with what was asked for, and the follow loop would decide
 * it had been pushed off the bottom. Keeping the entrance to the compositor keeps
 * the read-back exact.
 */
const ROW = '[data-chat-flow-kind], [data-chat-anchor-key], [data-submission-echo], [data-pending-steering]'

/** Fallbacks used only until `apply` supplies the configured values. */
const ENTER_FALLBACK_MS = 220

/**
 * Elements that carry live text this layer animates.
 *
 * Only `data-streaming` is used. The work-step labels — a process group title, the
 * running-status line with its elapsed timer — go through `TextShimmer`, which
 * already animates them with its own sweep and marks its root `data-shimmer`.
 * Painting a second mask over those roots was wrong twice: it covered the
 * decoration layer `TextShimmer` draws the sweep into, so the label flickered, and
 * the elapsed-time label ticks once a second, which is not an arrival worth
 * animating at all.
 */
const LIVE = '[data-streaming], [data-process-activity] [data-shimmer]'

/**
 * Reasons a live element is animated.
 *
 * - `reveal`: multi-line prose, uncovered by a descending mask line.
 * - `roll`: a one-line summary whose content is replaced wholesale.
 * - `append`: a one-line work-step label, which grows by appending. Only the added
 *   characters are revealed, so the text a reader has already read stays put.
 */
type Mode = 'reveal' | 'roll' | 'append'

/**
 * Reveal distance below which a new position is written without a transition.
 *
 * Deliberately tiny: chunks usually add only a few pixels, and skipping those
 * would make every small arrival snap — which is exactly the line-at-a-time look
 * this layer exists to remove. Retargeting an in-flight transition on every chunk
 * is what keeps the reveal continuous.
 */
const MIN_REVEAL_PX = 0.5

/**
 * Reveal duration for a backlog, in milliseconds.
 *
 * The exponent is what makes this catch up rather than crawl: duration grows more
 * slowly than the distance, so the reveal speed — gap over duration — rises with
 * the backlog.
 *
 * The floor is the visible buffer. One line takes about 250 ms, ten lines about
 * 1 s, and a whole block landing at once is capped at 1.2 s — so a normal streaming
 * rate keeps roughly a line or two of unread text behind the boundary, and a burst
 * is absorbed into a longer run instead of being skipped. A shorter floor than this
 * makes each arrival finish before the eye registers it, which reads as no animation
 * at all.
 */
const REVEAL_EXPONENT = 0.62

/** One line of body text, the unit the configured floor is expressed in. */
const ONE_LINE_PX = 24

/** Height of the mask's trailing fade, in line heights. */
const FADE_BAND = 0.45

/** Steepest tilt allowed, so a very narrow box does not become a vertical wipe. */
const MAX_TILT_DEG = 30

/** One element's reveal state. */
interface Reveal {
  /** Reveal position currently painted. */
  current: number
  /** Where the boundary started for the run in flight. */
  from: number
  /** Reveal position the element reaches with this chunk. */
  target: number
  /** The run in flight, or 0. */
  frame: number
  started: number
  duration: number
}

/**
 * The stylesheet this layer installs.
 *
 * `@property` is what makes the reveal animatable: an unregistered custom property
 * is an opaque string, and a string cannot be interpolated. Registering it as a
 * length lets the transition — and therefore the compositor — do the work instead
 * of a per-frame script.
 */
const STREAM_CSS = `
@property --dsh-uix-reveal {
  syntax: '<length>';
  inherits: false;
  initial-value: 0px;
}

@property --dsh-uix-edge {
  syntax: '<length>';
  inherits: false;
  initial-value: 0px;
}

@property --dsh-uix-tilt {
  syntax: '<angle>';
  inherits: false;
  initial-value: 180deg;
}

/* The mask is a tilted reveal line with a soft trailing edge, so text arrives out
   of a gradient rather than at a hard boundary. The tilt makes it fall one line
   height across the width, which is what gives character granularity. */
[${STREAM_ATTRIBUTE}="reveal"] {
  --dsh-uix-reveal: 0px;
  mask-image: linear-gradient(
    var(--dsh-uix-tilt),
    #000 calc(var(--dsh-uix-reveal) - ${FADE_BAND}lh),
    transparent var(--dsh-uix-reveal)
  );
  mask-size: 100% 100%;
  mask-repeat: no-repeat;
}

/* A live one-line label does not reveal; its whole text is replaced at once, so the
   change itself is what has to be animated. The outgoing copy rides a pseudo
   element, which keeps it out of the layout and out of the accessibility tree. */
[${STREAM_ATTRIBUTE}="roll"] {
  position: relative;
  overflow: hidden;
}

}

[${STREAM_ATTRIBUTE}="roll"]::after {
  content: attr(data-dsh-uix-prev);
  position: absolute;
  inset: 0;
  color: inherit;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
}

/* Duration and curve come from the configured family, set as custom properties on
   the root when the layer applies; the literals here are only a fallback. */
[${STREAM_ATTRIBUTE}="roll"][data-dsh-uix-rolling] > * {
  animation: dsh-uix-roll-in var(--dsh-uix-roll, 260ms) var(--dsh-uix-ease, ease) both;
}

/* Appended label text: a horizontal edge sits where the previous text ended and
   sweeps to the new width, so only the added characters arrive. The mask goes on
   the FIRST child alone: TextShimmer renders its readable copy first and its
   decorative sweep second, and masking that second copy is what made these labels
   flicker.

   Keyframing the gradient was tried and does not work: Chrome snaps between the two
   linear-gradients instead of interpolating them, which is why the label appeared to
   jump with no animation at all. The edge is a registered custom property instead,
   and a transition on it drives the mask — the same mechanism the body reveal uses. */
/* A step label arrives as a whole line and slides up into place. Only later growth
   is appended, so the first appearance and every extension read differently: the row
   moving in, then its text extending without the row moving again. */
[${STREAM_ATTRIBUTE}="append"][data-dsh-uix-rolling] > :first-child {
  animation: dsh-uix-roll-in var(--dsh-uix-roll, 260ms) var(--dsh-uix-ease, ease) both;
}

[${STREAM_ATTRIBUTE}="append"] > :first-child {
  --dsh-uix-edge: 100000px;
  mask-image: linear-gradient(
    to right,
    #000 calc(var(--dsh-uix-edge) - 1.2ch),
    transparent var(--dsh-uix-edge)
  );
}

[${STREAM_ATTRIBUTE}="roll"][data-dsh-uix-rolling]::after {
  animation: dsh-uix-roll-out var(--dsh-uix-roll, 260ms) var(--dsh-uix-ease, ease) both;
}

@keyframes dsh-uix-roll-in {
  from { transform: translateY(0.85lh); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

@keyframes dsh-uix-roll-out {
  from { transform: translateY(0); opacity: 1; }
  to { transform: translateY(-0.85lh); opacity: 0; }
}

/* A row that arrives while the transcript is following its tail rises into place.
   Only opacity and transform are animated, so the height the follow loop reads back
   right after its write is the height it asked for. */
[${ENTER_ATTRIBUTE}] {
  animation: dsh-uix-enter var(--dsh-uix-enter, 220ms) var(--dsh-uix-ease, ease) both;
}

@keyframes dsh-uix-enter {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  [${STREAM_ATTRIBUTE}="reveal"] {
    mask-image: none;
  }

  [${ENTER_ATTRIBUTE}] {
    animation: none;
  }

  [${STREAM_ATTRIBUTE}="roll"][data-dsh-uix-rolling] > *,
  [${STREAM_ATTRIBUTE}="roll"][data-dsh-uix-rolling]::after,
  [${STREAM_ATTRIBUTE}="append"][data-dsh-uix-rolling] > :first-child {
    animation: none;
  }

  [${STREAM_ATTRIBUTE}="append"] > :first-child {
    mask-image: none;
  }
}
`

declare const performance: { now(): number }

declare const window: {
  requestAnimationFrame(callback: (time: number) => void): number
  cancelAnimationFrame(handle: number): void
  setTimeout(callback: () => void, delay: number): number
  matchMedia(query: string): { readonly matches: boolean }
  getComputedStyle(element: unknown): {
    readonly whiteSpace: string
    readonly lineHeight: string
    readonly width: string
  }
}

declare const MutationObserver: new (callback: () => void) => {
  observe(target: unknown, options: Record<string, unknown>): void
  disconnect(): void
}

/** The element face this layer measures. */
interface ElementLike {
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  hasAttribute(name: string): boolean
  readonly scrollHeight: number
  readonly clientHeight: number
  readonly clientWidth: number
  readonly firstElementChild: ElementLike | null
  readonly parentElement: ElementLike | null
  readonly style: {
    setProperty(name: string, value: string): void
    removeProperty(name: string): string
    transition: string
  }
  textContent: string | null
  closest(selectors: string): unknown
}

declare const document: {
  querySelectorAll(selectors: string): { readonly length: number; [index: number]: ElementLike | undefined }
  createElement(tag: 'style'): { textContent: string; remove(): void }
  createRange(): {
    selectNodeContents(node: unknown): void
    getBoundingClientRect(): { width: number }
  }
  readonly head: { appendChild(node: unknown): unknown }
  readonly body: unknown
  readonly documentElement: { readonly style: { setProperty(name: string, value: string): void; removeProperty(name: string): string } }
}

/**
 * Build the streaming-output layer. It starts inert; `apply` installs it.
 * @returns the handle the client keeps for the bundle's lifetime.
 */
export function createStreamMotion(): {
  apply(settings: MotionSettings): void
  restore(): void
} {
  const reveals = new Map<ElementLike, Reveal>()
  /** Rows this layer has already seen; anything absent from here is new. */
  let knownRows = new WeakSet<ElementLike>()
  /** Whether the transcript is currently pinned to its tail. */
  let following = false
  let sheet: { textContent: string; remove(): void } | undefined
  let observer: { disconnect(): void; observe(target: unknown, options: Record<string, unknown>): void } | undefined
  let settings: MotionSettings | undefined
  let pending = false
  let installed = false
  let ease = ''
  let rollMs = 260
  let enterMs = ENTER_FALLBACK_MS
  let appendMs = APPEND_BASE_MS
  let revealMinMs = 250
  let revealMaxMs = 1200
  /**
   * Per-element run counter. Every start bumps it; a timer only clears the marks if
   * it still owns the current generation. Without this, the timeout left by an
   * earlier update fires mid-animation and strips the attributes the new one just
   * set, which made alternate updates animate differently from each other.
   */
  const generation = new WeakMap<ElementLike, number>()

  /**
   * Take the next generation for an element.
   * @param element - the element about to animate.
   * @returns its new generation.
   */
  function nextGeneration(element: ElementLike): number {
    const next = (generation.get(element) ?? 0) + 1
    generation.set(element, next)
    return next
  }

  /**
   * Clear one animation's marks, but only if it is still the newest.
   * @param element - the element.
   * @param run - the generation the clearance belongs to.
   * @param attributes - attributes to remove.
   */
  function retire(element: ElementLike, run: number, attributes: readonly string[]): void {
    if (generation.get(element) !== run) return
    for (const attribute of attributes) element.removeAttribute(attribute)
  }

  /** Whether the current policy asks for no motion at all. */
  function still(): boolean {
    const active = settings
    if (active === undefined) return true
    if (active.reduced === 'always') return true
    return active.reduced === 'system' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  /**
   * Whether an element is a one-line label rather than the transcript body.
   *
   * A `data-streaming` element is a label when it is `nowrap` — the reasoning
   * summary — and the body otherwise.
   *
   * Height cannot be used: a body sizes itself to its content, so its scroll height
   * equals its client height exactly like a one-line label's does.
   *
   * @param element - the live element.
   * @returns whether it should roll instead of reveal.
   */
  function modeOf(element: ElementLike): Mode {
    if (element.hasAttribute('data-shimmer')) return 'append'
    return window.getComputedStyle(element).whiteSpace === 'nowrap' ? 'roll' : 'reveal'
  }

  /**
   * The tilt that makes the reveal line fall one line height across the element's
   * width. With that tilt, the boundary sweeps a line left to right exactly while
   * it descends by one line, which is what turns a line-at-a-time reveal into a
   * character-at-a-time one.
   * @param element - the element being revealed.
   * @param lineHeight - its computed line height in pixels.
   * @returns the CSS gradient angle.
   */
  function tiltFor(element: ElementLike, lineHeight: number): string {
    const width = element.clientWidth
    if (width <= 0 || lineHeight <= 0) return '180deg'
    const ratio = Math.min(1, lineHeight / width)
    const tilt = Math.asin(ratio) * 180 / Math.PI
    return `${180 - Math.min(MAX_TILT_DEG, tilt)}deg`
  }

  /**
   * The reveal position at which an element is fully painted. The mask line is
   * tilted, so the far corner is one line height beyond the content height.
   * @param element - the element being revealed.
   * @param lineHeight - its computed line height in pixels.
   * @returns the terminal reveal position in pixels.
   */
  function terminal(element: ElementLike, lineHeight: number): number {
    // The boundary sits at the content edge; the trailing band fades over FADE_BAND
    // line heights above it. Everything below the boundary is hidden, so a line that
    // has just arrived is uncovered from its top down as the boundary descends — and
    // the resting position has to clear the band, or the last line would stay partly
    // transparent forever.
    return element.scrollHeight + lineHeight * FADE_BAND
  }

  /**
   * An element's text, whitespace-normalized, for change detection.
   * @param element - the element.
   * @returns its normalized text.
   */
  function textOf(element: ElementLike): string {
    return (element.textContent ?? '').replace(/\s+/g, ' ').trim()
  }

  /**
   * A label's own text.
   *
   * A `TextShimmer` root contains two copies of its children: the readable one and
   * an inert decorative one it animates a sweep through. Reading `textContent` on
   * the root therefore returns both, concatenated — enough to make any
   * "did the text grow?" comparison fail, because the doubled previous string never
   * prefixes the next update. Only the readable copy is read here.
   *
   * @param element - the live element.
   * @returns its readable text, whitespace-normalized.
   */
  function labelText(element: ElementLike): string {
    if (!element.hasAttribute('data-shimmer')) return textOf(element)
    const content = firstChild(element)
    return content === null ? '' : textOf(content)
  }

  /**
   * Rendered width of a label's real text.
   *
   * `TextShimmer` renders two copies of its children: the readable one, then an
   * inert decorative copy it animates its own sweep through. Only the first child is
   * measured and masked here — masking the decorative copy as well would fight that
   * sweep, which is what made these labels flicker.
   *
   * @param element - the shimmer root.
   * @returns the readable text's width in pixels.
   */
  function contentWidth(element: ElementLike): number {
    const content = firstChild(element)
    if (content === null) return 0
    const range = document.createRange()
    range.selectNodeContents(content)
    return range.getBoundingClientRect().width
  }

  /**
   * The first child element, which for a shimmer is the readable copy.
   * @param element - the parent.
   * @returns the child, or null.
   */
  function firstChild(element: ElementLike): ElementLike | null {
    return element.firstElementChild ?? null
  }

  /**
   * Slide a step label up into place as it arrives.
   * @param element - the shimmer root.
   */
  function enterLabel(element: ElementLike): void {
    const run = nextGeneration(element)
    element.removeAttribute('data-dsh-uix-rolling')
    void element.scrollHeight
    element.setAttribute('data-dsh-uix-rolling', '')
    window.setTimeout(() => { retire(element, run, ['data-dsh-uix-rolling']) }, rollMs)
  }

  /**
   * Reveal only the text a label gained since the previous update.
   *
   * These labels grow by appending — `A`, then `A, B`, then `A, B, C` — so rolling
   * the whole line would re-animate text the reader has already read. Instead a
   * horizontal edge sits where the old text ended and sweeps to the new width, so
   * only the added characters arrive.
   *
   * A change that is not an extension of the previous text has nothing to preserve;
   * it is shown at once rather than rolled, because for a step label the roll reads
   * as the row sliding.
   *
   * @param element - the shimmer root.
   * @param previous - the text before this update.
   * @param previousWidth - rendered width of that text, in pixels.
   */
  function append(element: ElementLike, previous: string, previousWidth: number): void {
    const now = labelText(element)
    const content = firstChild(element)
    if (content === null) return
    const full = contentWidth(element)
    element.setAttribute(WIDTH_ATTRIBUTE, String(full))
    // A change that is not an extension has nothing to preserve; it is shown at once
    // rather than rolled, because for a step label the roll reads as the row sliding.
    if (previous === '' || !now.startsWith(previous) || previousWidth <= 0) return
    if (full <= previousWidth + 1) return
    const run = nextGeneration(element)
    // One motion at a time: the arrival slide shares this element with the append
    // sweep, and leaving its mark set would keep its animation applied for good.
    element.removeAttribute('data-dsh-uix-rolling')
    // Park the edge at the previous width with transitions off, force a style flush,
    // then let the transition carry it to the new width. Without the flush the browser
    // would coalesce both assignments and the sweep would not run.
    content.style.transition = 'none'
    content.style.setProperty('--dsh-uix-edge', `${previousWidth}px`)
    void element.scrollHeight
    content.style.transition = `--dsh-uix-edge ${appendMs}ms ${ease}`
    content.style.setProperty('--dsh-uix-edge', `${full}px`)
    window.setTimeout(() => {
      if (!owns(element, run)) return
      content.style.setProperty('--dsh-uix-edge', '100000px')
      content.style.removeProperty('transition')
    }, appendMs)
  }

  /**
   * Whether a deferred follow-up still owns its element.
   * @param element - the element.
   * @param run - the generation the follow-up belongs to.
   * @returns whether it is still the newest.
   */
  function owns(element: ElementLike, run: number): boolean {
    return generation.get(element) === run
  }

  /**
   * Reveal duration for one backlog. See {@link REVEAL_CURVE}: the exponent makes
   * the speed rise with the backlog, so a burst catches up instead of falling
   * further behind.
   * @param gap - pixels the reveal is behind.
   * @returns the duration in milliseconds.
   */
  function revealDuration(gap: number): number {
    const active = settings as MotionSettings
    // One line takes exactly the configured floor; each further line adds less than
    // the last, because the exponent is below one. That is what makes speed — gap
    // over duration — rise with the backlog instead of holding constant.
    const perLine = revealMinMs / Math.pow(ONE_LINE_PX, REVEAL_EXPONENT)
    const shaped = perLine * Math.pow(Math.max(ONE_LINE_PX, gap), REVEAL_EXPONENT)
    const scaled = Math.min(revealMaxMs, Math.max(revealMinMs, shaped)) * active.durationScale
    return active.quantize ? quantizeMs(scaled) : scaled
  }

  /**
   * Advance one element's reveal to cover what just arrived.
   *
   * The run is retargeted from wherever the boundary currently is, rather than
   * restarted from the last target: a chunk usually arrives while the previous one
   * is still being revealed, and restarting would snap the boundary forward and
   * make the reveal lurch.
   *
   * @param element - the element being revealed.
   * @param state - its reveal state.
   */
  function advance(element: ElementLike, state: Reveal): void {
    const active = settings
    if (active === undefined) return
    const computed = window.getComputedStyle(element)
    const lineHeight = Number.parseFloat(computed.lineHeight)
    const height = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 24
    element.style.setProperty('--dsh-uix-tilt', tiltFor(element, height))
    state.target = terminal(element, height)
    const gap = state.target - state.current
    if (gap < MIN_REVEAL_PX) {
      element.style.setProperty('--dsh-uix-reveal', `${state.target}px`)
      state.current = state.target
      return
    }
    state.from = state.current
    state.started = performance.now()
    state.duration = revealDuration(gap)
    if (state.frame !== 0) return
    const mode = active.mode
    const step = (now: number): void => {
      const live = reveals.get(element)
      if (live === undefined || live !== state) return
      const progress = Math.min(1, (now - state.started) / Math.max(1, state.duration))
      const eased = easeCurve(effectCurvePoints(mode), progress)
      state.current = state.from + (state.target - state.from) * eased
      element.style.setProperty('--dsh-uix-reveal', `${state.current}px`)
      if (progress >= 1) {
        state.frame = 0
        state.current = state.target
        element.style.setProperty('--dsh-uix-reveal', `${state.target}px`)
        return
      }
      state.frame = window.requestAnimationFrame(step)
    }
    state.frame = window.requestAnimationFrame(step)
  }


  /**
   * Roll a live label: the line it showed before this update leaves upward while
   * the new one arrives from below. Used when the text was replaced rather than
   * extended, so there is no prefix worth preserving.
   * @param element - the label.
   * @param previous - the text it showed before this update.
   */
  function roll(element: ElementLike, previous: string): void {
    const before = previous.replace(/\s+/g, ' ').trim()
    const now = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (before === '' || before === now) return
    const run = nextGeneration(element)
    // One animation at a time: the sweep and the roll share the element, and leaving
    // the other one's mark in place makes both play at once.
    element.setAttribute('data-dsh-uix-prev', before)
    element.removeAttribute('data-dsh-uix-rolling')
    void element.scrollHeight
    element.setAttribute('data-dsh-uix-rolling', '')
    window.setTimeout(() => {
      retire(element, run, ['data-dsh-uix-rolling', 'data-dsh-uix-prev'])
    }, rollMs)
  }

  /**
   * Drop every mark this layer put on one element and hand it back untouched.
   *
   * The reveal is first moved past the content, which is the position at which the
   * mask paints everything: removing it outright would snap the faded last line to
   * full colour in one frame. The transition carries that last step, and only then
   * does the mask go away.
   *
   * @param element - the element to release.
   * @param immediately - skip the settling step, for teardown.
   */
  function forget(element: ElementLike, immediately = false): void {
    const state = reveals.get(element)
    reveals.delete(element)
    element.removeAttribute(STREAM_ATTRIBUTE)
    element.removeAttribute(LAST_ATTRIBUTE)
    element.removeAttribute(WIDTH_ATTRIBUTE)
    element.removeAttribute('data-dsh-uix-prev')
    element.removeAttribute('data-dsh-uix-rolling')
    const content = firstChild(element)
    const clear = (): void => {
      element.style.removeProperty('--dsh-uix-reveal')
      element.style.removeProperty('--dsh-uix-tilt')
      element.style.removeProperty('transition')
      content?.style.removeProperty('--dsh-uix-edge')
      content?.style.removeProperty('transition')
    }
    if (immediately || state === undefined) {
      clear()
      return
    }
    element.style.setProperty('--dsh-uix-reveal', `${state.target + element.scrollHeight}px`)
    window.setTimeout(clear, revealMaxMs)
  }

  /** Re-measure every live element that still exists. */
  function measure(): void {
    pending = false
    const active = settings
    if (active === undefined || active.mode === 'off' || still()) return
    const marked = document.querySelectorAll(`[${STREAM_ATTRIBUTE}]`)
    for (let index = 0; index < marked.length; index += 1) {
      const element = marked[index]
      if (element === undefined) continue
      if (element.getAttribute(STREAM_ATTRIBUTE) !== 'reveal') continue
      const state = reveals.get(element)
      if (state === undefined) continue
      advance(element, state)
    }
  }

  /** Schedule one measurement on the next frame, coalescing a burst into one. */
  function schedule(): void {
    if (pending) return
    pending = true
    window.requestAnimationFrame(measure)
  }

  /**
   * Whether this label is already covered by an ancestor this layer marks.
   *
   * The reasoning summary is a `nowrap` element that contains a `TextShimmer`, so
   * both are live: marking each would animate the same line twice.
   *
   * @param element - the candidate.
   * @returns whether an ancestor is already marked.
   */
  function covered(element: ElementLike): boolean {
    let node = element.parentElement
    while (node !== null) {
      if (node.hasAttribute(STREAM_ATTRIBUTE)) return true
      node = node.parentElement
    }
    return false
  }

  /**
   * Mark newly live elements and release the ones that stopped.
   *
   * This runs on every mutation batch, so it does the cheapest thing that works: a
   * single selector query, and a write only where the state actually changed.
   */
  function mark(): void {
    const active = settings
    if (active === undefined || active.mode === 'off' || still()) return
    const live = document.querySelectorAll(LIVE)
    const seen = new Set<ElementLike>()
    for (let index = 0; index < live.length; index += 1) {
      const element = live[index]
      if (element === undefined || covered(element)) continue
      seen.add(element)
      const mode = modeOf(element)
      const marked = element.getAttribute(STREAM_ATTRIBUTE)
      if (marked !== mode) {
        if (marked !== null) forget(element, true)
        if (mode === 'reveal') {
          // A body first seen mid-stream already shows what arrived before this
          // layer started watching; revealing that from zero would blank a message
          // the reader is looking at.
          const height = element.scrollHeight
          reveals.set(element, { current: height, from: height, target: height, frame: 0, started: 0, duration: 0 })
        } else {
          // Record what the label says now, then slide it in: the row arriving is the
          // one moment worth animating vertically, and every later change is an
          // append that must leave the row itself still.
          element.setAttribute(LAST_ATTRIBUTE, labelText(element))
          element.setAttribute(WIDTH_ATTRIBUTE, String(contentWidth(element)))
          if (mode === 'append') enterLabel(element)
        }
        element.setAttribute(STREAM_ATTRIBUTE, mode)
      }
      if (mode === 'reveal') continue
      const text = labelText(element)
      const previous = element.getAttribute(LAST_ATTRIBUTE) ?? ''
      if (previous === text) continue
      const previousWidth = Number.parseFloat(element.getAttribute(WIDTH_ATTRIBUTE) ?? '0')
      element.setAttribute(LAST_ATTRIBUTE, text)
      if (mode === 'roll') roll(element, previous)
      else append(element, previous, Number.isFinite(previousWidth) ? previousWidth : 0)
    }
    unveil()
    // Anything still marked but no longer live has finished.
    const marked = document.querySelectorAll(`[${STREAM_ATTRIBUTE}]`)
    for (let index = 0; index < marked.length; index += 1) {
      const element = marked[index]
      if (element === undefined || seen.has(element)) continue
      forget(element)
    }
    schedule()
  }

  /**
   * Whether the transcript is following its tail right now.
   *
   * `ChatView` sets `data-chat-following-tail` on its root exactly while the reader
   * is pinned, so the answer is the application's own rather than a guess from
   * scroll geometry.
   * @returns whether new rows should be unveiled.
   */
  function atTail(): boolean {
    return document.querySelectorAll('[data-chat-following-tail]').length > 0
  }

  /**
   * Unveil rows that were inserted since the last pass, while the transcript is
   * following its tail.
   *
   * A row that arrives because the reader scrolled somewhere, or a row that
   * replaces a collapsed block, is not a new arrival at the tail and must not move.
   */
  function unveil(): void {
    const rows = document.querySelectorAll(ROW)
    if (rows.length === 0) return
    const pinned = atTail()
    const next = new WeakSet<ElementLike>()
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      if (row === undefined) continue
      next.add(row)
      if (knownRows.has(row)) continue
      if (!pinned || !following) continue
      row.setAttribute(ENTER_ATTRIBUTE, '')
      window.setTimeout(() => { row.removeAttribute(ENTER_ATTRIBUTE) }, enterMs)
    }
    knownRows = next
    following = pinned
  }

  /** Install the sheet and the observer. */
  function install(): void {
    if (installed) return
    installed = true
    sheet = document.createElement('style')
    sheet.textContent = STREAM_CSS
    document.head.appendChild(sheet)
    observer = new MutationObserver(() => { mark() })
    observer.observe(document.body as ElementLike, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-streaming', 'data-shimmer'],
    })
    // Seed: whatever is already on screen is not new.
    const existing = document.querySelectorAll(ROW)
    for (let index = 0; index < existing.length; index += 1) {
      const row = existing[index]
      if (row !== undefined) knownRows.add(row)
    }
    following = atTail()
    mark()
  }

  /** Remove the sheet, the observer, and every mark this layer wrote. */
  function uninstall(): void {
    observer?.disconnect()
    observer = undefined
    sheet?.remove()
    sheet = undefined
    installed = false
    document.documentElement.style.removeProperty('--dsh-uix-ease')
    document.documentElement.style.removeProperty('--dsh-uix-roll')
    document.documentElement.style.removeProperty('--dsh-uix-enter')
    document.documentElement.style.removeProperty('--dsh-uix-append-ms')
    const entering = document.querySelectorAll(`[${ENTER_ATTRIBUTE}]`)
    for (let index = 0; index < entering.length; index += 1) {
      entering[index]?.removeAttribute(ENTER_ATTRIBUTE)
    }
    const marked = document.querySelectorAll(`[${STREAM_ATTRIBUTE}]`)
    for (let index = 0; index < marked.length; index += 1) {
      const element = marked[index]
      if (element !== undefined) forget(element, true)
    }
    reveals.clear()
  }

  return {
    apply(next: MotionSettings): void {
      uninstall()
      settings = next
      if (next.mode === 'off' || !next.stream) return
      if (next.reduced === 'system' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      // Both the reveal transition and the label roll read the configured family,
      // so switching M3 / M3E or the duration multiplier reaches the stream layer
      // the same way it reaches every rewritten rule.
      ease = `cubic-bezier(${effectCurvePoints(next.mode).join(', ')})`
      const scaled = next.streamRollMs * next.durationScale
      rollMs = next.quantize ? quantizeMs(scaled) : scaled
      document.documentElement.style.setProperty('--dsh-uix-ease', ease)
      document.documentElement.style.setProperty('--dsh-uix-roll', `${rollMs}ms`)
      const scaledEnter = next.streamEnterMs * next.durationScale
      enterMs = next.quantize ? quantizeMs(scaledEnter) : scaledEnter
      const scaledAppend = APPEND_BASE_MS * next.durationScale
      appendMs = next.quantize ? quantizeMs(scaledAppend) : scaledAppend
      document.documentElement.style.setProperty('--dsh-uix-append-ms', `${appendMs}ms`)
      revealMinMs = next.streamRevealMinMs
      revealMaxMs = next.streamRevealMaxMs
      document.documentElement.style.setProperty('--dsh-uix-enter', `${enterMs}ms`)
      install()
    },
    restore: uninstall,
  }
}
