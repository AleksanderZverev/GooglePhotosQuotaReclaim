import { connectCdp } from '../lib/cdp.mjs';
import { getTokens, enumerateAll, listAllAlbums } from '../lib/rpc.mjs';
import { readManifest, writeManifest } from '../lib/manifest.mjs';
import { log, opStart, opEnd } from '../lib/sse.mjs';

async function matchAlbumItemsToManifest(cdp, tokens, albums, targetKeys, keyToItem) {
  for (let i = 0; i < albums.length; i++) {
    const { albumId, title } = albums[i];
    const albumItems = await enumerateAll(cdp, tokens, { albumId });
    let matched = 0;
    for (const rawItem of albumItems) {
      const key = rawItem?.[0];
      if (!key || !targetKeys.has(key)) continue;
      const item = keyToItem.get(key);
      if (!item) continue;
      if (!item.albums) item.albums = [];
      if (!item.albums.find(a => a.albumId === albumId)) {
        item.albums.push({ albumId, albumTitle: title });
        matched++;
      }
    }
    log(`[${i + 1}/${albums.length}] "${title}": ${albumItems.length} items, ${matched} matched`);
  }
}

export async function saveAlbumsStep() {
  opStart('save-albums');
  const cdp = await connectCdp();
  try {
    const tokens = await getTokens(cdp);
    log('Listing albums...');
    const albums = await listAllAlbums(cdp, tokens);
    log(`Found ${albums.length} albums.`);
    const manifest = readManifest();
    const targetKeys = new Set(manifest.filter(i => i.consumesQuota || i.downloaded).map(i => i.mediaKey));
    const keyToItem = new Map(manifest.map(i => [i.mediaKey, i]));
    await matchAlbumItemsToManifest(cdp, tokens, albums, targetKeys, keyToItem);
    writeManifest(manifest);
    const withAlbums = manifest.filter(i => i.albums?.length > 0).length;
    const summary = `Done. ${withAlbums} items have album data.`;
    log(summary, 'success');
    opEnd('save-albums', true, summary);
    return { ok: true };
  } catch (err) {
    log(`Save albums failed: ${err.message}`, 'error');
    opEnd('save-albums', false, err.message);
    return { ok: false, error: err.message };
  } finally { cdp.close(); }
}

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
    const items = manifest.filter(i => i.verified && i.newMediaKey && i.albums?.length && !i.albumsRestored);
    if (!items.length) {
      const msg = 'No items to restore into albums';
      log(msg, 'success');
      opEnd('restore-albums', true, msg);
      return { ok: true, restored: 0 };
    }
    log(`Restoring ${items.length} items into albums...`);
    const tokens = await getTokens(cdp);
    const albumGroups = groupItemsByAlbum(items);
    let totalRestored = 0;
    for (const [albumId, { title, items: albumItems }] of albumGroups) {
      log(`Album "${title}": ${albumItems.length} items`);
      totalRestored += await restoreItemsIntoAlbum(cdp, tokens, albumId, albumItems);
      for (const item of albumItems) { item.albumsRestored = true; item.albumsRestoredAt = new Date().toISOString(); }
    }
    writeManifest(manifest);
    const summary = `Restored ${totalRestored} items into albums.`;
    log(summary, 'success');
    opEnd('restore-albums', true, summary);
    return { ok: true, restored: totalRestored };
  } catch (err) {
    log(`Restore albums failed: ${err.message}`, 'error');
    opEnd('restore-albums', false, err.message);
    return { ok: false, error: err.message };
  } finally { cdp.close(); }
}
