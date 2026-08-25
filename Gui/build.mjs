#!/usr/bin/env node
// Build pipeline: esbuild (ESM→CJS bundle with inlined HTML) → pkg (CJS→.exe)

import { build } from 'esbuild';
import { execSync } from 'child_process';
import { mkdirSync } from 'fs';
import { resolve } from 'path';

mkdirSync('dist', { recursive: true });

// Swap indexHtml.mjs → indexHtml.prod.mjs so esbuild inlines the HTML as a string
const inlineHtmlPlugin = {
  name: 'inline-html',
  setup(b) {
    b.onResolve({ filter: /indexHtml\.mjs$/ }, args => ({
      path: resolve(args.resolveDir, args.path.replace('indexHtml.mjs', 'indexHtml.prod.mjs')),
    }));
  },
};

console.log('Step 1/2 — esbuild: bundling into CJS...');
await build({
  entryPoints: ['server.mjs'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/bundle.cjs',
  loader: { '.html': 'text' },
  plugins: [inlineHtmlPlugin],
  // import.meta.url → CJS-compatible equivalent (used for __dirname in config.mjs)
  banner: { js: 'const __importMetaUrl = require("url").pathToFileURL(__filename).href;' },
  define: { 'import.meta.url': '__importMetaUrl' },
  // ws optional native bindings — not needed, ws works without them
  external: ['bufferutil', 'utf-8-validate'],
  minify: false,
  sourcemap: false,
});
console.log('  → dist/bundle.cjs');

console.log('Step 2/2 — pkg: packaging into .exe...');
const pkgBin = process.platform === 'win32' ? 'node_modules\\.bin\\pkg.cmd' : 'node_modules/.bin/pkg';
execSync(
  `${pkgBin} dist/bundle.cjs --targets node20-win-x64 --output dist/gphotos-recovery.exe --compress GZip`,
  { stdio: 'inherit' }
);
console.log('  → dist/gphotos-recovery.exe');
console.log('\nDone. Place gphotos-recovery.exe anywhere — manifest.json and downloads/ will be created next to it.');
