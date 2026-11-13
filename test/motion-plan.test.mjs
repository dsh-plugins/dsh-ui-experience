/**
 * Tests for the pure motion-planning rules: CSS value splitting, duration
 * parsing and retiming, property classification, curve selection, and the
 * Bézier evaluation the scripted reveal uses. Everything here locks a rule that
 * the TypeScript types cannot express; the CSSOM traversal and the scrolling
 * layer are exercised against a browser instead.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const work = await mkdtemp(join(tmpdir(), 'dsh-uix-plan-'))
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
process.on('exit', () => { void rm(work, { recursive: true, force: true }) })

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

test('retime scales and quantizes', () => {
  assert.equal(plan.retime('120ms', 1.5, false), '180ms')
  assert.equal(plan.retime('120ms', 1.5, true), '200ms')
  assert.equal(plan.retime('300ms', 0.5, false), '150ms')
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
  for (const property of ['transform', 'width', 'grid-template-columns', 'gap', 'margin-left', 'border-radius']) {
    assert.equal(plan.classify(property), 'spatial', property)
  }
  for (const property of ['opacity', 'background-color', 'color', 'box-shadow', 'filter', 'all']) {
    assert.equal(plan.classify(property), 'effects', property)
  }
  // Mixed keyframe contents are spatial as soon as one member moves.
  assert.equal(plan.classifyAll(['opacity', 'width']), 'spatial')
  assert.equal(plan.classifyAll(['opacity', 'color']), 'effects')
  assert.equal(plan.classifyAll([]), 'effects')
})

test('curveFor picks by family, domain, split and declared duration', () => {
  assert.equal(plan.curveFor('m3', 'spatial', true, 120), 'cubic-bezier(0.05, 0.7, 0.1, 1)')
  assert.equal(plan.curveFor('m3', 'effects', true, 120), 'cubic-bezier(0.2, 0, 0, 1)')
  assert.equal(plan.curveFor('m3', 'spatial', false, 120), 'cubic-bezier(0.2, 0, 0, 1)')

  // 200ms is the boundary between the fast and default expressive curves.
  assert.equal(plan.curveFor('m3e', 'spatial', true, 200), 'cubic-bezier(0.42, 1.67, 0.21, 0.9)')
  assert.equal(plan.curveFor('m3e', 'spatial', true, 201), 'cubic-bezier(0.38, 1.21, 0.22, 1)')
  assert.equal(plan.curveFor('m3e', 'effects', true, 120), 'cubic-bezier(0.34, 0.8, 0.34, 1)')
  assert.equal(plan.curveFor('m3e', 'spatial', false, 120), 'cubic-bezier(0.34, 0.8, 0.34, 1)')
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

test('quantizeMs snaps to the nearest Material step', () => {
  assert.equal(plan.quantizeMs(0), 50)
  assert.equal(plan.quantizeMs(74), 50)
  assert.equal(plan.quantizeMs(76), 100)
  assert.equal(plan.quantizeMs(462), 450)
  assert.equal(plan.quantizeMs(5000), 1000)
})
