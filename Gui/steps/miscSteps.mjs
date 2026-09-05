import fs from 'fs';
import path from 'path';
import { connectCdp } from '../lib/cdp.mjs';
import { getTokens, enumerateAll, batchQuotaInfo } from '../lib/rpc.mjs';
import { readManifest, writeManifest } from '../lib/manifest.mjs';
import { adb, adbAsync, checkAdb, safeName } from '../lib/adb.mjs';
import { log, opStart, opEnd } from '../lib/sse.mjs';
import { stripExifThumbnail } from './trashReuploadStep.mjs';
import { DOWNLOADS_DIR } from '../lib/config.mjs';

export async function cleanupPixelStep() {
  opStart('cleanup-pixel');
  try {
    if (!checkAdb()) throw new Error('No ADB device connected');
    log('Removing files from /sdcard/DCIM/Camera/...');
    adb('shell rm /sdcard/DCIM/Camera/*');
    const summary = 'Pixel camera roll cleaned.';
    log(summary, 'success');
    opEnd('cleanup-pixel', true, summary);
    return { ok: true };
  } catch (err) {
    log(`Cleanup failed: ${err.message}`, 'error');
    opEnd('cleanup-pixel', false, err.message);
    return { ok: false, error: err.message };
  }
}

export async function matchManifestStep() {
  opStart('match');
  try {
    if (!fs.existsSync(DOWNLOADS_DIR)) throw new Error(`downloads/ not found at ${DOWNLOADS_DIR}`);
    const downloadFiles = fs.readdirSync(DOWNLOADS_DIR);
    const downloadMap = new Map(downloadFiles.map(f => [f.toLowerCase(), path.join(DOWNLOADS_DIR, f)]));
    // Map from basename-without-extension → first matching full path (for fallback)
    const downloadMapNoExt = new Map();
    for (const f of downloadFiles) {
      const base = path.basename(f, path.extname(f)).toLowerCase();
      if (!downloadMapNoExt.has(base)) downloadMapNoExt.set(base, path.join(DOWNLOADS_DIR, f));
    }
    log(`${downloadFiles.length} files in downloads/`);
    const manifest = readManifest();
    let matched = 0, matchedNoExt = 0;
    for (const item of manifest) {
      if (item.downloaded && item.downloadedAs) continue;
      const fname = item.filename?.toLowerCase();
      if (!fname) continue;
      let localPath = downloadMap.get(fname);
      if (localPath) {
        item.downloaded = true;
        item.downloadedAs = localPath;
        matched++;
      } else {
        const base = path.basename(fname, path.extname(fname));
        localPath = downloadMapNoExt.get(base);
        if (!localPath) continue;
        item.downloaded = true;
        item.downloadedAs = localPath;
        matchedNoExt++;
      }
    }
    writeManifest(manifest);
    const total = manifest.filter(i => i.consumesQuota).length;
    const extNote = matchedNoExt > 0 ? ` (${matchedNoExt} by name without extension)` : '';
    const summary = `Matched ${matched + matchedNoExt} files${extNote}. Total quota: ${total}.`;
    log(summary, 'success');
    opEnd('match', true, summary);
    return { ok: true, matched: matched + matchedNoExt };
  } catch (err) {
    log(`Match failed: ${err.message}`, 'error');
    opEnd('match', false, err.message);
    return { ok: false, error: err.message };
  }
}

export async function matchAlbumsStep({ albumIds }) {
  opStart('match');
  const cdp = await connectCdp();
  try {
    if (!fs.existsSync(DOWNLOADS_DIR)) throw new Error(`downloads/ not found at ${DOWNLOADS_DIR}`);
    const downloadFiles = fs.readdirSync(DOWNLOADS_DIR);
    const downloadMap = new Map(downloadFiles.map(f => [f.toLowerCase(), f]));
    log(`${downloadFiles.length} files in downloads/`);
    const tokens = await getTokens(cdp);
    const manifest = readManifest();
    const existingKeys = new Set(manifest.map(m => m.mediaKey));
    let added = 0, matched = 0;
    for (const albumId of albumIds) {
      log(`Enumerating album ${albumId}...`);
      const rawItems = await enumerateAll(cdp, tokens, { albumId });
      log(`  ${rawItems.length} items in album`);
      const keys = rawItems.map(i => i?.[0]).filter(Boolean);
      const qis = await batchQuotaInfo(cdp, tokens, keys);
      const quotaMap = new Map(qis.map(qi => [qi?.[0], qi]));
      const dedupMap = new Map(rawItems.filter(i => i?.[0] && i?.[3]).map(i => [i[0], i[3]]));
      for (const rawItem of rawItems) {
        const mediaKey = rawItem?.[0];
        if (!mediaKey) continue;
        const qi = quotaMap.get(mediaKey);
        const filename = qi?.[2] ?? '';
        if (!filename) continue;
        const matchedFile = downloadMap.get(filename.toLowerCase());
        if (!matchedFile) continue;
        matched++;
        const downloadedAs = path.join(DOWNLOADS_DIR, matchedFile);
        if (existingKeys.has(mediaKey)) {
          const existing = manifest.find(m => m.mediaKey === mediaKey);
          if (existing && !existing.downloadedAs) { existing.downloadedAs = downloadedAs; existing.downloaded = true; }
          continue;
        }
        manifest.push({
          mediaKey,
          dedupKey: dedupMap.get(mediaKey) || null,
          filename,
          sizeBytes: qi?.[5] ?? 0,
          consumesQuota: qi?.[30]?.[0] === 1,
          isOriginalQuality: qi?.[14] === 2,
          downloaded: true,
          downloadedAs,
        });
        existingKeys.add(mediaKey);
        added++;
      }
      log(`  Matched ${matched} files so far`);
    }
    writeManifest(manifest);
    const summary = `Matched ${matched} files. Added ${added} new items.`;
    log(summary, 'success');
    opEnd('match', true, summary);
    return { ok: true, matched, added };
  } catch (err) {
    log(`Match failed: ${err.message}`, 'error');
    opEnd('match', false, err.message);
    return { ok: false, error: err.message };
  } finally { cdp.close(); }
}

export async function pushFolderStep({ folderPath, concurrency = 3 } = {}) {
  opStart('push-folder');
  if (!folderPath) {
    const msg = 'folderPath is required';
    log(msg, 'error');
    opEnd('push-folder', false, msg);
    return { ok: false, error: msg };
  }
  if (!checkAdb()) {
    const msg = 'No ADB device connected';
    log(msg, 'error');
    opEnd('push-folder', false, msg);
    return { ok: false, error: msg };
  }
  try {
    if (!fs.existsSync(folderPath)) throw new Error(`Folder not found: ${folderPath}`);
    const allFiles = fs.readdirSync(folderPath)
      .filter(f => fs.statSync(path.join(folderPath, f)).isFile());
    if (!allFiles.length) {
      const msg = 'No files in the specified folder';
      log(msg, 'warn');
      opEnd('push-folder', true, msg);
      return { ok: true, done: 0 };
    }
    const poolSize = Math.max(1, Math.min(concurrency, 10));
    log(`Pushing ${allFiles.length} files from "${folderPath}" to Pixel (concurrency: ${poolSize}).`);
    let counter = 0, done = 0, errors = 0;
    const iter = allFiles[Symbol.iterator]();
    async function worker() {
      for (;;) {
        const { value: fname, done: d } = iter.next();
        if (d) break;
        const n = ++counter;
        const localPath = path.join(folderPath, fname);
        const pushName = safeName(fname);
        const remote = `/sdcard/DCIM/Camera/${pushName}`;
        try {
          log(`[${n}/${allFiles.length}] Pushing ${fname}...`);
          let fileBuf = fs.readFileSync(localPath);
          const fixedBuf = stripExifThumbnail(fileBuf);
          const tmpPath = fixedBuf !== fileBuf ? localPath + '.push_tmp' : null;
          if (tmpPath) fs.writeFileSync(tmpPath, fixedBuf);
          try {
            await adbAsync(`push "${tmpPath ?? localPath}" "${remote}"`);
          } finally {
            if (tmpPath) fs.unlinkSync(tmpPath);
          }
          try {
            await adbAsync(`shell content insert --uri content://media/external/images/media --bind "_data:s:${remote}" --bind "mime_type:s:image/jpeg" --bind "_display_name:s:${pushName}"`);
          } catch {}
          done++;
          log(`  ✓ ${fname}`);
        } catch (err) {
          log(`  ✗ ${fname}: ${err.message}`, 'error');
          errors++;
        }
      }
    }
    await Promise.all(Array.from({ length: poolSize }, worker));
    try {
      adb('shell am force-stop com.google.android.apps.photos');
      adb('shell am start -a android.intent.action.MAIN -n com.google.android.apps.photos/.home.HomeActivity');
      log('Photos app restarted.', 'success');
    } catch (err) { log(`Could not restart Photos: ${err.message}`, 'warn'); }
    const summary = `Pushed ${done}/${allFiles.length} files${errors ? `, ${errors} errors` : ''}.`;
    log(summary, errors > 0 ? 'warn' : 'success');
    opEnd('push-folder', errors === 0, summary);
    return { ok: true, done, errors };
  } catch (err) {
    log(`Push folder failed: ${err.message}`, 'error');
    opEnd('push-folder', false, err.message);
    return { ok: false, error: err.message };
  }
}

export async function switchAccountStep(accountPath) {
  opStart('switch-account');
  const cdp = await connectCdp();
  try {
    await cdp.send('Page.navigate', { url: `https://photos.google.com${accountPath}` });
    await new Promise(r => setTimeout(r, 3000));
    const tokens = await getTokens(cdp);
    const summary = `Switched to ${tokens.path}`;
    log(summary, 'success');
    opEnd('switch-account', true, summary);
    return { ok: true, path: tokens.path };
  } catch (err) {
    log(`Switch account failed: ${err.message}`, 'error');
    opEnd('switch-account', false, err.message);
    return { ok: false, error: err.message };
  } finally { cdp.close(); }
}
