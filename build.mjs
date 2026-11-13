/**
 * Bundle build: esbuild emits the host half (lib/index.js) and the browser
 * half (lib/client.js) from TypeScript sources. The client bundle externalizes
 * `react`, which the DSH module loader supplies through the factory's
 * `require`; everything else is inlined.
 */

import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-typert-protocol',
    '@deepseek-ai/schemastery',
  ],
})

await build({
  entryPoints: ['src/client.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  external: ['react'],
})

console.log('ui-experience: built lib/index.js and lib/client.js')
