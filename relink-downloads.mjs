#!/usr/bin/env node
// Utility: re-link manifest to files already present in ./downloads/.
// Use when files were downloaded in a different environment (different machine
// or directory) and manifest.json has wrong/missing downloadedAs paths.
//
// Matches files by filename. Reports unmatched items at the end.

import { writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const MANIFEST_FILE = fileURLToPath(new URL('./manifest.json', import.meta.url));
const DOWNLOADS_DIR = fileURLToPath(new URL('./downloads/', import.meta.url));

function getSafeName(item) {
  // Must match the regex in batch-download.mjs exactly — spaces are NOT replaced there,
  // so downloaded files keep spaces in their names.
  const filename = item.filename || `${item.mediaKey}.bin`;
  return filename.replace(/[/\\?%*:|"<>]/g, '_');
}

function run() {
  if (!existsSync(MANIFEST_FILE)) {
    throw new Error('manifest.json not found — run scan-quota-items.mjs first');
  }
  if (!existsSync(DOWNLOADS_DIR)) {
    throw new Error('./downloads/ folder not found');
  }

  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));

  // Build maps of all files in ./downloads/
  const downloadedFiles = new Map();     // lowercase basename -> full path
  const downloadedByBase = new Map();    // lowercase basename-without-ext -> full path (for ext mismatch)
  for (const name of readdirSync(DOWNLOADS_DIR)) {
    const fullPath = join(DOWNLOADS_DIR, name);
    if (statSync(fullPath).isFile()) {
      const lower = name.toLowerCase();
      downloadedFiles.set(lower, fullPath);
      const base = lower.includes('.') ? lower.slice(0, lower.lastIndexOf('.')) : lower;
      // Keep first match per base name (don't overwrite with a worse candidate)
      if (!downloadedByBase.has(base)) downloadedByBase.set(base, fullPath);
    }
  }

  console.log(`Files in ./downloads/: ${downloadedFiles.size}`);
  console.log(`Manifest items: ${manifest.length}`);

  // Find items that need relinking:
  // - downloaded: false / missing downloadedAs
  // - OR downloadedAs path no longer exists on disk
  const needRelink = manifest.filter(item =>
    item.mediaKey && item.consumesQuota &&
    (!item.downloaded || !item.downloadedAs || !existsSync(item.downloadedAs))
  );

  console.log(`Items needing relink: ${needRelink.length}\n`);

  if (needRelink.length === 0) {
    console.log('All items already linked correctly. Nothing to do.');
    return;
  }

  // Build duplicate-detection map (same logic as batch-download.mjs)
  const nameCounts = new Map();
  for (const item of manifest) {
    const name = item.filename || `${item.mediaKey}.bin`;
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  }

  function getUniqueName(item) {
    const filename = item.filename || `${item.mediaKey}.bin`;
    const safeName = getSafeName(item);
    if ((nameCounts.get(filename) || 0) > 1) {
      const ext = safeName.includes('.') ? safeName.slice(safeName.lastIndexOf('.')) : '';
      const base = safeName.includes('.') ? safeName.slice(0, safeName.lastIndexOf('.')) : safeName;
      return `${base}_${item.mediaKey.slice(-8)}${ext}`;
    }
    return safeName;
  }

  let linked = 0;
  let notFound = 0;

  for (const item of needRelink) {
    const expectedName = getUniqueName(item);

    const lower = expectedName.toLowerCase();
    const base = lower.includes('.') ? lower.slice(0, lower.lastIndexOf('.')) : lower;

    // 1. Exact match (case-insensitive)
    const fullPath = downloadedFiles.get(lower)
      // 2. Same base name, different extension (e.g. manifest says .png but file is .jpg)
      || downloadedByBase.get(base);

    if (fullPath) {
      const actualName = fullPath.replace(/.*[/\\]/, '');
      const note = actualName.toLowerCase() !== expectedName.toLowerCase()
        ? ` (ext mismatch: manifest="${expectedName}", file="${actualName}")`
        : '';
      item.downloaded = true;
      item.downloadedAs = fullPath;
      linked++;
      console.log(`  LINKED  ${actualName}${note}`);
    } else {
      notFound++;
      console.log(`  MISSING ${expectedName}`);
    }
  }

  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));

  console.log(`\n=== Summary ===`);
  console.log(`Linked: ${linked}`);
  console.log(`Not found in ./downloads/: ${notFound}`);

  if (notFound > 0) {
    console.log(`\nFor missing items, run: npm run download`);
    console.log('It will skip already-linked items and download only what\'s missing.');
  } else {
    console.log('\nAll items linked. You can now run npm run enrich (if not done) or npm run albums-save.');
  }
}

try {
  run();
} catch (err) {
  console.error('Fatal:', err.message);
  process.exit(1);
}
