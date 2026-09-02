import fs from 'fs';
import path from 'path';
import { connectCdp } from '../lib/cdp.mjs';
import { getTokens, enumerateAll, listAllAlbums } from '../lib/rpc.mjs';
import { readManifest, writeManifest } from '../lib/manifest.mjs';
import { adb, adbAsync, checkAdb, safeName } from '../lib/adb.mjs';
import { log, opStart, opEnd, isStopRequested } from '../lib/sse.mjs';

async function saveAlbumMembershipsForItems(cdp, tokens, manifest, itemsNeedingAlbums) {
  log(`Saving album memberships for ${itemsNeedingAlbums.length} items...`);
  const albums = await listAllAlbums(cdp, tokens);
  log(`Found ${albums.length} albums.`);
  const targetKeys = new Set(itemsNeedingAlbums.map(i => i.mediaKey));
  const keyToItem = new Map(manifest.map(i => [i.mediaKey, i]));
  for (let i = 0; i < albums.length; i++) {
    const { albumId, title } = albums[i];
    const albumItems = await enumerateAll(cdp, tokens, { albumId });
    for (const rawItem of albumItems) {
      const key = rawItem?.[0];
      if (!key || !targetKeys.has(key)) continue;
      const item = keyToItem.get(key);
      if (!item) continue;
      if (!item.albums) item.albums = [];
      if (!item.albums.find(a => a.albumId === albumId))
        item.albums.push({ albumId, albumTitle: title });
    }
    if ((i + 1) % 10 === 0) log(`  Albums: ${i + 1}/${albums.length}`);
  }
  writeManifest(manifest);
  log('Album memberships saved.', 'success');
}

async function trashPhoto(cdp, tokens, dedupKey) {
  const tr = await cdp.evaluate(`
    (async () => {
      const d = [null, 1, [${JSON.stringify(dedupKey)}], 3];
      const w = [[['XwAOJf', JSON.stringify(d), null, 'generic']]];
      const body = 'f.req=' + encodeURIComponent(JSON.stringify(w)) + '&at=' + encodeURIComponent(${JSON.stringify(tokens.at)}) + '&';
      const p = new URLSearchParams({ rpcids: 'XwAOJf', 'source-path': '/photos', 'f.sid': ${JSON.stringify(tokens.fsid)}, bl: ${JSON.stringify(tokens.bl)}, pageId: 'none', rt: 'c' });
      const r = await fetch(${JSON.stringify(`https://photos.google.com${tokens.path}data/batchexecute?`)} + p, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body,
      });
      const t = await r.text();
      return { status: r.status, hasError: t.includes('"er"'), body: t };
    })()`);
  if (tr.status !== 200 || tr.hasError) throw new Error(`Trash status=${tr.status} body=${tr.body}`);
}

async function permanentDeleteFromTrash(cdp, tokens, dedupKey) {
  const r = await cdp.evaluate(`
    (async () => {
      const d = [null, 2, [${JSON.stringify(dedupKey)}], 2];
      const w = [[['XwAOJf', JSON.stringify(d), null, 'generic']]];
      const body = 'f.req=' + encodeURIComponent(JSON.stringify(w)) + '&at=' + encodeURIComponent(${JSON.stringify(tokens.at)}) + '&';
      const p = new URLSearchParams({ rpcids: 'XwAOJf', 'source-path': '/trash', 'f.sid': ${JSON.stringify(tokens.fsid)}, bl: ${JSON.stringify(tokens.bl)}, pageId: 'none', rt: 'c' });
      const resp = await fetch(${JSON.stringify(`https://photos.google.com${tokens.path}data/batchexecute?`)} + p, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body,
      });
      const t = await resp.text();
      return { status: resp.status, hasError: t.includes('"er"'), body: t };
    })()`);
  if (r.status !== 200 || r.hasError) throw new Error(`XwAOJf/trash status=${r.status} hasError=${r.hasError} body=${r.body}`);
}

async function pushPhotoToPixel(item) {
  const rawName = path.basename(item.downloadedAs);
  const pushName = safeName(rawName);
  const remote = `/sdcard/DCIM/Camera/${pushName}`;
  await adbAsync(`push "${item.downloadedAs}" "${remote}"`);
  item.pushedAs = pushName;
  try {
    await adbAsync(`shell content insert --uri content://media/external/images/media --bind "_data:s:${remote}" --bind "mime_type:s:image/jpeg" --bind "_display_name:s:${pushName}"`);
  } catch {}
}

export async function trashReuploadStep({ mediaKeys: filterKeys, saveAlbumsFirst = true, emptyTrash = false, concurrency = 3 } = {}) {
  opStart('trash-reupload');
  if (!checkAdb()) {
    const msg = 'No ADB device connected';
    log(msg, 'error');
    opEnd('trash-reupload', false, msg);
    return { ok: false, error: msg };
  }
  const cdp = await connectCdp();
  try {
    const manifest = readManifest();
    const items = manifest.filter(i =>
      i.downloaded && i.downloadedAs && i.dedupKey && !i.reuploadComplete &&
      (filterKeys ? filterKeys.includes(i.mediaKey) : i.consumesQuota)
    );
    const missing = items.filter(i => !fs.existsSync(i.downloadedAs));
    if (missing.length > 0) {
      const msg = `${missing.length} files missing from disk.`;
      log(msg, 'error');
      opEnd('trash-reupload', false, msg);
      return { ok: false, error: msg };
    }
    if (!items.length) {
      const msg = 'No items ready for trash+reupload';
      log(msg, 'success');
      opEnd('trash-reupload', true, msg);
      return { ok: true, done: 0 };
    }
    const poolSize = Math.max(1, Math.min(concurrency, 10));
    log(`${items.length} items to process (concurrency: ${poolSize}).`);

    if (saveAlbumsFirst) {
      const itemsNeedingAlbums = items.filter(i => !i.albums);
      if (itemsNeedingAlbums.length > 0) {
        const tokens2 = await getTokens(cdp);
        await saveAlbumMembershipsForItems(cdp, tokens2, manifest, itemsNeedingAlbums);
      }
    }

    const tokens = await getTokens(cdp);
    let counter = 0;
    let completedCount = 0;
    let totalDone = 0;
    let totalErrors = 0;
    let wasStopped = false;
    const iter = items[Symbol.iterator]();

    async function worker() {
      for (;;) {
        if (isStopRequested()) { wasStopped = true; break; }
        const { value: item, done } = iter.next();
        if (done) break;

        const n = ++counter;
        const label = item.filename || item.mediaKey.slice(0, 16);
        try {
          log(`[${n}/${items.length}] Trashing ${label}...`);
          await trashPhoto(cdp, tokens, item.dedupKey);
          item.trashedAt = new Date().toISOString();

          if (emptyTrash) {
            try {
              await permanentDeleteFromTrash(cdp, tokens, item.dedupKey);
              log(`  Permanently deleted from trash: ${label}`);
            } catch (e) {
              log(`  Could not permanently delete: ${e.message}`, 'warn');
            }
          }

          await pushPhotoToPixel(item);
          item.reuploadComplete = true;
          item.reuploadedAt = new Date().toISOString();
          totalDone++;
          log(`  ✓ ${label}`);
        } catch (err) {
          log(`  ✗ ${label}: ${err.message}`, 'error');
          item.trashError = err.message;
          totalErrors++;
        }

        completedCount++;
        if (completedCount % 10 === 0) writeManifest(manifest);
      }
    }

    await Promise.all(Array.from({ length: poolSize }, worker));
    writeManifest(manifest);

    if (wasStopped) {
      log(`Stopped. Processed: ${completedCount}/${items.length}, pushed: ${totalDone}, errors: ${totalErrors}.`, 'warn');
    }

    try {
      adb('shell am force-stop com.google.android.apps.photos');
      adb('shell am start -a android.intent.action.MAIN -n com.google.android.apps.photos/.home.HomeActivity');
      log('Photos app restarted.', 'success');
    } catch (err) { log(`Could not restart Photos: ${err.message}`, 'warn'); }

    const summary = wasStopped
      ? `Stopped. ${totalDone} pushed, ${totalErrors} errors, ${items.length - completedCount} skipped.`
      : `Done: ${totalDone} processed, ${totalErrors} errors.`;
    log(summary, wasStopped || totalErrors > 0 ? 'warn' : 'success');
    opEnd('trash-reupload', !wasStopped && totalErrors === 0, summary);
    return { ok: true, done: totalDone, errors: totalErrors, stopped: wasStopped };
  } catch (err) {
    log(`Trash+Reupload failed: ${err.message}`, 'error');
    opEnd('trash-reupload', false, err.message);
    return { ok: false, error: err.message };
  } finally { cdp.close(); }
}
