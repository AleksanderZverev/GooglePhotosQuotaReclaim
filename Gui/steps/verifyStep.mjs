import { connectCdp } from '../lib/cdp.mjs';
import { getTokens, callRpc, batchQuotaInfo } from '../lib/rpc.mjs';
import { readManifest, writeManifest } from '../lib/manifest.mjs';
import { log, opStart, opEnd } from '../lib/sse.mjs';

function buildFilenameToItemMap(items) {
  const map = new Map();
  for (const i of items) {
    const name = (i.pushedAs || i.filename).toLowerCase();
    map.set(name, i);
    // Also index without extension as fallback
    const noExt = name.replace(/\.[^.]+$/, '');
    if (noExt !== name && !map.has(noExt)) map.set(noExt, i);
  }
  return map;
}

function applyQuotaInfo(item, qi, newMediaKey) {
  if (item.verified === true) return null; // already confirmed — skip
  if (qi?.[30]?.[0] !== 1 && qi?.[14] === 2) {
    item.verified = true;
    item.newMediaKey = newMediaKey ?? qi?.[0];
    item.verifiedAt = new Date().toISOString();
    return item.mediaKey;
  }
  item.verified = false;
  item.verifyNote = qi?.[30]?.[0] === 1 ? 'Still takes space' : 'Not original quality';
  return null;
}

export async function verifyStep() {
  opStart('verify');
  const cdp = await connectCdp();
  try {
    const manifest = readManifest();
    // verified !== true includes both undefined (not yet tried) and false (tried but still
    // consuming quota) — we want to re-check false items on subsequent runs
    const items = manifest.filter(i => i.reuploadComplete && i.verified !== true);
    if (!items.length) {
      const msg = 'No items to verify';
      log(msg, 'success');
      opEnd('verify', true, msg);
      return { ok: true, verified: 0 };
    }
    log(`Verifying ${items.length} items...`);
    const tokens = await getTokens(cdp);
    const nameMap = buildFilenameToItemMap(items);
    // dedupKey → item map for fast candidate lookup on each lcxiM page
    const dedupKeyMap = new Map(items.filter(i => i.dedupKey).map(i => [i.dedupKey, i]));

    // Phase 1: fetch pages sequentially (pageToken dependency), kick off quota checks in parallel.
    const verified = new Set();
    const pagePromises = [];
    let pageToken = null, page = 0;
    do {
      const payload = await callRpc(cdp, 'lcxiM', [pageToken, null, 500, null, 1, 1], tokens, { allowEmpty: true });
      if (!payload) break; // end of library — server returned empty response with no wrb.fr
      const pageItems = payload?.[0] ?? [];
      pageToken = payload?.[1] ?? null;
      page++;
      log(`Fetched page ${page} (${pageItems.length} items)`);
      const candidateKeys = pageItems.map(i => i?.[0]).filter(Boolean);
      if (candidateKeys.length > 0) {
        const pageMediaMap = new Map(pageItems.filter(i => i?.[0]).map(i => [i[0], i]));
        // Don't await — run quota checks for all pages concurrently with page fetching.
        pagePromises.push(batchQuotaInfo(cdp, tokens, candidateKeys).then(qis => ({ qis, pageMediaMap })));
      }
    } while (pageToken);

    // Phase 2: process all quota results (most are already done by now).
    if (page > 1) log(`Pages fetched: ${page}. Awaiting quota results...`);
    const pageResults = await Promise.all(pagePromises);
    for (const { qis, pageMediaMap } of pageResults) {
      for (const qi of qis) {
        const newMediaKey = qi?.[0];
        const fname = (qi?.[2] ?? '').toLowerCase();
        const noExt = fname.replace(/\.[^.]+$/, '');
        let item = nameMap.get(fname) || nameMap.get(noExt);
        // Fallback: match via dedupKey from the lcxiM item
        if (!item && dedupKeyMap.size > 0) {
          const rawItem = pageMediaMap.get(newMediaKey);
          if (rawItem?.[3]) item = dedupKeyMap.get(rawItem[3]);
        }
        if (!item) continue;
        const key = applyQuotaInfo(item, qi, newMediaKey);
        if (key) verified.add(key);
      }
    }

    writeManifest(manifest);
    const allDone = verified.size >= items.length;
    const summary = `Verified ${verified.size}/${items.length} items.${!allDone ? ' Run again after Pixel finishes backup.' : ''}`;
    log(summary, allDone ? 'success' : 'warn');
    opEnd('verify', allDone, summary);
    return { ok: true, verified: verified.size };
  } catch (err) {
    log(`Verify failed: ${err.message}`, 'error');
    opEnd('verify', false, err.message);
    return { ok: false, error: err.message };
  } finally { cdp.close(); }
}
