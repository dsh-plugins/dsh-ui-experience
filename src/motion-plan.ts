/**
 * Pure decisions the motion layer makes about a single declaration: how to cut
 * a comma-separated CSS value list, whether a duration is rewritable and to
 * what, and which curve a property belongs to. Nothing here touches the DOM —
 * `motion.ts` owns the CSSOM traversal and calls into these functions once per
 * longhand entry, which keeps the part that cannot be unit checked small.
 */

import type { MotionMode } from './shared.ts'

/** Whether an animated property reads as the element moving through space. */
export type MotionDomain = 'spatial' | 'effects'

/**
 * Properties whose interpolation reads as physical movement. Anything absent
 * from this set is treated as an effect (colour, opacity, shadow, filter),
 * because a spatial curve applied to a colour overshoots through colours that
 * do not exist in the palette.
 */
const SPATIAL_PROPERTIES = new Set([
  'transform', 'translate', 'rotate', 'scale', 'offset-distance', 'offset-path',
  'left', 'right', 'top', 'bottom', 'inset', 'inset-inline', 'inset-block',
  'inset-inline-start', 'inset-inline-end', 'inset-block-start', 'inset-block-end',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'inline-size', 'block-size', 'min-inline-size', 'min-block-size',
  'max-inline-size', 'max-block-size', 'flex-basis',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'margin-inline', 'margin-block', 'margin-inline-start', 'margin-inline-end',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'padding-inline', 'padding-block', 'padding-inline-start', 'padding-inline-end',
  'gap', 'row-gap', 'column-gap',
  'grid-template-columns', 'grid-template-rows', 'grid-auto-columns', 'grid-auto-rows',
  'border-radius', 'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-left-radius', 'border-bottom-right-radius',
])

/**
 * Material 3 Expressive spatial curves, written the way this layer emits them.
 * Values are the four control-point ordinates of the cubic Bézier; the two
 * spatial entries carry a deliberate overshoot (peak 1.092 and 1.014), which is
 * the whole point of the expressive family and the reason they must never be
 * applied to a colour.
 */
const CURVE_M3_SPATIAL = 'cubic-bezier(0.2, 0, 0, 1)'
const CURVE_M3_EFFECTS = 'cubic-bezier(0.2, 0, 0, 1)'
const CURVE_M3E_SPATIAL_FAST = 'cubic-bezier(0.42, 1.67, 0.21, 0.9)'
const CURVE_M3E_SPATIAL = 'cubic-bezier(0.38, 1.21, 0.22, 1)'
const CURVE_M3E_EFFECTS = 'cubic-bezier(0.34, 0.8, 0.34, 1)'

/**
 * Durations at or below this threshold take the fast spatial curve: the
 * expressive default curve needs roughly a fifth of a second to complete its
 * overshoot, and a shorter declaration would be retimed anyway, so pairing it
 * with the fast variant keeps the shape readable at the original length.
 */
const FAST_SPATIAL_MAX_MS = 200

/** The Material duration ladder, in milliseconds, used when quantizing. */
const MATERIAL_DURATIONS_MS = [
  50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600, 700, 800, 900, 1000,
]

/**
 * Cut a comma-separated CSS value list at top-level commas. Parentheses are
 * tracked so `cubic-bezier(0.2, 0, 0, 1)` and `var(--x, 1s)` stay single
 * entries.
 * @param value - the longhand value, or an empty string.
 * @returns the trimmed entries; an empty value yields no entries.
 */
export function splitList(value: string): string[] {
  if (value.trim() === '') return []
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === '(') depth += 1
    else if (character === ')') depth = Math.max(0, depth - 1)
    else if (character === ',' && depth === 0) {
      out.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  out.push(value.slice(start).trim())
  return out
}

/**
 * The entry a repeated longhand resolves to at one index: CSS repeats a shorter
 * list, so `transition-property: opacity` with two durations gives both
 * durations the `opacity` classification.
 * @param entries - the list.
 * @param index - the parallel index.
 * @returns the entry in force, or undefined when the list is empty.
 */
export function entryAt(entries: readonly string[], index: number): string | undefined {
  if (entries.length === 0) return undefined
  return entries[index % entries.length]
}

/** A duration literal: a number with an optional fraction and an ms/s unit. */
const DURATION = /^([0-9]*\.?[0-9]+)(ms|s)$/

/**
 * Read a CSS duration in milliseconds. `var()` references and bare numbers are
 * not literals this layer can scale, so they report no value.
 * @param value - one duration entry.
 * @returns milliseconds, or undefined when the entry is not a literal.
 */
export function parseDurationMs(value: string): number | undefined {
  const match = DURATION.exec(value.trim())
  if (match === null) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount < 0) return undefined
  return match[2] === 's' ? amount * 1000 : amount
}

/**
 * Nearest Material duration ladder step.
 * @param ms - duration in milliseconds.
 * @returns the closest ladder value.
 */
function quantizeMs(ms: number): number {
  let best = MATERIAL_DURATIONS_MS[0] ?? 50
  let bestDistance = Number.POSITIVE_INFINITY
  for (const step of MATERIAL_DURATIONS_MS) {
    const distance = Math.abs(step - ms)
    if (distance < bestDistance) {
      bestDistance = distance
      best = step
    }
  }
  return best
}

/** Longest duration this layer will write; anything above is clamped. */
const MAX_DURATION_MS = 10000

/**
 * Retime one duration entry.
 * @param value - the declared entry.
 * @param scale - multiplier applied before quantization.
 * @param quantize - whether to snap onto the Material ladder.
 * @returns the replacement entry, or undefined when the declaration must stay
 * exactly as written (a token reference, a zero, a non-literal, or a scale of 1
 * with quantization off).
 */
export function retime(value: string, scale: number, quantize: boolean): string | undefined {
  const original = parseDurationMs(value)
  if (original === undefined || original === 0) return undefined
  const scaled = Math.round(original * scale)
  const target = Math.min(MAX_DURATION_MS, Math.max(1, quantize ? quantizeMs(scaled) : scaled))
  if (target === original) return undefined
  return `${target}ms`
}

/**
 * A timing function that steps rather than interpolates. Discrete animations are
 * deliberate (a terminal cursor, a dot reveal, a sprite flip) and retiming them
 * would destroy the effect, so the layer leaves them alone.
 * @param value - one timing-function entry.
 * @returns whether the entry is discrete.
 */
export function isDiscrete(value: string): boolean {
  return /^(?:steps?\(|step-start$|step-end$)/.test(value.trim())
}

/**
 * Classify an animated property into a curve domain.
 * @param property - a property name from `transition-property` / `animation-name`
 * keyframes, or `all`.
 * @returns the domain; `all` and anything unrecognized count as effects, since
 * overshoot on an unknown property is far more likely to look wrong than flat.
 */
export function classify(property: string): MotionDomain {
  const name = property.trim().toLowerCase()
  return SPATIAL_PROPERTIES.has(name) ? 'spatial' : 'effects'
}

/**
 * Classify a property set: spatial as soon as one member moves the element.
 * @param properties - every property an animation touches.
 * @returns the domain.
 */
export function classifyAll(properties: Iterable<string>): MotionDomain {
  for (const property of properties) {
    if (classify(property) === 'spatial') return 'spatial'
  }
  return 'effects'
}

/**
 * Pick the timing function for one entry.
 * @param mode - the active family.
 * @param domain - the entry's domain.
 * @param spatialSplit - whether the two domains may differ.
 * @param originalMs - the entry's declared duration, used to choose between the
 * fast and default expressive spatial curves.
 * @returns the timing function to write.
 */
export function curveFor(
  mode: MotionMode, domain: MotionDomain, spatialSplit: boolean, originalMs: number | undefined,
): string {
  if (mode === 'm3') {
    // Material 3's standard and emphasized families both reduce to this single
    // cubic in CSS; the five-point emphasized curve has no cubic-bezier form.
    return domain === 'spatial' ? CURVE_M3_SPATIAL : CURVE_M3_EFFECTS
  }
  if (mode === 'm3e' && spatialSplit && domain === 'spatial') {
    return originalMs !== undefined && originalMs <= FAST_SPATIAL_MAX_MS
      ? CURVE_M3E_SPATIAL_FAST
      : CURVE_M3E_SPATIAL
  }
  return CURVE_M3E_EFFECTS
}
