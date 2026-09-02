import { connectCdp } from '../lib/cdp.mjs';
import { getTokens, enumerateAll, batchQuotaInfo } from '../lib/rpc.mjs';
import { readManifest, writeManifest } from '../lib/manifest.mjs';
import { log, opStart, opEnd } from '../lib/sse.mjs';

function buildFilenameToItemMap(items) {
  const map = new Map();
  for (const i of items) {
    const name = (i.pushedAs || i.filename).toLowerCase();
    map.set(name, i);
    const noExt = name.replace(/\.[^.]+$/, '');
    if (noExt !== name && !map.has(noExt)) map.set(noExt, i);
  }
  return map;
}

function applyQuotaInfo(item, qi, newMediaKey) {
  if (item.verified === true) return null;
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
    const dedupKeyMap = new Map(items.filter(i => i.dedupKey).map(i => [i.dedupKey, i]));

    // Phase 1: scan library + archive (if needed) using enumerateAll which handles
    // pagination correctly without false early-exit on empty responses.
    let page = 0;
    const onPage = (p, total, pageItems) => {
      page = p;
      log(`Fetched page ${p} (${pageItems.length} items)`);
    };

    const libraryItems = await enumerateAll(cdp, tokens, { onPage });

    const hasArchived = items.some(i => i.isArchived);
    let archiveItems = [];
    if (hasArchived) {
      log('Scanning archive for archived items...');
      archiveItems = await enumerateAll(cdp, tokens, { archive: true, onPage });
    }

    // Phase 2: find candidates matching our manifest items, then quota-check only those.
    const allCloudItems = [...libraryItems, ...archiveItems];
    const allMediaKeys = allCloudItems.map(ci => ci?.[0]).filter(Boolean);
    const mediaToLcxiM = new Map(allCloudItems.filter(ci => ci?.[0]).map(ci => [ci[0], ci]));

    log(`Scanned ${allCloudItems.length} items. Checking quota (this takes a few minutes)...`);

    // batchQuotaInfo for all items — only way to get filenames (qi[2]) for matching.
    // Process in chunks with progress updates.
    const CHUNK = 500;
    const verified = new Set();
    for (let i = 0; i < allMediaKeys.length; i += CHUNK) {
      const chunk = allMediaKeys.slice(i, i + CHUNK);
      const qis = await batchQuotaInfo(cdp, tokens, chunk);
      for (const qi of qis) {
        const newMediaKey = qi?.[0];
        const fname = (typeof qi?.[2] === 'string' ? qi[2] : '').toLowerCase();
        const noExt = fname.replace(/\.[^.]+$/, '');
        let item = nameMap.get(fname) || nameMap.get(noExt);
        if (!item) {
          const dk = mediaToLcxiM.get(newMediaKey)?.[3];
          if (dk) item = dedupKeyMap.get(dk);
        }
        if (!item) continue;
        const key = applyQuotaInfo(item, qi, newMediaKey);
        if (key) verified.add(key);
      }
      log(`Progress: checked ${Math.min(i + CHUNK, allMediaKeys.length)}/${allMediaKeys.length}, verified ${verified.size}/${items.length}`);
      if (verified.size >= items.length) break;
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
