import { connectCdp } from '../lib/cdp.mjs';
import { getTokens, callRpc } from '../lib/rpc.mjs';
import { readManifest, writeManifest } from '../lib/manifest.mjs';
import { log, opStart, opEnd } from '../lib/sse.mjs';

async function findDedupKeysInLibrary(cdp, tokens, targetKeys) {
  const found = new Map();
  let pageToken = null, page = 0;
  do {
    const payload = await callRpc(cdp, 'lcxiM', [pageToken, null, 500, null, 1, 1], tokens);
    const items = payload?.[0] ?? [];
    pageToken = payload?.[1] ?? null;
    page++;
    for (const item of items) {
      const key = item?.[0], dedupKey = item?.[3];
      if (key && dedupKey && targetKeys.has(key)) found.set(key, dedupKey);
    }
    log(`Page ${page}: ${found.size}/${targetKeys.size} found`);
    if (found.size === targetKeys.size) break;
  } while (pageToken);
  return found;
}

function applyDedupKeys(manifest, found) {
  let enriched = 0;
  for (const item of manifest) {
    if (found.has(item.mediaKey)) { item.dedupKey = found.get(item.mediaKey); enriched++; }
  }
  return enriched;
}

export async function enrichStep() {
  opStart('enrich');
  const cdp = await connectCdp();
  try {
    const manifest = readManifest();
    const needsEnrich = manifest.filter(i => !i.dedupKey);
    if (!needsEnrich.length) {
      const msg = 'All items already have dedupKeys';
      log(msg, 'success');
      opEnd('enrich', true, msg);
      return { ok: true, enriched: 0 };
    }
    log(`Enriching ${needsEnrich.length} items...`);
    const tokens = await getTokens(cdp);
    const targetKeys = new Set(needsEnrich.map(i => i.mediaKey));
    const found = await findDedupKeysInLibrary(cdp, tokens, targetKeys);
    const enriched = applyDedupKeys(manifest, found);
    writeManifest(manifest);
    const notFound = needsEnrich.length - enriched;
    const summary = `Enriched ${enriched}.${notFound > 0 ? ` ${notFound} not found (may be archived).` : ''}`;
    log(summary, 'success');
    opEnd('enrich', true, summary);
    return { ok: true, enriched };
  } catch (err) {
    log(`Enrich failed: ${err.message}`, 'error');
    opEnd('enrich', false, err.message);
    return { ok: false, error: err.message };
  } finally { cdp.close(); }
}
