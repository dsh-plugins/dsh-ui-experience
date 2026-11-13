/**
 * Streaming output motion: the transcript and the reasoning summary reveal their
 * text progressively instead of appearing a chunk at a time, and the reasoning
 * summary rolls its old line out when a new paragraph completes.
 *
 * WHY THIS ONLY TOUCHES THE VISUAL LAYER
 *
 * The obvious implementation — cut a text node down to the first N characters and
 * grow N over time — changes what React owns. React would keep issuing the full
 * string, the two would fight, and in the meantime selection, copying, and
 * assistive technology would all read a truncated transcript.
 *
 * So the text is never truncated. Every character stays in the DOM from the moment
 * the model produces it, and only a `mask-image` moves: everything above the
 * reveal line paints, everything below it is transparent. Layout is therefore
 * final the instant a chunk arrives, and the animation cannot disagree with it.
 *
 * The reveal itself is driven by a transition on a registered custom property, so
 * it runs off the main thread. This layer only computes a duration each time text
 * arrives — a function of how far behind the reveal is — which is the flow
 * smoothing: a burst of output gives a faster catch-up, a trickle gives a slow
 * crawl, and the two never look different from each other.
 */

import { type MotionSettings } from './shared.ts'

/** The attributes this layer reads and writes. */
const STREAM_ATTRIBUTE = 'data-dsh-uix-stream'

/**
 * Elements carrying this attribute are mid-stream: `AssistantMarkdown` sets it on
 * its root while a message is still being produced, and `ReasoningRow` sets it on
 * the one-line summary while reasoning is still arriving.
 */
const STREAMING = '[data-streaming]'

/** Reveal distance below which nothing is animated, in CSS pixels. */
const MIN_REVEAL_PX = 6

/** Reveal transition bounds, in milliseconds. */
const MIN_REVEAL_MS = 90
const MAX_REVEAL_MS = 480

/**
 * Reveal speed the duration is derived from, in CSS pixels per millisecond of
 * catch-up. Roughly one line every 40 ms reads as typing without feeling behind.
 */
const REVEAL_PX_PER_MS = 0.55

/** How long the reasoning summary's roll takes. */
const ROLL_MS = 260

/** One element's reveal state. */
interface Reveal {
  /** Height the element had when the last chunk landed. */
  shown: number
  /** Height the element reached with this chunk. */
  target: number
  /** Pending frame, or 0. */
  frame: number
}

declare const document: {
  readonly documentElement: {
    readonly style: {
      setProperty(name: string, value: string): void
      removeProperty(name: string): string
    }
  }
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
  getComputedStyle(element: unknown): { readonly whiteSpace: string }
}

declare const MutationObserver: new (callback: () => void) => {
  observe(target: unknown, options: { childList?: boolean; subtree?: boolean; characterData?: boolean; attributes?: boolean; attributeFilter?: string[] }): void
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
  readonly style: {
    setProperty(name: string, value: string): void
    removeProperty(name: string): string
    transition: string
  }
  readonly dataset: Record<string, string | undefined>
  textContent: string | null
  closest(selectors: string): unknown
}

/**
 * The stylesheet this layer installs.
 *
 * `@property` is what makes the reveal animatable at all: an unregistered custom
 * property is a string, and a string cannot be interpolated. Registering it as a
 * length lets the transition — and therefore the compositor — do the work instead
 * of a per-frame script.
 */
const STREAM_CSS = `
@property --dsh-uix-reveal {
  syntax: '<length>';
  inherits: false;
  initial-value: 0px;
}

/* The mask is a reveal line with a soft trailing edge, so text arrives out of a
   gradient rather than appearing at a hard boundary. The trailing band is one
   line tall, which is what keeps the newest line readable while it fades in. */
[${STREAM_ATTRIBUTE}] {
  --dsh-uix-reveal: 0px;
  mask-image: linear-gradient(
    to bottom,
    #000 calc(var(--dsh-uix-reveal) - 1lh),
    transparent var(--dsh-uix-reveal)
  );
  mask-size: 100% 100%;
  mask-repeat: no-repeat;
}

/* Only the reasoning summary rolls. It is a single nowrap line, so a vertical
   translate is unambiguous; multi-line bodies would need a different metaphor. */
[${STREAM_ATTRIBUTE}="roll"] {
  mask-image: none;
  position: relative;
  overflow: hidden;
}

[${STREAM_ATTRIBUTE}="roll"]::after {
  content: attr(data-dsh-uix-prev);
  position: absolute;
  inset: 0;
  color: var(--dsw-alias-label-tertiary);
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
  from { transform: translateY(0.9lh); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

@keyframes dsh-uix-roll-out {
  from { transform: translateY(0); opacity: 1; }
  to { transform: translateY(-0.9lh); opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  [${STREAM_ATTRIBUTE}] {
    mask-image: none;
  }

  [${STREAM_ATTRIBUTE}="roll"][data-dsh-uix-rolling] > *,
  [${STREAM_ATTRIBUTE}="roll"][data-dsh-uix-rolling]::after {
    animation: none;
  }
}
`

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
  let observer: {
    disconnect(): void
    observe(target: unknown, options: Record<string, unknown>): void
  } | undefined
  let settings: MotionSettings | undefined
  let pending = false
  let installed = false
  let easedCurve = ''

  /**
   * Whether the current policy asks for no motion at all.
   * @returns whether the reveal should be skipped.
   */
  function still(): boolean {
    const active = settings
    if (active === undefined) return true
    if (active.reduced === 'always') return true
    return active.reduced === 'system' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  /**
   * Whether an element is a one-line summary rather than a multi-line body.
   *
   * Height cannot answer this: a body sizes itself to its content, so its scroll
   * height equals its client height exactly like a one-line summary's does. The
   * distinguishing property is `white-space`, which the summary sets to `nowrap`.
   *
   * @param element - the streaming element.
   * @returns whether it should roll instead of reveal.
   */
  function isSummary(element: ElementLike): boolean {
    return window.getComputedStyle(element).whiteSpace === 'nowrap'
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
   * Reveal an element up to its current height.
   * @param element - the streaming element.
   * @param state - its reveal state.
   */
  function advance(element: ElementLike, state: Reveal): void {
    const active = settings
    if (active === undefined) return
    state.target = element.scrollHeight
    const gap = state.target - state.shown
    if (gap < MIN_REVEAL_PX) {
      // Close enough: show everything and drop the mask so the text is plain again.
      element.style.setProperty('--dsh-uix-reveal', `${state.target}px`)
      state.shown = state.target
      return
    }
    const duration = revealDuration(gap, active.durationScale)
    element.style.setProperty('--dsh-uix-ease', easedCurve)
    // The duration differs per chunk, so it cannot live in the sheet: a transition
    // declared there would apply the same duration to every arrival.
    element.style.transition = `--dsh-uix-reveal ${duration}ms ${easedCurve}`
    element.style.setProperty('--dsh-uix-reveal', `${state.target}px`)
    state.shown = state.target
  }

  /**
   * Roll the previous summary line out as the new one arrives.
   * @param element - the summary element.
   * @param previous - the text it showed before this update.
   */
  function roll(element: ElementLike, previous: string): void {
    if (previous.trim() === '' || previous === element.textContent) return
    element.setAttribute('data-dsh-uix-prev', previous)
    // Restart the animation even when it is already running: two chunks inside one
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
   * The reveal is first moved one line past the content, which is the position at
   * which the mask paints everything: removing it outright would snap the faded
   * last line to full colour in one frame. The transition carries that last step,
   * and only then does the mask go away.
   *
   * @param element - the element to release.
   * @param immediately - skip the settling step, for teardown.
   */
  function forget(element: ElementLike, immediately = false): void {
    const state = reveals.get(element)
    reveals.delete(element)
    element.removeAttribute(STREAM_ATTRIBUTE)
    element.removeAttribute('data-dsh-uix-last')
    element.removeAttribute('data-dsh-uix-prev')
    element.removeAttribute('data-dsh-uix-rolling')
    if (immediately || state === undefined) {
      element.style.removeProperty('--dsh-uix-reveal')
      element.style.removeProperty('--dsh-uix-ease')
      element.style.removeProperty('transition')
      return
    }
    // Paint the remainder, then drop the mask once that transition is over.
    element.style.setProperty('--dsh-uix-reveal', `${state.target + element.scrollHeight}px`)
    window.setTimeout(() => {
      element.style.removeProperty('--dsh-uix-reveal')
      element.style.removeProperty('--dsh-uix-ease')
      element.style.removeProperty('transition')
    }, MAX_REVEAL_MS)
  }

  /** Re-measure every streaming element that is currently on screen. */
  function measure(): void {
    pending = false
    const active = settings
    if (active === undefined || active.mode === 'off' || still()) return
    const marked = document.querySelectorAll(`[${STREAM_ATTRIBUTE}]`)
    const live = new Set<ElementLike>()
    for (let index = 0; index < marked.length; index += 1) {
      const element = marked[index]
      if (element === undefined) continue
      live.add(element)
    }
    // Elements that stopped streaming are finished: show them whole and stop
    // paying for them.
    for (const [element] of reveals) {
      if (!live.has(element)) forget(element)
    }
    for (const element of live) {
      let state = reveals.get(element)
      if (state === undefined) {
        // An element first seen mid-stream already shows whatever arrived before
        // this layer started watching; revealing that from zero would blank a
        // message the reader is looking at.
        const current = element.scrollHeight
        state = { shown: current, target: current, frame: 0 }
        reveals.set(element, state)
      }
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
   * Mark newly streaming elements, and give the ones that stopped their text back.
   *
   * This runs on every mutation batch, so it does the cheapest possible thing:
   * a single selector query, and a write only for elements whose state changed.
   */
  function mark(): void {
    const active = settings
    if (active === undefined || active.mode === 'off' || still()) return
    const streaming = document.querySelectorAll(STREAMING)
    const live = new Set<ElementLike>()
    for (let index = 0; index < streaming.length; index += 1) {
      const element = streaming[index]
      if (element === undefined) continue
      live.add(element)
      const mode = isSummary(element) ? 'roll' : 'reveal'
      if (element.getAttribute(STREAM_ATTRIBUTE) !== mode) {
        if (mode === 'roll') {
          roll(element, element.getAttribute('data-dsh-uix-last') ?? '')
          element.style.removeProperty('--dsh-uix-reveal')
          element.style.removeProperty('--dsh-uix-ease')
          reveals.delete(element)
        }
        element.setAttribute(STREAM_ATTRIBUTE, mode)
      }
      // Remember the line so the next completion can roll it out.
      const text = element.textContent ?? ''
      if (element.getAttribute('data-dsh-uix-last') !== text) {
        if (element.getAttribute(STREAM_ATTRIBUTE) === 'roll') {
          roll(element, element.getAttribute('data-dsh-uix-last') ?? '')
        }
        element.setAttribute('data-dsh-uix-last', text)
      }
    }
    // A message that finished streaming lost its `data-streaming` attribute, so it
    // is no longer in `live`; its mask has to come off or the last line stays faded.
    const marked = document.querySelectorAll(`[${STREAM_ATTRIBUTE}]`)
    for (let index = 0; index < marked.length; index += 1) {
      const element = marked[index]
      if (element === undefined || live.has(element)) continue
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
      attributeFilter: ['data-streaming'],
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
      if (element === undefined) continue
      forget(element, true)
    }
    for (const [element] of reveals) forget(element, true)
    reveals.clear()
  }

  return {
    apply(next: MotionSettings): void {
      uninstall()
      settings = next
      if (next.mode === 'off' || !next.stream) return
      if (next.reduced === 'system' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      easedCurve = `cubic-bezier(0.34, 0.8, 0.34, 1)`
      install()
    },
    restore: uninstall,
  }
}
