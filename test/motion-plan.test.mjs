/**
 * Tests for the pure motion-planning rules: CSS value splitting, duration
 * parsing and retiming, property classification, curve selection, and the
 * Bézier evaluation the scripted reveal uses. Everything here locks a rule that
 * the TypeScript types cannot express; the CSSOM traversal and the scrolling
 * layer are exercised against a browser instead.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const work = mkdtempSync(join(tmpdir(), 'dsh-uix-plan-'))
const outfile = join(work, 'motion-plan.mjs')
await build({
  entryPoints: ['src/motion-plan.ts'],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
})
const plan = await import(pathToFileURL(outfile).href)
// `exit` cannot await, so the cleanup must be synchronous.
process.on('exit', () => { rmSync(work, { recursive: true, force: true }) })

test('splitList cuts only at top-level commas', () => {
  assert.deepEqual(plan.splitList('cubic-bezier(0.2, 0, 0, 1), ease'), ['cubic-bezier(0.2, 0, 0, 1)', 'ease'])
  // A var() fallback carries its own comma and must stay one entry.
  assert.deepEqual(plan.splitList('var(--x, 1s) 200ms'), ['var(--x, 1s) 200ms'])
  assert.deepEqual(plan.splitList(''), [])
  assert.deepEqual(plan.splitList('   '), [])
  assert.deepEqual(plan.splitList('a, b, c'), ['a', 'b', 'c'])
})

test('entryAt repeats the shorter list the way CSS does', () => {
  assert.equal(plan.entryAt(['a', 'b'], 0), 'a')
  assert.equal(plan.entryAt(['a', 'b'], 3), 'b')
  assert.equal(plan.entryAt(['only'], 7), 'only')
  assert.equal(plan.entryAt([], 2), undefined)
})

test('parseDurationMs reads literals and refuses everything else', () => {
  assert.equal(plan.parseDurationMs('120ms'), 120)
  assert.equal(plan.parseDurationMs('.16s'), 160)
  assert.equal(plan.parseDurationMs('0.2s'), 200)
  assert.equal(plan.parseDurationMs('0.01ms'), 0.01)
  assert.equal(plan.parseDurationMs('0s'), 0)
  // A token reference and a bare number are not literals this layer can scale.
  assert.equal(plan.parseDurationMs('var(--ds-transition-duration)'), undefined)
  assert.equal(plan.parseDurationMs('200'), undefined)
  assert.equal(plan.parseDurationMs('auto'), undefined)
})

test('retime leaves durations alone unless it is asked to change them', () => {
  // Scale 1 without quantization is a no-op, byte for byte.
  assert.equal(plan.retime('120ms', 1, false), undefined)
  // With scale 1 quantization still applies.
  assert.equal(plan.retime('180ms', 1, true), '200ms')
  // A duration already on the ladder reports no change.
  assert.equal(plan.retime('200ms', 1, true), undefined)
})

test('retime treats a millisecond and below as "immediately", not as a speed', () => {
  // Reduced-motion rules in the shipped sheets use these; scaling them would turn
  // an instant transition into a visible one.
  assert.equal(plan.retime('0.01ms', 2, false), undefined)
  assert.equal(plan.retime('1ms', 2, false), undefined)
  assert.equal(plan.retime('0s', 2, true), undefined)
})

test('retime scales linearly unless quantization takes over', () => {
  assert.equal(plan.retime('120ms', 1.5, false), '180ms')
  assert.equal(plan.retime('300ms', 0.5, false), '150ms')
  // Quantized output is always the ladder's answer for the scaled value.
  assert.equal(plan.retime('120ms', 1.5, true), `${plan.quantizeMs(180)}ms`)
})

test('isDiscrete sees only stepping curves', () => {
  assert.equal(plan.isDiscrete('steps(48,end)'), true)
  assert.equal(plan.isDiscrete('step-end'), true)
  assert.equal(plan.isDiscrete('step-start'), true)
  assert.equal(plan.isDiscrete('ease'), false)
  assert.equal(plan.isDiscrete('cubic-bezier(0.2, 0, 0, 1)'), false)
  assert.equal(plan.isDiscrete('linear'), false)
})

test('classify separates movement from effect', () => {
  assert.equal(plan.classify('transform'), 'spatial')
  assert.equal(plan.classify('opacity'), 'effects')
  // The default for anything unrecognized is the safe side: no overshoot.
  assert.equal(plan.classify('some-property-this-layer-never-heard-of'), 'effects')
  // `all` cannot be classified, so it must not be given an overshooting curve.
  assert.equal(plan.classify('all'), 'effects')
  // Mixed keyframe contents are spatial as soon as one member moves.
  assert.equal(plan.classifyAll(['opacity', 'transform']), 'spatial')
  assert.equal(plan.classifyAll(['opacity', 'background-color']), 'effects')
  assert.equal(plan.classifyAll([]), 'effects')
})

test('curveFor separates the domains only while the split is on', () => {
  for (const mode of ['m3', 'm3e']) {
    const effects = plan.curveFor(mode, 'effects', true, 120)
    // Turning the split off has to give every property the effect curve.
    assert.equal(plan.curveFor(mode, 'spatial', false, 120), effects, mode)
    // The effect curve is the one the numeric table hands out, so the string and
    // the points cannot drift apart.
    assert.equal(effects, `cubic-bezier(${plan.effectCurvePoints(mode).join(', ')})`, mode)
  }
})

test('curveFor picks the expressive spatial curve by declared duration', () => {
  // 200ms is the boundary between the fast and the default spatial curve.
  const fast = plan.curveFor('m3e', 'spatial', true, 200)
  const slow = plan.curveFor('m3e', 'spatial', true, 201)
  assert.notEqual(fast, slow)
  // Longer travel keeps the same curve; only the boundary matters.
  assert.equal(plan.curveFor('m3e', 'spatial', true, 800), slow)
  // Not knowing the duration cannot pick the short one.
  assert.equal(plan.curveFor('m3e', 'spatial', true, undefined), slow)
})

test('effectCurvePoints never returns an overshooting curve', () => {
  for (const mode of ['m3', 'm3e']) {
    const points = plan.effectCurvePoints(mode)
    let peak = 0
    for (let step = 0; step <= 100; step += 1) peak = Math.max(peak, plan.easeCurve(points, step / 100))
    // Overshoot on a colour flashes through values the palette never contained.
    assert.ok(peak <= 1.0001, `${mode} effect curve peaked at ${peak}`)
  }
})

test('easeCurve matches the endpoints and stays monotonic for the shipped curves', () => {
  const points = plan.effectCurvePoints('m3e')
  assert.equal(plan.easeCurve(points, 0), 0)
  assert.ok(Math.abs(plan.easeCurve(points, 1) - 1) < 1e-9)
  let previous = 0
  for (let step = 1; step <= 100; step += 1) {
    const value = plan.easeCurve(points, step / 100)
    assert.ok(value >= previous - 1e-9, `not monotonic at ${step}`)
    previous = value
  }
  // Out-of-range input is clamped rather than extrapolated.
  assert.equal(plan.easeCurve(points, -1), 0)
  assert.ok(Math.abs(plan.easeCurve(points, 2) - 1) < 1e-9)
})

test('quantizeMs is idempotent and monotonic', () => {
  // Snapping an already-snapped value must not move it.
  for (const value of [0, 33, 74, 76, 120, 180, 462, 999, 5000]) {
    const once = plan.quantizeMs(value)
    assert.equal(plan.quantizeMs(once), once, `quantizeMs not idempotent at ${value}`)
  }
  // More time in never comes out as less time.
  let previous = 0
  for (let value = 0; value <= 1200; value += 7) {
    const snapped = plan.quantizeMs(value)
    assert.ok(snapped >= previous, `not monotonic at ${value}`)
    previous = snapped
  }
  // Values beyond the ladder clamp to its ends instead of extrapolating.
  assert.equal(plan.quantizeMs(-100), plan.quantizeMs(0))
  assert.equal(plan.quantizeMs(60000), plan.quantizeMs(5000))
})
