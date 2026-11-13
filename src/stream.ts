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

/** The attribute this layer writes to mark what it is animating. */
const STREAM_ATTRIBUTE = 'data-dsh-uix-stream'

/** Remembers the text an element showed before its current update. */
const LAST_ATTRIBUTE = 'data-dsh-uix-last'

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

/** Reveal transition bounds, in milliseconds. */
const MIN_REVEAL_MS = 90
const MAX_REVEAL_MS = 480

/**
 * Reveal speed the duration is derived from, in CSS pixels per millisecond of
 * catch-up. Roughly one line every 40 ms reads as typing without feeling behind.
 */
const REVEAL_PX_PER_MS = 0.55

/** How long a live label's roll takes. */
const ROLL_MS = 260

/** Steepest tilt allowed, so a very narrow box does not become a vertical wipe. */
const MAX_TILT_DEG = 30

/** One element's reveal state. */
interface Reveal {
  /** Reveal position the element had when the last chunk landed. */
  shown: number
  /** Reveal position the element reaches with this chunk. */
  target: number
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

[${STREAM_ATTRIBUTE}="roll"]::after {
  content: attr(data-dsh-uix-prev);
  position: absolute;
  inset: 0;
  color: inherit;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
}

[${STREAM_ATTRIBUTE}="roll"][data-dsh-uix-rolling] > * {
  animation: dsh-uix-roll-in ${ROLL_MS}ms var(--dsh-uix-ease, cubic-bezier(0.34, 0.8, 0.34, 1)) both;
}

[${STREAM_ATTRIBUTE}="roll"][data-dsh-uix-rolling]::after {
  animation: dsh-uix-roll-out ${ROLL_MS}ms var(--dsh-uix-ease, cubic-bezier(0.34, 0.8, 0.34, 1)) both;
}

@keyframes dsh-uix-roll-in {
  from { transform: translateY(0.85lh); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

@keyframes dsh-uix-roll-out {
  from { transform: translateY(0); opacity: 1; }
  to { transform: translateY(-0.85lh); opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  [${STREAM_ATTRIBUTE}="reveal"] {
    mask-image: none;
  }

  [${STREAM_ATTRIBUTE}="roll"][data-dsh-uix-rolling] > *,
  [${STREAM_ATTRIBUTE}="roll"][data-dsh-uix-rolling]::after {
    animation: none;
  }
}
`

declare const document: {
  querySelectorAll(selectors: string): { readonly length: number; [index: number]: ElementLike | undefined }
  createElement(tag: 'style'): { textContent: string; remove(): void }
  readonly head: { appendChild(node: unknown): unknown }
  readonly body: unknown
}

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

/**
 * Build the streaming-output layer. It starts inert; `apply` installs it.
 * @returns the handle the client keeps for the bundle's lifetime.
 */
export function createStreamMotion(): {
  apply(settings: MotionSettings): void
  restore(): void
} {
  const reveals = new Map<ElementLike, Reveal>()
  let sheet: { textContent: string; remove(): void } | undefined
  let observer: { disconnect(): void; observe(target: unknown, options: Record<string, unknown>): void } | undefined
  let settings: MotionSettings | undefined
  let pending = false
  let installed = false
  let ease = ''

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
   * The reveal transition for one catch-up distance. Short distance, gentle
   * duration; long distance, faster — which is the flow smoothing: the reader
   * never waits for a long tail, and a slow model never looks rushed.
   * @param gap - pixels the reveal is behind.
   * @param scale - the configured duration multiplier.
   * @returns the duration in milliseconds.
   */
  function revealDuration(gap: number, scale: number): number {
    const raw = gap / REVEAL_PX_PER_MS
    return Math.min(MAX_REVEAL_MS, Math.max(MIN_REVEAL_MS, raw * scale))
  }

  /**
   * Advance one element's reveal to cover what just arrived.
   * @param element - the element being revealed.
   * @param state - its reveal state.
   */
  function advance(element: ElementLike, state: Reveal): void {
    const active = settings
    if (active === undefined) return
    const computed = window.getComputedStyle(element)
    const lineHeight = Number.parseFloat(computed.lineHeight)
    const height = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 22
    element.style.setProperty('--dsh-uix-tilt', tiltFor(element, height))
    state.target = terminal(element, height)
    const gap = state.target - state.shown
    if (gap < MIN_REVEAL_PX) {
      element.style.setProperty('--dsh-uix-reveal', `${state.target}px`)
      state.shown = state.target
      return
    }
    // The duration differs per chunk, so it cannot live in the sheet: a transition
    // declared there would apply the same duration to every arrival.
    element.style.transition = `--dsh-uix-reveal ${revealDuration(gap, active.durationScale)}ms ${ease}`
    element.style.setProperty('--dsh-uix-reveal', `${state.target}px`)
    state.shown = state.target
  }

  /**
   * Roll a live label: the line it showed before this update leaves upward while
   * the new one arrives from below.
   * @param element - the label.
   * @param previous - the text it showed before this update.
   */
  function roll(element: ElementLike, previous: string): void {
    const before = previous.replace(/\s+/g, ' ').trim()
    const now = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (before === '' || before === now) return
    element.setAttribute('data-dsh-uix-prev', before)
    // Restart the animation even when it is already running: two updates inside one
    // roll must not leave the second one unanimated.
    element.removeAttribute('data-dsh-uix-rolling')
    void element.scrollHeight
    element.setAttribute('data-dsh-uix-rolling', '')
    window.setTimeout(() => {
      element.removeAttribute('data-dsh-uix-rolling')
      element.removeAttribute('data-dsh-uix-prev')
    }, ROLL_MS)
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
    window.setTimeout(clear, MAX_REVEAL_MS)
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
        } else {
          // A body first seen mid-stream already shows what arrived before this
          // layer started watching; revealing that from zero would blank a message
          // the reader is looking at.
          const height = element.scrollHeight
          reveals.set(element, { shown: height, target: height })
        }
        element.setAttribute(STREAM_ATTRIBUTE, mode)
      }
      if (mode !== 'roll') continue
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
      const previous = element.getAttribute(LAST_ATTRIBUTE) ?? ''
      if (previous !== text) {
        roll(element, previous)
        element.setAttribute(LAST_ATTRIBUTE, text)
      }
    }
    // Anything still marked but no longer live has finished.
    const marked = document.querySelectorAll(`[${STREAM_ATTRIBUTE}]`)
    for (let index = 0; index < marked.length; index += 1) {
      const element = marked[index]
      if (element === undefined || seen.has(element)) continue
      forget(element)
    }
    schedule()
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
    mark()
  }

  /** Remove the sheet, the observer, and every mark this layer wrote. */
  function uninstall(): void {
    observer?.disconnect()
    observer = undefined
    sheet?.remove()
    sheet = undefined
    installed = false
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
      ease = 'cubic-bezier(0.34, 0.8, 0.34, 1)'
      install()
    },
    restore: uninstall,
  }
}
