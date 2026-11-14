/**
 * Write `templates/dsh-tokens.json` from the palette mapping.
 *
 * The template is not hand-maintained: it is rendered from the same recipe list
 * the host maps `colors.json` with, so it always covers every token the plugin
 * themes. A template short of tokens is what leaves half an interface on the
 * shipped palette once a user relies on it instead of a colors file.
 *
 * Runs as part of `pnpm build`.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const work = join(root, 'node_modules', '.cache')
const bundle = join(work, 'tokens-template.mjs')

await mkdir(work, { recursive: true })
await build({ entryPoints: [join(root, 'src/palette.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm' })

// A bare absolute path is not a valid ESM specifier on Windows; the URL form is.
const { tokensTemplate, PALETTE_TOKENS } = await import(`${pathToFileURL(bundle).href}?v=${Date.now()}`)
const template = tokensTemplate()
const covered = new Set(Object.keys(template.light))
const missing = PALETTE_TOKENS.filter(token => !covered.has(token))
if (missing.length > 0) {
  throw new Error(`tokensTemplate() dropped ${missing.length} token(s): ${missing.join(', ')}`)
}

const outfile = join(root, 'templates/dsh-tokens.json')
await mkdir(dirname(outfile), { recursive: true })
await writeFile(outfile, `${JSON.stringify(template, null, 2)}\n`)
console.log(`ui-experience: wrote templates/dsh-tokens.json (${PALETTE_TOKENS.length} tokens per mode)`)
