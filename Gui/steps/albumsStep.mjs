import { connectCdp } from '../lib/cdp.mjs';
import { getTokens, archivePhoto } from '../lib/rpc.mjs';
import { readManifest, writeManifest } from '../lib/manifest.mjs';
import { log, opStart, opEnd } from '../lib/sse.mjs';

const RESTORE_BATCH = 50;
const ARCHIVE_CONCURRENCY = 5;

// For shared/collaborative albums (laUYf RPC, source-path=/u/N/share/albumId)
async function restoreItemsIntoSharedAlbum(cdp, tokens, albumId, albumItems, onBatch) {
  const accountPrefix = (tokens.path.match(/^(\/u\/\d+\/)/) || ['', ''])[1];
  const sourcePath = accountPrefix + 'share/' + albumId;
  for (let i = 0; i < albumItems.length; i += RESTORE_BATCH) {
    const batch = albumItems.slice(i, i + RESTORE_BATCH);
    const keysWrapped = batch.map(it => [[it.newMediaKey]]);
    const data = [albumId, [2, null, keysWrapped, null, null, null, [1], null, null, null, null, null, null, 0]];
    const raw = await cdp.evaluate(`
      (async () => {
        const rpcId = 'laUYf';
        const data = ${JSON.stringify(data)};
        const wrapped = [[[rpcId, JSON.stringify(data), null, 'generic']]];
        const body = 'f.req=' + encodeURIComponent(JSON.stringify(wrapped)) + '&at=' + encodeURIComponent(${JSON.stringify(tokens.at)}) + '&';
        const params = new URLSearchParams({ rpcids: rpcId, 'source-path': ${JSON.stringify(sourcePath)}, 'f.sid': ${JSON.stringify(tokens.fsid)}, bl: ${JSON.stringify(tokens.bl)}, pageId: 'none', rt: 'c' });
        const resp = await fetch(${JSON.stringify(`https://photos.google.com${tokens.path}data/batchexecute?`)} + params, {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body,
        });
        const text = await resp.text();
        return { status: resp.status, ok: !text.includes('"er"'), body: text.slice(0, 500) };
      })()`);
    if (raw.status !== 200 || !raw.ok) throw new Error(`laUYf HTTP ${raw.status} ok=${raw.ok} body=${raw.body}`);
    if (onBatch) onBatch(Math.min(i + RESTORE_BATCH, albumItems.length), albumItems.length);
  }
  return albumItems.length;
}

// For personal albums (E1Cajb RPC, source-path=/u/N/album/albumId)
async function restoreItemsIntoPersonalAlbum(cdp, tokens, albumId, albumItems, onBatch) {
  const accountPrefix = (tokens.path.match(/^(\/u\/\d+\/)/) || ['', ''])[1];
  const sourcePath = accountPrefix + 'album/' + albumId;
  for (let i = 0; i < albumItems.length; i += RESTORE_BATCH) {
    const batch = albumItems.slice(i, i + RESTORE_BATCH);
    const raw = await cdp.evaluate(`
      (async () => {
        const rpcId = 'E1Cajb';
        const data = [${JSON.stringify(batch.map(it => it.newMediaKey))}, ${JSON.stringify(albumId)}];
        const wrapped = [[[rpcId, JSON.stringify(data), null, 'generic']]];
        const body = 'f.req=' + encodeURIComponent(JSON.stringify(wrapped)) + '&at=' + encodeURIComponent(${JSON.stringify(tokens.at)}) + '&';
        const params = new URLSearchParams({ rpcids: rpcId, 'source-path': ${JSON.stringify(sourcePath)}, 'f.sid': ${JSON.stringify(tokens.fsid)}, bl: ${JSON.stringify(tokens.bl)}, pageId: 'none', rt: 'c' });
        const resp = await fetch(${JSON.stringify(`https://photos.google.com${tokens.path}data/batchexecute?`)} + params, {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body,
        });
        const text = await resp.text();
        return { status: resp.status, ok: !text.includes('"er"'), body: text.slice(0, 500) };
      })()`);
    if (raw.status !== 200 || !raw.ok) throw new Error(`E1Cajb HTTP ${raw.status} ok=${raw.ok} body=${raw.body}`);
    if (onBatch) onBatch(Math.min(i + RESTORE_BATCH, albumItems.length), albumItems.length);
  }
  return albumItems.length;
}

// An album is "shared/collaborative" if isSharedAlbum:true (from scan) or has isOtherOwner items (legacy fallback).
// Those albums require laUYf RPC with source-path=/u/N/share/albumId.
function buildSharedAlbumSet(manifest) {
  const sharedIds = new Set();
  for (const item of manifest) {
    for (const a of item.albums || []) {
      if (a.isSharedAlbum || a.isOtherOwner) sharedIds.add(a.albumId);
    }
  }
  return sharedIds;
}

function groupItemsByAlbum(items) {
  const albumGroups = new Map();
  for (const item of items) {
    for (const a of item.albums) {
      if (a.isOtherOwner) continue; // photo belongs to another user in this album — skip restore
      if (!albumGroups.has(a.albumId)) albumGroups.set(a.albumId, { title: a.albumTitle, items: [] });
      albumGroups.get(a.albumId).items.push(item);
    }
  }
  return albumGroups;
}

export async function restoreAlbumsStep() {
  opStart('restore-albums');
  const cdp = await connectCdp();
  try {
    const manifest = readManifest();
    const tokens = await getTokens(cdp);

    // --- Part 1: Restore album memberships ---
    const albumItems = manifest.filter(i => i.verified && i.newMediaKey && i.albums?.some(a => !a.isOtherOwner) && !i.albumsRestored);
    let totalRestored = 0;
    if (albumItems.length) {
      log(`Restoring ${albumItems.length} items into albums...`);
      const albumGroups = groupItemsByAlbum(albumItems);
      const sharedAlbumIds = buildSharedAlbumSet(manifest);
      log(`Album groups to restore: ${albumGroups.size}`);
      for (const [albumId, { title, items: grpItems }] of albumGroups) {
        const isShared = sharedAlbumIds.has(albumId);
        log(`Album "${title}" (${albumId.slice(-8)}) [${isShared ? 'shared' : 'personal'}]: ${grpItems.length} items, keys: ${grpItems.map(i => i.newMediaKey?.slice(0,8)).join(',')}`);
        const restoreFn = isShared ? restoreItemsIntoSharedAlbum : restoreItemsIntoPersonalAlbum;
        await restoreFn(cdp, tokens, albumId, grpItems, (done, total) => {
          if (total > RESTORE_BATCH) log(`  "${title}": ${done}/${total}`);
        });
        totalRestored += grpItems.length;
        for (const item of grpItems) { item.albumsRestored = true; item.albumsRestoredAt = new Date().toISOString(); }
        writeManifest(manifest);
        log(`  Progress: ${totalRestored}/${albumItems.length} total restored`);
      }
      log(`Restored ${totalRestored} items into albums.`, 'success');
    }

    // --- Part 2: Re-archive photos that were originally archived ---
    const toArchive = manifest.filter(i => i.verified && i.newMediaKey && i.isArchived && !i.archivedRestored);
    let archivedCount = 0;
    if (toArchive.length) {
      log(`Re-archiving ${toArchive.length} items...`);
      for (let i = 0; i < toArchive.length; i += ARCHIVE_CONCURRENCY) {
        const batch = toArchive.slice(i, i + ARCHIVE_CONCURRENCY);
        await Promise.all(batch.map(async item => {
          const label = item.filename || item.mediaKey.slice(0, 16);
          try {
            await archivePhoto(cdp, tokens, item.newMediaKey);
            item.archivedRestored = true;
            item.archivedRestoredAt = new Date().toISOString();
            archivedCount++;
          } catch (err) {
            log(`  Archive failed ${label}: ${err.message}`, 'warn');
          }
        }));
        log(`  Re-archiving: ${Math.min(i + ARCHIVE_CONCURRENCY, toArchive.length)}/${toArchive.length}`);
        writeManifest(manifest);
        await new Promise(r => setTimeout(r, 50));
      }
      log(`Archived ${archivedCount}/${toArchive.length} items.`, archivedCount === toArchive.length ? 'success' : 'warn');
    }

    if (!albumItems.length && !toArchive.length) {
      const msg = 'No items to restore into albums or re-archive';
      log(msg, 'success');
      opEnd('restore-albums', true, msg);
      return { ok: true, restored: 0, archived: 0 };
    }

    const summary = [
      totalRestored ? `${totalRestored} items restored into albums` : '',
      archivedCount ? `${archivedCount} items re-archived` : '',
    ].filter(Boolean).join(', ') + '.';
    log(summary, 'success');
    opEnd('restore-albums', true, summary);
    return { ok: true, restored: totalRestored, archived: archivedCount };
  } catch (err) {
    log(`Restore albums failed: ${err.message}`, 'error');
    opEnd('restore-albums', false, err.message);
    return { ok: false, error: err.message };
  } finally { cdp.close(); }
}
