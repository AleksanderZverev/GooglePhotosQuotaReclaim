import { connectCdp } from '../lib/cdp.mjs';
import { getTokens, archivePhoto } from '../lib/rpc.mjs';
import { readManifest, writeManifest } from '../lib/manifest.mjs';
import { log, opStart, opEnd } from '../lib/sse.mjs';



async function restoreItemsIntoAlbum(cdp, tokens, albumId, albumItems) {
  const BATCH = 50;
  for (let i = 0; i < albumItems.length; i += BATCH) {
    const batch = albumItems.slice(i, i + BATCH);
    const raw = await cdp.evaluate(`
      (async () => {
        const rpcId = 'E1Cajb';
        const data = [${JSON.stringify(batch.map(it => it.newMediaKey))}, ${JSON.stringify(albumId)}];
        const wrapped = [[[rpcId, JSON.stringify(data), null, 'generic']]];
        const body = 'f.req=' + encodeURIComponent(JSON.stringify(wrapped)) + '&at=' + encodeURIComponent(${JSON.stringify(tokens.at)}) + '&';
        const params = new URLSearchParams({ rpcids: rpcId, 'source-path': '/album/' + ${JSON.stringify(albumId)}, 'f.sid': ${JSON.stringify(tokens.fsid)}, bl: ${JSON.stringify(tokens.bl)}, pageId: 'none', rt: 'c' });
        const resp = await fetch(${JSON.stringify(`https://photos.google.com${tokens.path}data/batchexecute?`)} + params, {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body,
        });
        const text = await resp.text();
        return { status: resp.status, ok: !text.includes('"er"') };
      })()`);
    if (raw.status !== 200 || !raw.ok) throw new Error(`E1Cajb HTTP ${raw.status} hasError=${!raw.ok}`);
  }
  return albumItems.length;
}

function groupItemsByAlbum(items) {
  const albumGroups = new Map();
  for (const item of items) {
    for (const a of item.albums) {
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
    const albumItems = manifest.filter(i => i.verified && i.newMediaKey && i.albums?.length && !i.albumsRestored);
    let totalRestored = 0;
    if (albumItems.length) {
      log(`Restoring ${albumItems.length} items into albums...`);
      const albumGroups = groupItemsByAlbum(albumItems);
      for (const [albumId, { title, items: grpItems }] of albumGroups) {
        log(`Album "${title}": ${grpItems.length} items`);
        totalRestored += await restoreItemsIntoAlbum(cdp, tokens, albumId, grpItems);
        for (const item of grpItems) { item.albumsRestored = true; item.albumsRestoredAt = new Date().toISOString(); }
      }
      writeManifest(manifest);
      log(`Restored ${totalRestored} items into albums.`, 'success');
    }

    // --- Part 2: Re-archive photos that were originally archived ---
    const toArchive = manifest.filter(i => i.verified && i.newMediaKey && i.isArchived && !i.archivedRestored);
    let archivedCount = 0;
    if (toArchive.length) {
      log(`Re-archiving ${toArchive.length} items...`);
      for (const item of toArchive) {
        const label = item.filename || item.mediaKey.slice(0, 16);
        try {
          await archivePhoto(cdp, tokens, item.dedupKey);
          item.archivedRestored = true;
          item.archivedRestoredAt = new Date().toISOString();
          archivedCount++;
          log(`  Archived: ${label}`);
        } catch (err) {
          log(`  Archive failed ${label}: ${err.message}`, 'warn');
        }
        await new Promise(r => setTimeout(r, 200));
      }
      writeManifest(manifest);
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
