#!/usr/bin/env node
import { build } from 'esbuild';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { resolve } from 'path';

const RCEDIT = 'node_modules\\rcedit\\bin\\rcedit.exe';
function rcedit(exePath, opts) {
  const args = [exePath];
  if (opts.icon) args.push('--set-icon', opts.icon);
  if (opts['file-version']) args.push('--set-file-version', opts['file-version']);
  if (opts['product-version']) args.push('--set-product-version', opts['product-version']);
  for (const [k, v] of Object.entries(opts['version-string'] ?? {}))
    args.push('--set-version-string', k, v);
  execSync(`${RCEDIT} ${args.map(a => `"${a}"`).join(' ')}`, { stdio: 'inherit' });
}

mkdirSync('dist', { recursive: true });
mkdirSync('build', { recursive: true });

// ─── Step 1: esbuild — ESM → single CJS bundle, HTML inlined as string ────────
const inlineHtmlPlugin = {
  name: 'inline-html',
  setup(b) {
    b.onResolve({ filter: /indexHtml\.mjs$/ }, args => ({
      path: resolve(args.resolveDir, args.path.replace('indexHtml.mjs', 'indexHtml.prod.mjs')),
    }));
  },
};

console.log('1/3  esbuild → dist/bundle.cjs');
await build({
  entryPoints: ['server.mjs'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/bundle.cjs',
  loader: { '.html': 'text' },
  plugins: [inlineHtmlPlugin],
  banner: { js: 'const __importMetaUrl = require("url").pathToFileURL(__filename).href;' },
  define: { 'import.meta.url': '__importMetaUrl' },
  external: ['bufferutil', 'utf-8-validate'],
  minify: false,
  sourcemap: false,
});

// ─── Step 2: pkg — CJS bundle → .exe with embedded Node.js runtime ────────────
console.log('2/3  pkg → dist/gphotos-recovery.exe');
const pkgBin = process.platform === 'win32' ? 'node_modules\\.bin\\pkg.cmd' : 'node_modules/.bin/pkg';
execSync(
  `${pkgBin} dist/bundle.cjs --targets node20-win-x64 --output dist/gphotos-recovery.exe`,
  { stdio: 'inherit' }
);

// ─── Step 3: icon + hide console ──────────────────────────────────────────────
console.log('3/3  icon + GUI subsystem patch');

// Generate Google-Photos-style pinwheel ICO (16×16 and 32×32)
writeFileSync('build/icon.ico', createPhotosIco());

// Embed icon into exe
rcedit('dist/gphotos-recovery.exe', {
  icon: 'build/icon.ico',
  'version-string': { FileDescription: 'Google Photos Recovery', ProductName: 'Google Photos Recovery' },
  'file-version': '1.0.0.0',
  'product-version': '1.0.0.0',
});

// Patch Windows PE subsystem from CONSOLE (3) → GUI (2) to suppress the black console window
patchPeSubsystem('dist/gphotos-recovery.exe');

console.log('\n✓  dist/gphotos-recovery.exe ready');
console.log('   Drop it anywhere — manifest.json and downloads/ will be created next to it.');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function patchPeSubsystem(exePath) {
  const buf = Buffer.from(readFileSync(exePath));
  const peOff = buf.readUInt32LE(0x3C);
  if (buf.toString('ascii', peOff, peOff + 4) !== 'PE\0\0') throw new Error('Not a valid PE file');
  // Subsystem field: PE sig (4) + COFF header (20) + 68 bytes into Optional Header
  const subsystemOff = peOff + 4 + 20 + 68;
  const was = buf.readUInt16LE(subsystemOff);
  if (was === 2) { console.log('   subsystem already GUI'); return; }
  buf.writeUInt16LE(2, subsystemOff); // 2 = IMAGE_SUBSYSTEM_WINDOWS_GUI
  writeFileSync(exePath, buf);
  console.log(`   subsystem ${was} → 2 (GUI, console hidden)`);
}

function createPhotosIco() {
  // Build a 2-size ICO (16×16 + 32×32) with Google Photos pinwheel colors
  const sizes = [16, 32];
  const images = sizes.map(sz => makeIcoImage(sz));

  const dirSize = 6 + 16 * images.length;
  const totalSize = dirSize + images.reduce((s, i) => s + i.length, 0);
  const ico = Buffer.alloc(totalSize, 0);

  ico.writeUInt16LE(0, 0); // reserved
  ico.writeUInt16LE(1, 2); // type: icon
  ico.writeUInt16LE(images.length, 4);

  let offset = dirSize;
  images.forEach((img, i) => {
    const sz = sizes[i];
    const d = 6 + i * 16;
    ico.writeUInt8(sz, d);       // width  (0 = 256)
    ico.writeUInt8(sz, d + 1);   // height
    ico.writeUInt8(0,  d + 2);   // color count
    ico.writeUInt8(0,  d + 3);   // reserved
    ico.writeUInt16LE(1,  d + 4); // planes
    ico.writeUInt16LE(32, d + 6); // bit depth
    ico.writeUInt32LE(img.length, d + 8);
    ico.writeUInt32LE(offset,     d + 12);
    img.copy(ico, offset);
    offset += img.length;
  });

  return ico;
}

function makeIcoImage(size) {
  const W = size, H = size;
  const cx = W / 2 - 0.5, cy = H / 2 - 0.5;
  const outerR = W * 0.44;
  const innerR = W * 0.16;

  // BMP DIB: BITMAPINFOHEADER + XOR pixels (BGRA, bottom-up) + AND mask
  const maskStride = Math.ceil(W / 32) * 4; // rows padded to 4 bytes
  const imgSize = 40 + W * H * 4 + H * maskStride;
  const buf = Buffer.alloc(imgSize, 0);

  // BITMAPINFOHEADER
  buf.writeUInt32LE(40, 0);
  buf.writeInt32LE(W, 4);
  buf.writeInt32LE(H * 2, 8); // height×2 signals XOR+AND format
  buf.writeUInt16LE(1, 12);
  buf.writeUInt16LE(32, 14);

  // Petal colors as [R, G, B] — written in BMP's BGRA order
  const RED    = [0xEA, 0x43, 0x35];
  const YELLOW = [0xFB, 0xBC, 0x05];
  const BLUE   = [0x42, 0x85, 0xF4];
  const GREEN  = [0x34, 0xA8, 0x53];
  const WHITE  = [0xFF, 0xFF, 0xFF];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const bmpY = H - 1 - y; // BMP rows are bottom-up
      const off = 40 + (bmpY * W + x) * 4;
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      let c;
      if (dist > outerR || dist < innerR) c = WHITE;
      else if (dx >= 0 && dy <  0) c = RED;
      else if (dx >  0 && dy >= 0) c = YELLOW;
      else if (dx <= 0 && dy >  0) c = BLUE;
      else                          c = GREEN;

      buf[off]     = c[2]; // B
      buf[off + 1] = c[1]; // G
      buf[off + 2] = c[0]; // R
      buf[off + 3] = 0xFF; // A (fully opaque)
    }
  }
  // AND mask stays all-0 (opaque) — already zeroed by Buffer.alloc

  return buf;
}
