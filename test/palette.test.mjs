/**
 * Tests for the generated matugen template's format: every entry must carry one
 * placeholder of its own mode, optionally wrapped in `color-mix`, because that
 * is what matugen substitutes into and what the host's value check accepts. A
 * template that drifts from that shape produces a file the host refuses, or one
 * whose light table quietly carries dark values. Coverage (every mapped token
 * present in both modes) is asserted by the generator itself, which refuses to
 * write a short file; file reading, path expansion and the Remote endpoints are
 * exercised against a running DSH.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const work = mkdtempSync(join(tmpdir(), 'dsh-uix-palette-'))
const outfile = join(work, 'palette.mjs')
await build({
  entryPoints: ['src/palette.ts'],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
})
const palette = await import(pathToFileURL(outfile).href)
// `exit` cannot await, so the cleanup must be synchronous.
process.on('exit', () => { rmSync(work, { recursive: true, force: true }) })

test('template values are matugen placeholders of their own mode', () => {
  const template = palette.tokensTemplate()
  for (const mode of ['light', 'dark']) {
    for (const [token, value] of Object.entries(template[mode])) {
      // Either a bare placeholder or one wrapped in color-mix; both forms must
      // name the token's own mode, since matugen fills each independently.
      const placeholders = [...value.matchAll(/\{\{colors\.([a-z_]+)\.([a-z]+)\.hex\}\}/gu)]
      assert.equal(placeholders.length, 1, `${token} should carry exactly one placeholder, got ${value}`)
      assert.equal(placeholders[0][2], mode, `${token} placeholder should be ${mode}`)
      assert.ok(palette.MATUGEN_ROLES.includes(placeholders[0][1]), `${token} names an unknown role`)
      assert.match(value, /^(?:color-mix\(in srgb, \{\{colors\.[a-z_]+\.[a-z]+\.hex\}\}, (?:white|transparent) \d+%\)|\{\{colors\.[a-z_]+\.[a-z]+\.hex\}\})$/u)
    }
  }
})

test('a missing role is reported, not mapped to undefined', () => {
  const partial = Object.fromEntries(palette.MATUGEN_ROLES.map(role => [role, '#123456']))
  delete partial.scrim
  assert.throws(() => palette.mapColors(partial), /scrim/u)
})
