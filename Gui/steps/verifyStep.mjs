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

    const verified = new Set();
    let pageToken = null, page = 0;
    do {
      const payload = await callRpc(cdp, 'lcxiM', [pageToken, null, 500, null, 1, 1], tokens);
      const pageItems = payload?.[0] ?? [];
      pageToken = payload?.[1] ?? null;
      page++;

      // Build mediaKey→rawItem map for this page (used for dedupKey reverse-lookup)
      const pageMediaMap = new Map(pageItems.filter(i => i?.[0]).map(i => [i[0], i]));

      // After re-upload the dedupKey changes, so filename matching must run on every page.
      const candidateKeys = pageItems.map(i => i?.[0]).filter(Boolean);

      if (candidateKeys.length > 0) {
        const qis = await batchQuotaInfo(cdp, tokens, candidateKeys);
        for (const qi of qis) {
          const newMediaKey = qi?.[0];
          // Try filename match first (works in all cases)
          const fname = (qi?.[2] ?? '').toLowerCase();
          const noExt = fname.replace(/\.[^.]+$/, '');
          let item = nameMap.get(fname) || nameMap.get(noExt);

          // Fallback: match via dedupKey from the original lcxiM item
          if (!item && dedupKeyMap.size > 0) {
            const rawItem = pageMediaMap.get(newMediaKey);
            if (rawItem?.[3]) item = dedupKeyMap.get(rawItem[3]);
          }

          if (!item) continue;
          const key = applyQuotaInfo(item, qi, newMediaKey);
          if (key) verified.add(key);
        }
      }

      log(`Page ${page} (${pageItems.length} items, ${candidateKeys.length} checked): ${verified.size}/${items.length} verified`);
      if (verified.size >= items.length) break;
    } while (pageToken);

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
