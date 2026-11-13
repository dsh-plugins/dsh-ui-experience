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

/** How long a new row takes to settle in. */
const ENTER_BASE_MS = 220

/**
 * Elements that carry live text.
 *
 * `AssistantMarkdown` puts `data-streaming` on its root while a message is being
 * produced; `ReasoningRow` puts it on the one-line summary; and every live label in
 * the work steps — a process group title, the running status — goes through
 * `TextShimmer`, which marks its root with `data-shimmer` while it is animating.
 */
const LIVE = '[data-streaming], [data-shimmer]'

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
const REVEAL_MIN_MS = 250
const REVEAL_MAX_MS = 1200
const REVEAL_CURVE = 36.8
const REVEAL_EXPONENT = 0.62

/**
 * How long a label's appended text takes to fade in, before the configured
 * multiplier.
 */
const APPEND_BASE_MS = 240

/** How long a live label's roll takes before the configured multiplier. */
const ROLL_BASE_MS = 260

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
    #000 calc(var(--dsh-uix-reveal) - 0.6lh),
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

/* Appended text arrives from a horizontal edge that sits where the previous text
   ended. Only the new characters cross it, so nothing the reader has already read
   moves. */
[${STREAM_ATTRIBUTE}="roll"][data-dsh-uix-appending] > * {
  --dsh-uix-append-to: var(--dsh-uix-append-end, 100%);
  animation: dsh-uix-append var(--dsh-uix-append-ms, 240ms) var(--dsh-uix-ease, ease) both;
}

@keyframes dsh-uix-append {
  from { mask-image: linear-gradient(to right, #000 var(--dsh-uix-append), transparent calc(var(--dsh-uix-append) + 2ch)); }
  to { mask-image: linear-gradient(to right, #000 var(--dsh-uix-append-to), transparent calc(var(--dsh-uix-append-to) + 2ch)); }
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
  [${STREAM_ATTRIBUTE}="roll"][data-dsh-uix-appending] > * {
    animation: none;
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
    setEnd(node: unknown, offset: number): void
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
  let rollMs = ROLL_BASE_MS
  let enterMs = ENTER_BASE_MS
  let appendMs = APPEND_BASE_MS
  /**
   * Per-element run counter. Every start bumps it; a timer only clears the marks if
   * it still owns the current generation. Without this, the timeout left by an
   * earlier update fires mid-animation and strips the attributes the new one just
   * set, which is what made an append look like a roll on alternate updates.
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
   * Two signals, both the application's own. A `TextShimmer` root
   * (`data-shimmer`) is only ever used for a live inline label, never for a
   * paragraph. A `data-streaming` element is a label when it is `nowrap` — the
   * reasoning summary — and the body otherwise.
   *
   * Height cannot be used: a body sizes itself to its content, so its scroll height
   * equals its client height exactly like a one-line label's does.
   *
   * @param element - the live element.
   * @returns whether it should roll instead of reveal.
   */
  function isLabel(element: ElementLike): boolean {
    if (element.hasAttribute('data-shimmer')) return true
    return window.getComputedStyle(element).whiteSpace === 'nowrap'
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
    return element.scrollHeight + lineHeight
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
    const shaped = REVEAL_CURVE * Math.pow(Math.max(1, gap), REVEAL_EXPONENT)
    const bounded = Math.min(REVEAL_MAX_MS, Math.max(REVEAL_MIN_MS, shaped)) * active.durationScale
    return active.quantize ? quantizeMs(bounded) : bounded
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
   * The rendered width of an element's text.
   *
   * A Range measures what the browser actually laid out, so the append boundary
   * lands on a real glyph edge without splitting any text node. Character counting
   * was tried instead and abandoned: the DOM interleaves whitespace nodes with the
   * text, so an offset in the normalized string does not address the node the
   * caller means.
   *
   * @param element - the label.
   * @returns the width in pixels, or 0 when it cannot be measured.
   */
  function textWidth(element: ElementLike): number {
    const range = document.createRange()
    range.selectNodeContents(element as unknown as Node)
    return range.getBoundingClientRect().width
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
    element.removeAttribute('data-dsh-uix-appending')
    element.setAttribute('data-dsh-uix-prev', before)
    element.removeAttribute('data-dsh-uix-rolling')
    void element.scrollHeight
    element.setAttribute('data-dsh-uix-rolling', '')
    window.setTimeout(() => {
      retire(element, run, ['data-dsh-uix-rolling', 'data-dsh-uix-prev'])
    }, rollMs)
  }

  /**
   * Reveal only the text appended since the previous update.
   *
   * The work-step labels grow by appending — "A", then "A, B", then "A, B, C" — so
   * sliding the whole line out and back in re-animates text the reader has already
   * read. Instead a horizontal mask edge sits where the old text ended and sweeps
   * right, so only the new characters arrive, one after another.
   *
   * A replacement rather than an append has nothing to preserve, and keeps the
   * vertical roll.
   *
   * @param element - the label.
   * @param previous - the text it showed before this update, whitespace-normalized.
   * @param previousWidth - rendered width of that text, in pixels.
   */
  function append(element: ElementLike, previous: string, label: boolean): void {
    const now = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
    element.setAttribute(LAST_ATTRIBUTE, now)
    if (previous === '' || previous === now) return
    const full = textWidth(element)
    element.setAttribute(WIDTH_ATTRIBUTE, String(full))

    // How much of the new text the reader has already seen. A label that grows by
    // appending shares its whole previous text; a detail that slides its window
    // shares only a suffix-length prefix. Measuring the shared prefix covers both,
    // so the sweep starts at the first character that actually changed instead of
    // replaying the line.
    const shared = commonPrefix(previous, now)
    const ratio = now.length === 0 ? 1 : shared / now.length
    if (full <= 1) return

    // A one-line label never rolls: the same text scrolling out and back in reads as
    // the row sliding rather than as new text arriving, because a step label changes
    // by growing. The multi-line reasoning summary is the opposite case — it stands
    // for a whole paragraph, so when its line is replaced rather than extended there
    // is no shared prefix and the vertical roll is the honest motion.
    if (!label && ratio < 0.999) {
      roll(element, previous)
      return
    }

    const run = nextGeneration(element)
    element.removeAttribute('data-dsh-uix-rolling')
    element.removeAttribute('data-dsh-uix-prev')
    element.style.setProperty('--dsh-uix-append', `${Math.round(full * ratio)}px`)
    element.style.setProperty('--dsh-uix-append-end', `${Math.round(full)}px`)
    element.removeAttribute('data-dsh-uix-appending')
    void element.scrollHeight
    element.setAttribute('data-dsh-uix-appending', '')
    window.setTimeout(() => {
      retire(element, run, ['data-dsh-uix-appending'])
    }, appendMs)
  }

  /**
   * Length of the prefix two strings share.
   * @param left - the older text.
   * @param right - the newer text.
   * @returns the shared character count.
   */
  function commonPrefix(left: string, right: string): number {
    const limit = Math.min(left.length, right.length)
    let index = 0
    while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1
    return index
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
    const clear = (): void => {
      element.style.removeProperty('--dsh-uix-reveal')
      element.style.removeProperty('--dsh-uix-tilt')
      element.style.removeProperty('transition')
    }
    if (immediately || state === undefined) {
      clear()
      return
    }
    element.style.setProperty('--dsh-uix-reveal', `${state.target + element.scrollHeight}px`)
    window.setTimeout(clear, REVEAL_MAX_MS)
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
      const mode = isLabel(element) ? 'roll' : 'reveal'
      const marked = element.getAttribute(STREAM_ATTRIBUTE)
      if (marked !== mode) {
        if (marked !== null) forget(element, true)
        if (mode === 'roll') {
          // A label starts by showing what it currently says; only the next change
          // has a previous line to roll out.
          element.setAttribute(LAST_ATTRIBUTE, (element.textContent ?? '').replace(/\s+/g, ' ').trim())
          element.setAttribute(WIDTH_ATTRIBUTE, String(textWidth(element)))
        } else {
          // A body first seen mid-stream already shows what arrived before this
          // layer started watching; revealing that from zero would blank a message
          // the reader is looking at.
          const height = element.scrollHeight
          reveals.set(element, { current: height, from: height, target: height, frame: 0, started: 0, duration: 0 })
        }
        element.setAttribute(STREAM_ATTRIBUTE, mode)
      }
      if (mode !== 'roll') continue
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
      const previous = element.getAttribute(LAST_ATTRIBUTE) ?? ''
      if (previous !== text) append(element, previous, element.hasAttribute('data-shimmer'))
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
      const scaled = ROLL_BASE_MS * next.durationScale
      rollMs = next.quantize ? quantizeMs(scaled) : scaled
      document.documentElement.style.setProperty('--dsh-uix-ease', ease)
      document.documentElement.style.setProperty('--dsh-uix-roll', `${rollMs}ms`)
      const scaledEnter = ENTER_BASE_MS * next.durationScale
      enterMs = next.quantize ? quantizeMs(scaledEnter) : scaledEnter
      document.documentElement.style.setProperty('--dsh-uix-enter', `${enterMs}ms`)
      const scaledAppend = APPEND_BASE_MS * next.durationScale
      appendMs = next.quantize ? quantizeMs(scaledAppend) : scaledAppend
      document.documentElement.style.setProperty('--dsh-uix-append-ms', `${appendMs}ms`)
      install()
    },
    restore: uninstall,
  }
}
