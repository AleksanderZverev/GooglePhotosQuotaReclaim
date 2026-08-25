import { connectCdp } from '../lib/cdp.mjs';
import { getTokens, callRpc, enumerateAll, batchQuotaInfo, listAllAlbums } from '../lib/rpc.mjs';
import { readManifest, writeManifest } from '../lib/manifest.mjs';
import { log, opStart, opEnd } from '../lib/sse.mjs';

async function enumerateLibrary(cdp, tokens) {
  const items = [];
  await enumerateAll(cdp, tokens, {
    onPage: (p, total) => log(`Page ${p}: ${total} items`),
  }).then(r => items.push(...r));
  return { rawItems: items, albumToKeys: new Map(), albumTitleMap: new Map() };
}

async function enumerateSelectedAlbums(cdp, tokens, albumIds) {
  const allAlbums = await listAllAlbums(cdp, tokens);
  const albumTitleMap = new Map(allAlbums.map(a => [a.albumId, a.title]));
  const albumToKeys = new Map();
  const rawItems = [];
  for (const albumId of albumIds) {
    const title = albumTitleMap.get(albumId) || albumId.slice(-8);
    log(`Enumerating album "${title}"...`);
    const items = await enumerateAll(cdp, tokens, {
      albumId,
      onPage: (p, total) => log(`  Album page ${p}: ${total} items`),
    });
    rawItems.push(...items);
    albumToKeys.set(albumId, new Set(items.map(i => i?.[0]).filter(Boolean)));
  }
  return { rawItems, albumToKeys, albumTitleMap };
}

function deduplicateItems(rawItems) {
  const seen = new Set();
  return rawItems.filter(i => {
    const k = i?.[0];
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function buildDedupMap(uniqueItems) {
  return new Map(uniqueItems.filter(i => i?.[0] && i?.[3]).map(i => [i[0], i[3]]));
}

function buildQuotaManifestEntries(quotaInfos, existingKeys, dedupMap, albumToKeys, albumTitleMap) {
  const newEntries = [];
  for (const qi of quotaInfos) {
    const mediaKey = qi?.[0];
    if (!mediaKey || existingKeys.has(mediaKey)) continue;
    if (qi?.[30]?.[0] !== 1) continue;
    const itemAlbums = [];
    for (const [albumId, keys] of albumToKeys) {
      if (keys.has(mediaKey)) itemAlbums.push({ albumId, albumTitle: albumTitleMap.get(albumId) || '' });
    }
    newEntries.push({
      mediaKey,
      dedupKey: dedupMap.get(mediaKey) || null,
      filename: qi?.[2] ?? '',
      sizeBytes: qi?.[5] ?? 0,
      consumesQuota: true,
      isOriginalQuality: qi?.[14] === 2,
      albums: itemAlbums.length > 0 ? itemAlbums : undefined,
    });
    existingKeys.add(mediaKey);
  }
  return newEntries;
}

async function saveAlbumMemberships(cdp, tokens, manifest, albumIds, albumTitleMap) {
  const targetSet = new Set(manifest.filter(i => i.consumesQuota).map(i => i.mediaKey));
  if (targetSet.size === 0) return;

  let allAlbums = [];
  if (!albumIds?.length) {
    allAlbums = await listAllAlbums(cdp, tokens);
    albumTitleMap = new Map(allAlbums.map(a => [a.albumId, a.title]));
  } else {
    allAlbums = [...albumTitleMap.entries()].map(([albumId, title]) => ({ albumId, title }));
  }

  const albumsToCheck = albumIds?.length
    ? allAlbums.filter(a => !albumIds.includes(a.albumId))
    : allAlbums;

  if (albumsToCheck.length === 0) return;

  log(`Checking ${albumsToCheck.length} album${albumsToCheck.length !== 1 ? 's' : ''} for memberships...`);
  const keyToItem = new Map(manifest.map(i => [i.mediaKey, i]));
  let found = 0;
  for (const { albumId, title } of albumsToCheck) {
    const albumItems = await enumerateAll(cdp, tokens, { albumId });
    for (const rawItem of albumItems) {
      const key = rawItem?.[0];
      if (!key || !targetSet.has(key)) continue;
      const item = keyToItem.get(key);
      if (!item) continue;
      if (!item.albums) item.albums = [];
      if (!item.albums.find(a => a.albumId === albumId)) {
        item.albums.push({ albumId, albumTitle: title });
        found++;
      }
    }
  }
  if (found > 0) { writeManifest(manifest); log(`Saved ${found} album memberships.`, 'success'); }
  else log('No album memberships found.', 'info');
}

export async function scanStep({ albumIds } = {}) {
  opStart('scan');
  const cdp = await connectCdp();
  try {
    const tokens = await getTokens(cdp);
    log(`Scanning... (account: ${tokens.path})`);

    const { rawItems, albumToKeys, albumTitleMap } = albumIds?.length
      ? await enumerateSelectedAlbums(cdp, tokens, albumIds)
      : await enumerateLibrary(cdp, tokens);

    log(`Enumerated ${rawItems.length} items. Checking quota...`);
    const dedupMap = buildDedupMap(rawItems);
    const seen = new Set();
    const uniqueKeys = rawItems.map(i => i?.[0]).filter(k => k && !seen.has(k) && seen.add(k));
    const quotaInfos = await batchQuotaInfo(cdp, tokens, uniqueKeys);

    const manifest = readManifest();
    const existingKeys = new Set(manifest.map(m => m.mediaKey));
    const newEntries = buildQuotaManifestEntries(quotaInfos, existingKeys, dedupMap, albumToKeys, albumTitleMap);
    manifest.push(...newEntries);
    writeManifest(manifest);
    log(`Added ${newEntries.length} new quota items. Total quota: ${manifest.filter(i => i.consumesQuota).length}`, 'success');

    await saveAlbumMemberships(cdp, tokens, manifest, albumIds, albumTitleMap);

    const summary = `Done. ${manifest.filter(i => i.consumesQuota).length} quota items ready.`;
    log(summary, 'success');
    opEnd('scan', true, summary);
    return { ok: true, added: newEntries.length };
  } catch (err) {
    log(`Scan failed: ${err.message}`, 'error');
    opEnd('scan', false, err.message);
    return { ok: false, error: err.message };
  } finally { cdp.close(); }
}

async function enrichDedupKeys(cdp, tokens, manifest) {
  const needsEnrich = manifest.filter(i => !i.dedupKey);
  if (needsEnrich.length === 0) {
    log('All items already have dedupKeys.', 'success');
    return 0;
  }
  log(`Enriching ${needsEnrich.length} items...`);
  const targetKeys = new Set(needsEnrich.map(i => i.mediaKey));
  const found = new Map();
  let pageToken = null, page = 0;
  do {
    const payload = await callRpc(cdp, 'lcxiM', [pageToken, null, 500, null, 1, 1], tokens);
    const items = payload?.[0] ?? [];
    pageToken = payload?.[1] ?? null;
    page++;
    for (const item of items) {
      const key = item?.[0], dk = item?.[3];
      if (key && dk && targetKeys.has(key)) found.set(key, dk);
    }
    log(`  Page ${page}: ${found.size}/${targetKeys.size} found`);
    if (found.size === targetKeys.size) break;
  } while (pageToken);
  let enriched = 0;
  for (const item of manifest) {
    if (found.has(item.mediaKey)) { item.dedupKey = found.get(item.mediaKey); enriched++; }
  }
  writeManifest(manifest);
  const notFound = needsEnrich.length - enriched;
  log(`Enriched ${enriched}${notFound ? `, ${notFound} not found (may be archived)` : ''}.`, 'success');
  return enriched;
}

export async function scanFullStep({ albumIds } = {}) {
  const scanAll = !albumIds?.length;
  opStart('scan-full');
  const cdp = await connectCdp();
  try {
    const tokens = await getTokens(cdp);
    log(`Scanning... (account: ${tokens.path})`);

    const { rawItems, albumToKeys, albumTitleMap } = scanAll
      ? await enumerateLibrary(cdp, tokens)
      : await enumerateSelectedAlbums(cdp, tokens, albumIds);

    const uniqueItems = deduplicateItems(rawItems);
    log(`${uniqueItems.length} unique items. Checking quota...`);

    const dedupMap = buildDedupMap(uniqueItems);
    const mediaKeys = uniqueItems.map(i => i?.[0]).filter(Boolean);
    const quotaInfos = await batchQuotaInfo(cdp, tokens, mediaKeys);

    const manifest = readManifest();
    const existingKeys = new Set(manifest.map(m => m.mediaKey));
    const newEntries = buildQuotaManifestEntries(quotaInfos, existingKeys, dedupMap, albumToKeys, albumTitleMap);
    manifest.push(...newEntries);
    writeManifest(manifest);
    log(`Scan: ${newEntries.length} new quota items. Total: ${manifest.filter(i => i.consumesQuota).length}`, 'success');

    await enrichDedupKeys(cdp, tokens, manifest);
    await saveAlbumMemberships(cdp, tokens, manifest, albumIds, albumTitleMap);

    const totalQuota = manifest.filter(i => i.consumesQuota).length;
    const summary = `Done. ${totalQuota} quota items ready for processing.`;
    log(summary, 'success');
    opEnd('scan-full', true, summary);
    return { ok: true, added: newEntries.length };
  } catch (err) {
    log(`Scan failed: ${err.message}`, 'error');
    opEnd('scan-full', false, err.message);
    return { ok: false, error: err.message };
  } finally { cdp.close(); }
}
