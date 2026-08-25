import { connectCdp } from '../lib/cdp.mjs';
import { getTokens, callRpc, batchQuotaInfo } from '../lib/rpc.mjs';
import { readManifest, writeManifest } from '../lib/manifest.mjs';
import { log, opStart, opEnd } from '../lib/sse.mjs';

function buildFilenameToItemMap(items) {
  return new Map(items.map(i => [(i.pushedAs || i.filename).toLowerCase(), i]));
}

function checkQuotaInfoAgainstItem(qi, nameMap) {
  const fname = (qi?.[2] ?? '').toLowerCase();
  const item = nameMap.get(fname);
  if (!item || item.verified !== undefined) return;
  if (qi?.[30]?.[0] !== 1 && qi?.[14] === 2) {
    item.verified = true;
    item.newMediaKey = qi?.[0];
    item.verifiedAt = new Date().toISOString();
    return item.mediaKey;
  } else {
    item.verified = false;
    item.verifyNote = qi?.[30]?.[0] === 1 ? 'Still takes space' : 'Not original quality';
  }
}

export async function verifyStep() {
  opStart('verify');
  const cdp = await connectCdp();
  try {
    const manifest = readManifest();
    const items = manifest.filter(i => i.reuploadComplete && !i.verified);
    if (!items.length) {
      const msg = 'No items to verify';
      log(msg, 'success');
      opEnd('verify', true, msg);
      return { ok: true, verified: 0 };
    }
    log(`Verifying ${items.length} items...`);
    const tokens = await getTokens(cdp);
    const nameMap = buildFilenameToItemMap(items);
    const verified = new Set();
    let pageToken = null, page = 0;
    do {
      const payload = await callRpc(cdp, 'lcxiM', [pageToken, null, 500, null, 1, 1], tokens);
      const pageItems = payload?.[0] ?? [];
      pageToken = payload?.[1] ?? null;
      page++;
      const pageKeys = pageItems.map(i => i?.[0]).filter(Boolean);
      if (pageKeys.length > 0) {
        const qis = await batchQuotaInfo(cdp, tokens, pageKeys);
        for (const qi of qis) {
          const verifiedKey = checkQuotaInfoAgainstItem(qi, nameMap);
          if (verifiedKey) verified.add(verifiedKey);
        }
      }
      log(`Page ${page} (${pageItems.length} items): ${verified.size}/${items.length} verified`);
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
