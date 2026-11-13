/**
 * Streaming output motion: the transcript reveals its text character by
 * character, and every live one-line label — a work-step title, the reasoning
 * summary — sweeps an edge across the text that just arrived
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

/** Marks a label that is currently rising into place. */
const ROLL_ATTRIBUTE = 'data-dsh-uix-rolling'

/**
 * The application's own unique names for a transcript row, in the order a slot key
 * prefers them.
 *
 * These are values, not nodes, so they survive a rebuild of whatever carries them. One
 * of them also marks where a slot key may stop climbing: the row is the thing that stays
 * put, and its position among its siblings is none of the label's business.
 */
const ROW_IDENTITY_ATTRIBUTES = ['data-chat-anchor-key', 'data-chat-flow-key', 'data-chat-group-key']

/**
 * The application's names for what a row is currently showing.
 *
 * Unlike the row identities these are not unique — every process row says
 * `data-chat-flow-kind=turn-process` — so they qualify a slot without terminating it.
 */
const CONTEXT_ATTRIBUTES = ['data-chat-flow-kind', 'data-process-activity']

/** How many label slots are remembered before the oldest are dropped. */
const SLOT_LIMIT = 512

/** How long a label slot may go unoccupied before it is forgotten. */
const SLOT_IDLE_MS = 30000

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
 * - `append`: a one-line label — a work-step title, or the reasoning summary. A
 *   horizontal edge sits where the previous text ended and sweeps to the new width,
 *   so only the characters that actually arrived are revealed.
 */
type Mode = 'reveal' | 'append'

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

/**
 * How tall an element may be, in line heights, and still count as a single line.
 *
 * A reveal boundary travels down the element, so a surface with only one line has
 * nowhere to travel: the tilted line sits inside that line for the whole run, which
 * paints a fade at a fixed fraction of the width instead of unveiling anything.
 */
const SINGLE_LINE_RATIO = 1.5

/** Shallowest the reveal line may run, in degrees off horizontal. */
const MIN_TILT_DEG = 15

/** Steepest the reveal line may run, so a very narrow box does not become a vertical wipe. */
const MAX_TILT_DEG = 45

/** One element's reveal state. */
interface Reveal {
  /** Reveal position currently painted. */
  current: number
  /** Where the boundary started for the leg in flight. */
  from: number
  /** Reveal position the element reaches with this chunk. */
  target: number
  /** The leg in flight, or 0. */
  frame: number
  /** When the leg in flight began. */
  started: number
  /** How long the leg in flight runs, which is also its ceiling. */
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
   of a gradient rather than at a hard boundary. The tilt is held inside 15deg-45deg
   off horizontal, which is what makes the edge read as a diagonal wipe; any
   shallower and it looks like a flat line across the block. */
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

/* One-line labels: a horizontal edge at the end of the text a reader has already
   seen sweeps out to the new width, so only the arriving characters are revealed.

   The edge is a registered custom property driven by a transition. Keyframing the
   gradient itself does not work: Chrome snaps between two linear-gradients instead of
   interpolating them, which reads as no animation at all.

   A TextShimmer root holds a decorative copy of its children for its own sweep, so
   its mask goes on the readable first child. The reasoning summary masks itself,
   which also replaces the static fade the application puts on it. */
[${STREAM_ATTRIBUTE}="append"][data-shimmer] > :first-child,
[${STREAM_ATTRIBUTE}="append"][data-streaming]:not([data-shimmer]) {
  --dsh-uix-edge: 100000px;
  mask-image: linear-gradient(
    to right,
    #000 calc(var(--dsh-uix-edge) - 1.2ch),
    transparent var(--dsh-uix-edge)
  );
}

/* A TextShimmer root draws a second, inert copy of its children and sweeps a band of
   light through it — the application's own idle shimmer. This layer moves a mask over
   the readable copy instead, so the two would run at once: a band of light crossing a
   line whose text is also being uncovered, which reads as two animations fighting.

   The decorative copy is always the second child, and only exists while the label is
   active, so this matches nothing on an idle one. */
[${STREAM_ATTRIBUTE}="append"][data-shimmer] > :nth-child(2),
[${STREAM_ATTRIBUTE}="append"] [data-shimmer] > :nth-child(2) {
  display: none;
}

/* A label arrives as a whole line and rises into place; only later growth is swept,
   so arrival and extension read differently. */
[${STREAM_ATTRIBUTE}="append"][data-shimmer][${ROLL_ATTRIBUTE}] > :first-child,
[${STREAM_ATTRIBUTE}="append"][data-streaming]:not([data-shimmer])[${ROLL_ATTRIBUTE}] {
  animation: dsh-uix-arrive var(--dsh-uix-roll, 260ms) var(--dsh-uix-ease, ease) both;
}

@keyframes dsh-uix-arrive {
  from { transform: translateY(0.85lh); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
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

  [${STREAM_ATTRIBUTE}="append"][data-shimmer][${ROLL_ATTRIBUTE}] > :first-child,
  [${STREAM_ATTRIBUTE}="append"][data-streaming]:not([data-shimmer])[${ROLL_ATTRIBUTE}] {
    animation: none;
  }

  [${STREAM_ATTRIBUTE}="append"][data-shimmer] > :first-child,
  [${STREAM_ATTRIBUTE}="append"][data-streaming]:not([data-shimmer]) {
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
    readonly maskImage: string
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
  readonly children: { readonly length: number; [index: number]: ElementLike }
  getBoundingClientRect(): { left: number; right: number; width: number }
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
    getBoundingClientRect(): { width: number; right: number }
  }
  createTreeWalker(node: unknown, whatToShow: number): { nextNode(): { textContent: string | null } | null }
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
   * Sweep currently in flight per label, as `{ until }` in performance time.
   *
   * A label that updates faster than its sweep can finish must not restart from the
   * previous text each time: that pins the edge just after the old text and the new
   * characters never arrive, which reads as a mask stuck over the text until the
   * updates stop. While a sweep is live the edge is only ever moved forward, and the
   * transition interpolates from wherever it currently is.
   */
  const sweeps = new WeakMap<ElementLike, number>()

  /**
   * The mask a label carried before this layer first swept it.
   *
   * A label keeps its own mask for what it does at rest — the reasoning summary fades
   * where the application clips it — and this layer's rule replaces that while the
   * label is marked. Capturing it once lets the label go back to exactly that between
   * arrivals.
   */
  const rests = new WeakMap<ElementLike, string>()

  /**
   * The content height each live element had when it was last looked at.
   *
   * An element can switch between being a label and being prose — a streaming reply
   * starts as one line and wraps. The switch has to know where the text already on
   * screen ends, which is the height from before this update, not the height after it.
   */
  const heights = new WeakMap<ElementLike, number>()

  /**
   * Run counter for a label's arrival, separate from {@link generation}.
   *
   * The arrival animation and the append sweep are two animations on the same line with
   * independent lifetimes; sharing a counter let one retire the other.
   */
  const rolls = new WeakMap<ElementLike, number>()

  /**
   * What each label slot last showed, keyed by where the slot sits in the transcript.
   *
   * A label keeps neither its element nor its parents across an update: the process row
   * is rebuilt whenever its group data changes, so the whole button subtree — including
   * the element that carries the text — is new even when the line it shows is the same
   * one. Remembering the text on the element, or on its parent, therefore made every
   * rebuild look like a brand-new label and replayed the arrival on unchanged text.
   *
   * The key is a string built by {@link slotKey} instead: the child index at each level
   * below the enclosing row, anchored on the row's own name. Both are values rather than
   * nodes, so neither a rebuild of the row's contents nor a shift of the row itself
   * changes the key.
   */
  const slots = new Map<string, { text: string; width: number; at: number }>()

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

  /** Whether the current policy asks for no motion at all. */
  function still(): boolean {
    const active = settings
    if (active === undefined) return true
    if (active.reduced === 'always') return true
    return active.reduced === 'system' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  /**
   * An element's computed line height, with the body default as the fallback.
   * @param element - the element to measure.
   * @returns its line height in pixels.
   */
  function lineHeightOf(element: ElementLike): number {
    const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight)
    return Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 24
  }

  /**
   * Whether an element is a one-line surface rather than multi-line prose.
   * @param element - the live element.
   * @returns whether it holds a single line of text.
   */
  function singleLine(element: ElementLike): boolean {
    return element.scrollHeight <= lineHeightOf(element) * SINGLE_LINE_RATIO
  }

  /**
   * Whether an element is a one-line label rather than the transcript body.
   *
   * A `data-streaming` element is a label when it is `nowrap` — the reasoning
   * summary — and when it is only one line tall, which is where a streaming block
   * starts out. That second test is what a one-line body needs: it is not prose that
   * can be uncovered from the top down, and treating it as prose left the boundary
   * parked inside its only line.
   *
   * Height cannot be used for the multi-line case alone: a body sizes itself to its
   * content, so its scroll height equals its client height exactly like a one-line
   * label's does.
   *
   * @param element - the live element.
   * @returns the mode for this element.
   */
  function modeOf(element: ElementLike): Mode {
    if (element.hasAttribute('data-shimmer')) return 'append'
    if (window.getComputedStyle(element).whiteSpace === 'nowrap') return 'append'
    return singleLine(element) ? 'append' : 'reveal'
  }

  /**
   * The tilt of the reveal line, and the trigonometry the mask needs.
   *
   * The slanted edge is what turns a line-at-a-time reveal into a character-at-a-time
   * one: while the boundary descends by the span, it sweeps the element from one side
   * to the other, so characters inside a line appear left to right.
   *
   * The natural span is one line height, which on a wide column is a slant of under
   * two degrees: the edge reads as a flat line and the per-character sweep is invisible.
   * The slant is therefore held inside a range where the wipe is plainly diagonal.
   *
   * @param element - the element being revealed.
   * @param lineHeight - its computed line height in pixels.
   * @returns the CSS gradient angle and the sine and cosine of its slant.
   */
  function tiltFor(element: ElementLike, lineHeight: number): { angle: string; sin: number; cos: number } {
    const width = element.clientWidth
    if (width <= 0 || lineHeight <= 0) return { angle: '180deg', sin: 0, cos: 1 }
    const natural = Math.atan(lineHeight / width) * 180 / Math.PI
    const slant = Math.min(MAX_TILT_DEG, Math.max(MIN_TILT_DEG, natural)) * Math.PI / 180
    return {
      angle: `${180 - slant * 180 / Math.PI}deg`,
      sin: Math.sin(slant),
      cos: Math.cos(slant),
    }
  }

  /**
   * How far the mask has to travel for a box of the given height to be painted.
   *
   * The gradient runs at an angle, so its parameter is `x·sin + y·cos` and the last
   * point painted is the bottom-right corner — not the bottom edge. Getting this wrong
   * leaves a permanent fade over the right end of the final line, which on a short
   * message is the whole visible block.
   *
   * @param element - the element being revealed.
   * @param tilt - its mask geometry.
   * @param height - content height to measure, in pixels.
   * @param lineHeight - its computed line height in pixels, for the trailing band.
   * @returns the mask position at which that content is fully painted.
   */
  function front(element: ElementLike, tilt: { sin: number; cos: number }, height: number, lineHeight: number): number {
    return tilt.sin * Math.max(0, element.clientWidth) + tilt.cos * height + lineHeight * FADE_BAND
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
    const root = maskTarget(element)
    if (root === null) return 0
    // Measure the glyphs, not the box holding them. A nowrap label is a flex item
    // that fills the row, so its box width says nothing about where its text ends —
    // and returning that made a sweep run the full row for two words of text.
    const origin = root.getBoundingClientRect().left
    const range = document.createRange()
    const walker = document.createTreeWalker(root, 4)
    let right = 0
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent ?? ''
      if (text.trim() === '') continue
      range.selectNodeContents(node)
      right = Math.max(right, range.getBoundingClientRect().right - origin)
    }
    return right
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
   * The element that carries the mask for a one-line label.
   *
   * A `TextShimmer` root draws a decorative copy of its children for its own sweep,
   * so the mask goes on its readable first child. Every other label — the reasoning
   * summary — owns its mask directly, which also replaces the static fade the
   * application puts there.
   *
   * @param element - the marked label.
   * @returns the element to mask, or null.
   */
  function maskTarget(element: ElementLike): ElementLike | null {
    return element.hasAttribute('data-shimmer') ? firstChild(element) : element
  }

  /**
   * The application's unique name for a row, if it has one.
   * @param element - the element.
   * @returns one `name=value` token, or the empty string.
   */
  function rowIdentityOf(element: ElementLike): string {
    for (const name of ROW_IDENTITY_ATTRIBUTES) {
      const value = element.getAttribute(name)
      if (value !== null && value !== '') return `${name}=${value}`
    }
    return ''
  }

  /**
   * The application's name for what a row is showing, if it has one.
   * @param element - the element.
   * @returns one `name=value` token, or the empty string.
   */
  function contextOf(element: ElementLike): string {
    for (const name of CONTEXT_ATTRIBUTES) {
      const value = element.getAttribute(name)
      if (value !== null && value !== '') return `:${value}`
    }
    return ''
  }

  /**
   * Where a label sits in the transcript, as a string that outlives its nodes.
   *
   * The walk climbs from the label and stops at the first ancestor the application has
   * named uniquely. Everything below that ancestor is described by the child index at
   * each level, because that is what distinguishes one label from another inside a row;
   * the named ancestor itself contributes only its name, because rows move down the
   * transcript as history loads and their position is not part of their identity.
   *
   * @param element - the label.
   * @returns its slot key, or null when it is detached.
   */
  function slotKey(element: ElementLike): string | null {
    const parts: string[] = []
    let node = element
    while (true) {
      const parent = node.parentElement
      if (parent === null) break
      const identity = rowIdentityOf(node)
      if (identity !== '') return `${identity}#${parts.reverse().join('/')}`
      const children = parent.children
      let index = -1
      for (let at = 0; at < children.length; at += 1) {
        if (children[at] === node) {
          index = at
          break
        }
      }
      if (index < 0) return null
      parts.push(`${index}${contextOf(node)}`)
      node = parent
    }
    return parts.length === 0 ? null : parts.reverse().join('/')
  }

  /**
   * What a label slot showed last time.
   * @param key - the slot key, or null.
   * @returns the remembered text and width, or undefined for a slot never seen.
   */
  function readSlot(key: string | null): { text: string; width: number } | undefined {
    if (key === null) return undefined
    const entry = slots.get(key)
    if (entry === undefined) return undefined
    entry.at = performance.now()
    return entry
  }

  /**
   * Remember what a label slot now shows.
   * @param key - the slot key, or null.
   * @param text - the label's text.
   * @param width - its rendered width in pixels.
   */
  function writeSlot(key: string | null, text: string, width: number): void {
    if (key === null) return
    slots.set(key, { text, width, at: performance.now() })
    if (slots.size <= SLOT_LIMIT) return
    // Keys are strings, so they are not collected with their nodes. Drop the ones no
    // label has occupied for a while, and fall back to insertion order if that is not
    // enough — a key that is dropped only costs one arrival replayed on unchanged text,
    // which is what happened on every update before the slot was remembered at all.
    const now = performance.now()
    for (const [candidate, entry] of slots) {
      if (now - entry.at > SLOT_IDLE_MS) slots.delete(candidate)
    }
    for (const candidate of slots.keys()) {
      if (slots.size <= SLOT_LIMIT) break
      slots.delete(candidate)
    }
  }

  /**
   * Slide a step label up into place as it arrives.
   *
   * The arrival and the growth that follows are two different readings of the same
   * line, and they belong to different clocks: the rise is the row appearing, the
   * sweep is its text arriving. Sharing one run counter meant the first chunk of text
   * retired the rise before it had played — under fast output the label was cut off
   * part-way up and only the sweep was left, which reads as the rise having been
   * removed. Its own counter lets it finish.
   *
   * @param element - the shimmer root.
   */
  function enterLabel(element: ElementLike): void {
    const run = (rolls.get(element) ?? 0) + 1
    rolls.set(element, run)
    element.removeAttribute(ROLL_ATTRIBUTE)
    void element.scrollHeight
    element.setAttribute(ROLL_ATTRIBUTE, '')
    window.setTimeout(() => {
      if (rolls.get(element) === run) element.removeAttribute(ROLL_ATTRIBUTE)
    }, rollMs)
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
    const target = maskTarget(element)
    if (target === null) return
    const full = contentWidth(element)
    element.setAttribute(WIDTH_ATTRIBUTE, String(full))
    if (full <= 1) {
      // Nothing measurable to sweep, so the label is simply shown whole.
      rest(element, target)
      return
    }
    // Two different arrivals need two different sweeps.
    //
    // An extension keeps what the reader has already read and sweeps only the new
    // characters in, from the old right edge.
    //
    // A replacement has nothing in common with what was there. It is a new line being
    // written, so it sweeps from the left edge. Carrying the old edge over would draw
    // the new line as if it were already partly read, which is why no unveiling
    // appeared at all.
    const extending = previous !== '' && now.startsWith(previous) && previousWidth > 0
    const start = extending ? previousWidth : 0
    const gap = Math.max(MIN_REVEAL_PX, full - start)
    // Bounded by the same curve as the body reveal, so a longer arrival takes longer
    // and a short one does not crawl — and every sweep is guaranteed to finish.
    const duration = revealDuration(gap)
    const run = nextGeneration(element)
    // Only an extension may continue from where the edge already is: it is the same
    // line growing. A replacement always restarts, even mid-sweep, because the text
    // it would otherwise continue into is gone.
    const continuing = extending && (sweeps.get(element) ?? 0) > performance.now()
    // The sweep needs the rule's own mask, so the resting one steps aside first.
    target.style.removeProperty('mask-image')
    if (!continuing) {
      target.style.transition = 'none'
      target.style.setProperty('--dsh-uix-edge', `${start}px`)
      void element.scrollHeight
    }
    sweeps.set(element, performance.now() + duration)
    target.style.transition = `--dsh-uix-edge ${duration}ms ${ease}`
    target.style.setProperty('--dsh-uix-edge', `${full}px`)
    window.setTimeout(() => {
      if (!owns(element, run)) return
      sweeps.delete(element)
      rest(element, target)
    }, duration)
  }

  /**
   * Put a label back into its resting mask.
   *
   * A label can carry a mask of its own — the reasoning summary fades its last few
   * characters where the application clips it — and this layer's rule replaces it,
   * which turned that soft edge into a hard cut. The mask that was there before the
   * first sweep is captured and put back here, so an idle label looks exactly as the
   * application draws it and only the arrival is ours.
   *
   * @param element - the label.
   * @param target - the element that carries its mask.
   */
  function rest(element: ElementLike, target: ElementLike): void {
    target.style.setProperty('mask-image', rests.get(element) ?? 'none')
    target.style.removeProperty('--dsh-uix-edge')
    target.style.removeProperty('transition')
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
    const height = lineHeightOf(element)
    const tilt = tiltFor(element, height)
    element.style.setProperty('--dsh-uix-tilt', tilt.angle)
    state.target = front(element, tilt, element.scrollHeight, height)
    // A leg already in flight is left to finish on its own clock. It will see the new
    // target and start the next leg when it lands.
    //
    // Restarting the leg here was wrong, and it is what made the boundary crawl. This
    // runs on every mutation batch, and a running tool mutates the page continuously,
    // so the leg restarted before progress could accumulate. With an ease-in curve the
    // progress at each restart is close to zero, so the boundary effectively froze —
    // and only completed once the tool stopped mutating and the leg was finally
    // allowed to run to its end.
    if (state.frame !== 0) return
    run(element, state)
  }

  /**
   * Start one leg of the reveal, from wherever the boundary is now to the current
   * target.
   *
   * The leg is bounded by its own duration, so the boundary always lands: a leg is
   * never left waiting on further content. When it lands and the target has moved
   * on, the next leg starts from there, which is how a long stream stays continuous
   * instead of being one unbounded run.
   *
   * @param element - the element being revealed.
   * @param state - its reveal state.
   */
  function run(element: ElementLike, state: Reveal): void {
    const active = settings
    if (active === undefined) return
    const gap = state.target - state.current
    if (gap < MIN_REVEAL_PX) {
      state.frame = 0
      return
    }
    state.from = state.current
    state.started = performance.now()
    state.duration = revealDuration(gap)
    const mode = active.mode
    const step = (now: number): void => {
      const live = reveals.get(element)
      if (live === undefined || live !== state) return
      const progress = Math.min(1, (now - state.started) / Math.max(1, state.duration))
      const eased = easeCurve(effectCurvePoints(mode), progress)
      state.current = state.from + (state.target - state.from) * eased
      element.style.setProperty('--dsh-uix-reveal', `${state.current}px`)
      if (progress >= 1) {
        state.current = state.target
        element.style.setProperty('--dsh-uix-reveal', `${state.target}px`)
        state.frame = 0
        // Content that arrived during the leg moves the target; chase it now.
        if (state.target - state.current >= MIN_REVEAL_PX) run(element, state)
        return
      }
      state.frame = window.requestAnimationFrame(step)
    }
    state.frame = window.requestAnimationFrame(step)
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
    // Whatever this element is about to become, the timers of its previous life are
    // stale. One of them puts a label back into its resting mask, which on a body that
    // has just grown into prose would paint `mask-image: none` over the reveal.
    nextGeneration(element)
    // Open the mask before removing it. Dropping the attribute while the boundary was
    // still mid-run snapped the last line to full colour in a single frame.
    if (state !== undefined && !immediately) {
      element.style.setProperty('--dsh-uix-reveal', `${state.target + element.scrollHeight}px`)
    }
    element.removeAttribute(STREAM_ATTRIBUTE)
    element.removeAttribute(LAST_ATTRIBUTE)
    element.removeAttribute(WIDTH_ATTRIBUTE)
    element.removeAttribute(ROLL_ATTRIBUTE)
    rolls.delete(element)
    const target = maskTarget(element)
    const clear = (): void => {
      element.style.removeProperty('--dsh-uix-reveal')
      element.style.removeProperty('--dsh-uix-tilt')
      element.style.removeProperty('transition')
      target?.style.removeProperty('--dsh-uix-edge')
      target?.style.removeProperty('transition')
      target?.style.removeProperty('mask-image')
    }
    rests.delete(element)
    if (immediately || state === undefined) clear()
    else window.setTimeout(clear, revealMaxMs)
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
   * Whether an element is already covered by an ancestor that owns the reveal.
   *
   * A multi-line surface reveals its own content, so a live element inside it is part
   * of that same run and must not be animated twice. A one-line surface reveals
   * nothing — {@link modeOf} makes it a label — so it never owns its content.
   *
   * @param element - the candidate.
   * @returns whether an ancestor owns the reveal.
   */
  function covered(element: ElementLike): boolean {
    let node = element.parentElement
    while (node !== null) {
      if (node.getAttribute(STREAM_ATTRIBUTE) === 'reveal') return true
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
    // Which live elements have a live element inside them. A one-line container — the
    // block a streaming reasoning row starts as — is such a case: it is a label by
    // {@link modeOf}, but the text that arrives is the row's own label, so the inner
    // element is the surface that must unveil. Marking both would clip the same line
    // twice, and marking only the container left the inner text with the application's
    // static fade and no unveiling at all.
    const containers = new Set<ElementLike>()
    for (let index = 0; index < live.length; index += 1) {
      const element = live[index]
      if (element === undefined) continue
      for (let node = element.parentElement; node !== null; node = node.parentElement) {
        containers.add(node)
      }
    }
    for (let index = 0; index < live.length; index += 1) {
      const element = live[index]
      if (element === undefined) continue
      const height = element.scrollHeight
      const lineHeight = lineHeightOf(element)
      // The height this element had last time it was looked at. A mode change needs it
      // to know where the text already on screen ends.
      const before = heights.get(element)
      heights.set(element, height)
      if (covered(element)) continue
      const mode = modeOf(element)
      if (mode === 'append' && containers.has(element)) {
        if (element.hasAttribute(STREAM_ATTRIBUTE)) forget(element, true)
        continue
      }
      seen.add(element)
      const marked = element.getAttribute(STREAM_ATTRIBUTE)
      if (marked !== mode) {
        if (marked !== null) forget(element, true)
        if (mode === 'reveal') {
          const tilt = tiltFor(element, lineHeight)
          const end = front(element, tilt, height, lineHeight)
          // A surface first seen mid-stream already shows what arrived before this
          // layer started watching, so it starts fully painted.
          //
          // A surface that just grew past one line is the other case. Its text was
          // being swept as a label, so everything below where the block stood a moment
          // ago is new, and only that may be unveiled. Starting any higher — the
          // obvious `height - one line` — puts the boundary inside text the reader has
          // already read: the last line loses its paint and is then uncovered a second
          // time, while the arriving line plays its own unveiling. That is two
          // unveilings at once, and the first of them reads as the previous line fading
          // out.
          const open = before === undefined
            ? end
            : Math.min(end, front(element, tilt, before, lineHeight))
          reveals.set(element, { current: open, from: open, target: open, frame: 0, started: 0, duration: 0 })
          // Write the position before the attribute makes the mask apply. The rule's
          // own default is zero, which would paint one frame of an entirely hidden
          // message between this mark and the first frame of the reveal.
          element.style.setProperty('--dsh-uix-tilt', tilt.angle)
          element.style.setProperty('--dsh-uix-reveal', `${open}px`)
        } else {
          // The mask the label carries at rest is captured here, before this layer's
          // rule starts applying to it.
          const target = maskTarget(element)
          if (target !== null) rests.set(element, window.getComputedStyle(target).maskImage)
        }
        element.setAttribute(STREAM_ATTRIBUTE, mode)
        // Hand a label back to its own mask straight away. Its rule covers the whole
        // width, so leaving it on until the first sweep would hard-clip the end of a
        // label whose application draws a soft edge there.
        const target = maskTarget(element)
        if (mode === 'append' && target !== null) rest(element, target)
      }
      if (mode === 'reveal') continue
      const text = labelText(element)
      const width = contentWidth(element)
      // Read the previous state from the slot, not from the element. The process row is
      // rebuilt when its title changes, so the element is often new while the line it
      // shows is the same one, a word longer.
      const slot = slotKey(element)
      const prior = readSlot(slot)
      const previous = prior?.text ?? element.getAttribute(LAST_ATTRIBUTE) ?? ''
      const previousWidth = prior?.width ?? Number.parseFloat(element.getAttribute(WIDTH_ATTRIBUTE) ?? '0')
      if (text === previous) continue
      writeSlot(slot, text, width)
      element.setAttribute(LAST_ATTRIBUTE, text)
      element.setAttribute(WIDTH_ATTRIBUTE, String(width))
      // Two kinds of change, two different animations.
      //
      // A line that keeps its beginning is the same line getting longer: only the new
      // characters are uncovered, and the row itself must not move.
      //
      // A line with no shared beginning is a different line — the step moved on. That
      // one rises from below the way a new row does, so the change of subject is
      // visible rather than the whole line flashing to different text.
      const extending = previous !== '' && text.startsWith(previous) && previousWidth > 0
      if (!extending) enterLabel(element)
      append(element, previous, Number.isFinite(previousWidth) ? previousWidth : 0)
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
      revealMinMs = next.streamRevealMinMs
      revealMaxMs = next.streamRevealMaxMs
      document.documentElement.style.setProperty('--dsh-uix-enter', `${enterMs}ms`)
      install()
    },
    restore: uninstall,
  }
}
