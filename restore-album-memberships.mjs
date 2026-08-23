#!/usr/bin/env node
// Final step: Re-add re-uploaded photos to their original albums.
// Requires:
//   - item.albums populated by save-album-memberships.mjs (run before step 4)
//   - item.newMediaKey populated by verify-reupload.mjs (run after step 5)
//
// Groups items by album and calls zy2MWb in batches to restore membership.
// Safe to re-run — already-restored items are skipped.

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';

const CDP_URL = 'http://127.0.0.1:9222';
const MANIFEST_FILE = fileURLToPath(new URL('./manifest.json', import.meta.url));
const BATCH_SIZE = 50; // max media keys per zy2MWb call

async function getCdpWebSocketUrl() {
  const resp = await fetch(`${CDP_URL}/json`);
  const tabs = await resp.json();
  const photosTab = tabs.find(t => t.url?.includes('photos.google.com'));
  if (!photosTab) throw new Error('No photos.google.com tab found');
  return photosTab.webSocketDebuggerUrl;
}

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, awaitPromise = true) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`JS error: ${result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)}`);
    return result.result?.value;
  }
}

async function connectCdp(wsUrl) {
  const { default: WebSocket } = await import('ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    ws.on('open', () => resolve(new CdpSession(ws)));
    ws.on('error', reject);
  });
}

function makeBatchExecuteExpr(tokens, rpcid, requestData) {
  const t = JSON.stringify(tokens);
  const r = JSON.stringify(rpcid);
  const d = JSON.stringify(requestData);
  return `
    (async () => {
      const tokens = ${t};
      const rpcid = ${r};
      const requestData = ${d};
      const wrappedData = [[[rpcid, JSON.stringify(requestData), null, 'generic']]];
      const body = 'f.req=' + encodeURIComponent(JSON.stringify(wrappedData))
                 + '&at=' + encodeURIComponent(tokens.at) + '&';
      const params = new URLSearchParams({
        rpcids: rpcid,
        'source-path': window.location.pathname,
        'f.sid': tokens.fsid,
        bl: tokens.bl,
        pageId: 'none',
        rt: 'c',
      });
      const url = 'https://photos.google.com' + tokens.path + 'data/batchexecute?' + params.toString();
      const resp = await fetch(url, {
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body, method: 'POST', credentials: 'include',
      });
      const text = await resp.text();
      const lines = text.split('\\n').filter(l => l.includes('wrb.fr'));
      if (!lines.length) return { error: 'No wrb.fr envelope', status: resp.status };
      try {
        const parsed = JSON.parse(lines[0]);
        return { status: resp.status, payload: JSON.parse(parsed[0][2]) };
      } catch (e) {
        return { error: 'Parse failed: ' + e.message, status: resp.status };
      }
    })()
  `;
}

async function addToAlbum(cdp, tokens, albumId, newMediaKeys) {
  // zy2MWb: add items to album
  // Format: [albumId, [[mediaKey1], [mediaKey2], ...]]
  const requestData = [albumId, newMediaKeys.map(k => [k])];
  const result = await cdp.evaluate(makeBatchExecuteExpr(tokens, 'zy2MWb', requestData), true);
  if (result?.error) {
    throw new Error(`zy2MWb failed (status ${result.status}): ${result.error}\n` +
      'If this RPC is stale, intercept XHR in Chrome DevTools while adding a photo to an album.');
  }
  return result;
}

async function run() {
  if (!existsSync(MANIFEST_FILE)) {
    throw new Error('manifest.json not found');
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));

  // Items ready to restore: have albums saved, have new media key from verify, not yet restored
  const toRestore = manifest.filter(item =>
    item.albums?.length > 0 &&
    item.newMediaKey &&
    !item.albumsRestored
  );

  const missingNewKey = manifest.filter(item =>
    item.albums?.length > 0 &&
    !item.newMediaKey &&
    !item.albumsRestored
  );

  console.log('=== Restore Album Memberships ===');
  console.log(`Ready to restore: ${toRestore.length}`);
  console.log(`Already restored: ${manifest.filter(i => i.albumsRestored).length}`);
  if (missingNewKey.length > 0) {
    console.log(`Waiting for newMediaKey (run verify-reupload.mjs first): ${missingNewKey.length}`);
  }

  if (toRestore.length === 0) {
    if (missingNewKey.length > 0) {
      console.log('\nRun verify-reupload.mjs to get new media keys, then run this script again.');
    } else {
      console.log('\nAll album memberships restored!');
    }
    return;
  }

  // Build album -> [newMediaKey] map
  const albumMap = new Map(); // albumId -> { albumTitle, newMediaKeys: [], items: [] }
  for (const item of toRestore) {
    for (const { albumId, albumTitle } of item.albums) {
      if (!albumMap.has(albumId)) albumMap.set(albumId, { albumTitle, newMediaKeys: [], items: [] });
      albumMap.get(albumId).newMediaKeys.push(item.newMediaKey);
      albumMap.get(albumId).items.push(item);
    }
  }

  console.log(`\nAlbums to update: ${albumMap.size}`);
  console.log('\nConnecting to CDP...');
  const wsUrl = await getCdpWebSocketUrl();
  const cdp = await connectCdp(wsUrl);

  const tokens = await cdp.evaluate(`
    (() => {
      const g = window.WIZ_global_data;
      if (!g) return { error: 'WIZ_global_data not found' };
      return { at: g.SNlM0e, fsid: g.FdrFJe, bl: g.cfb2h, path: g.eptZe };
    })()
  `);
  if (tokens?.error) throw new Error(tokens.error);
  console.log('Auth ready.\n');

  let albumsOk = 0;
  let albumErrors = 0;

  for (const [albumId, { albumTitle, newMediaKeys, items }] of albumMap) {
    process.stdout.write(`  "${albumTitle}" (${newMediaKeys.length} items)... `);

    try {
      // Process in batches to avoid oversized requests
      for (let i = 0; i < newMediaKeys.length; i += BATCH_SIZE) {
        const batch = newMediaKeys.slice(i, i + BATCH_SIZE);
        await addToAlbum(cdp, tokens, albumId, batch);
        await new Promise(r => setTimeout(r, 200));
      }
      console.log('OK');
      albumsOk++;
    } catch (e) {
      console.log(`FAIL: ${e.message.slice(0, 80)}`);
      albumErrors++;
      continue;
    }
  }

  // Mark items as restored only if all their albums succeeded
  let restoredCount = 0;
  for (const item of toRestore) {
    const allAlbumsOk = item.albums.every(({ albumId }) => {
      const entry = albumMap.get(albumId);
      return entry && !entry.failed;
    });
    if (allAlbumsOk) {
      item.albumsRestored = true;
      item.albumsRestoredAt = new Date().toISOString();
      restoredCount++;
    }
  }

  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));

  console.log(`\n=== Summary ===`);
  console.log(`Albums updated: ${albumsOk}`);
  console.log(`Albums failed: ${albumErrors}`);
  console.log(`Items marked as restored: ${restoredCount}`);

  if (albumErrors > 0) {
    console.log('\nSome albums failed. Re-run this script to retry.');
  } else {
    console.log('\nAll done! Photos are back in their albums.');
  }

  cdp.ws.close();
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
