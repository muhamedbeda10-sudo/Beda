// Bundles the API into a single ESM file for Azure App Service.
//
// The shared domain package (`@qc/shared`) is TypeScript source, so it must be
// bundled in; every real dependency stays external and is installed from
// package.json on the App Service with `npm ci --omit=dev`.
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const external = Object.keys(pkg.dependencies).filter((d) => d !== '@qc/shared')

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/index.js',
  sourcemap: true,
  external,
  banner: {
    // esbuild's ESM output has no `require`; a few CommonJS dependencies
    // (express, pg) are reached through it when bundled. Provide one.
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'info',
})
