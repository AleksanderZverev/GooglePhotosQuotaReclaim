import fs from 'fs';
import path from 'path';
import { connectCdp } from '../lib/cdp.mjs';
import { getTokens, enumerateAll, batchQuotaInfo } from '../lib/rpc.mjs';
import { readManifest, writeManifest } from '../lib/manifest.mjs';
import { adb, checkAdb, getAdbStatus } from '../lib/adb.mjs';
import { log, opStart, opEnd } from '../lib/sse.mjs';
import { DOWNLOADS_DIR } from '../lib/config.mjs';

export async function cleanupPixelStep() {
  opStart('cleanup-pixel');
  try {
    if (!checkAdb()) throw new Error('No ADB device selected. Plug in the Pixel 1 or choose a device.');
    const adbDev = getAdbStatus().current;
    if (adbDev) {
      log(`Using ADB device: ${adbDev.model || adbDev.serial}${adbDev.isPixel1 ? ' (Pixel 1)' : ''} [${adbDev.serial}]`);
    }
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
    log(`${downloadFiles.length} files in downloads/`);
    const manifest = readManifest();
    let matched = 0;
    for (const item of manifest) {
      if (item.downloaded && item.downloadedAs) continue;
      const fname = item.filename?.toLowerCase();
      if (!fname) continue;
      const localPath = downloadMap.get(fname);
      if (!localPath) continue;
      item.downloaded = true;
      item.downloadedAs = localPath;
      matched++;
    }
    writeManifest(manifest);
    const total = manifest.filter(i => i.consumesQuota).length;
    const summary = `Matched ${matched} files. Total quota: ${total}.`;
    log(summary, 'success');
    opEnd('match', true, summary);
    return { ok: true, matched };
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
