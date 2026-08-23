#!/usr/bin/env node
// Step 3b: Save album memberships before the destructive trash step.
// Enumerates all albums, finds which manifest items appear in each,
// and stores album IDs/titles in manifest for later restoration.
//
// Run AFTER enrich-dedupkeys and BEFORE batch-trash-reupload.
// Safe to re-run — only overwrites the `albums` field per item.

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';

const CDP_URL = 'http://127.0.0.1:9222';
const MANIFEST_FILE = fileURLToPath(new URL('./manifest.json', import.meta.url));

// RPC IDs for album operations.
// If Google changes these, intercept XHR in Chrome DevTools (Network tab,
// filter by "batchexecute") while browsing your albums to find the new ones.
const RPC_LIST_ALBUMS = 'F2A0H';   // lists all user albums
const RPC_ALBUM_ITEMS = 'lcxiM';   // same RPC as library, but with albumId

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

// Safe batchexecute helper — embeds tokens via JSON.stringify to avoid injection.
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
        return { payload: JSON.parse(parsed[0][2]) };
      } catch (e) {
        return { error: 'Parse failed: ' + e.message };
      }
    })()
  `;
}

async function listAllAlbums(cdp, tokens) {
  const albums = [];
  let pageToken = null;

  while (true) {
    // F2A0H: [pageToken, null, pageSize]
    const result = await cdp.evaluate(makeBatchExecuteExpr(tokens, RPC_LIST_ALBUMS, [pageToken, null, 100]), true);

    if (result?.error) {
      throw new Error(`Album listing (${RPC_LIST_ALBUMS}) failed: ${result.error}\n` +
        'If this RPC is stale, intercept XHR in Chrome DevTools while browsing your albums.');
    }

    const albumPage = result.payload?.[0] || [];
    if (!Array.isArray(albumPage) || albumPage.length === 0) break;

    for (const a of albumPage) {
      // Typical album entry: [albumId, ?, title, ?, ?, ?, ?, ?, itemCount, ...]
      const albumId = a?.[0];
      // Try common positions for the title
      const albumTitle = (typeof a?.[2] === 'string' && a[2]) ||
                         (typeof a?.[3] === 'string' && a[3]) ||
                         `(untitled ${albumId?.slice(-6)})`;
      if (albumId) albums.push({ albumId, albumTitle });
    }

    const nextPageToken = result.payload?.[1] || null;
    if (!nextPageToken || albumPage.length === 0) break;
    pageToken = nextPageToken;
  }

  return albums;
}

async function getAlbumMediaKeys(cdp, tokens, albumId) {
  const mediaKeys = [];
  let pageToken = null;

  while (true) {
    // lcxiM with albumId as the container (index 1 = container, null = whole library)
    const result = await cdp.evaluate(
      makeBatchExecuteExpr(tokens, RPC_ALBUM_ITEMS, [pageToken, albumId, 500, null, 1, 1]),
      true
    );

    if (result?.error) break; // non-fatal per album

    const items = result.payload?.[0] || [];
    if (!Array.isArray(items) || items.length === 0) break;

    for (const item of items) {
      const mediaKey = item?.[0];
      if (mediaKey) mediaKeys.push(mediaKey);
    }

    const nextPageToken = result.payload?.[1] || null;
    if (!nextPageToken || items.length === 0) break;
    pageToken = nextPageToken;
  }

  return mediaKeys;
}

async function run() {
  if (!existsSync(MANIFEST_FILE)) {
    throw new Error('manifest.json not found — run scan-quota-items.mjs first');
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
  const quotaItems = manifest.filter(item => item.mediaKey && item.consumesQuota);

  console.log('=== Save Album Memberships ===');
  console.log(`Quota items to check: ${quotaItems.length}`);

  const mediaKeySet = new Set(quotaItems.map(i => i.mediaKey));

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

  // Step 1: List all albums
  console.log('Listing albums...');
  const albums = await listAllAlbums(cdp, tokens);
  console.log(`Found ${albums.length} albums.\n`);

  if (albums.length === 0) {
    console.log('No albums found — nothing to save. This is fine if you have no albums.');
    cdp.ws.close();
    return;
  }

  // Step 2: Enumerate each album and cross-reference with manifest
  const mediaKeyToAlbums = new Map(); // mediaKey -> [{albumId, albumTitle}]

  for (let i = 0; i < albums.length; i++) {
    const { albumId, albumTitle } = albums[i];
    process.stdout.write(`  [${i + 1}/${albums.length}] "${albumTitle}"... `);

    const albumKeys = await getAlbumMediaKeys(cdp, tokens, albumId);
    let matchCount = 0;

    for (const mediaKey of albumKeys) {
      if (mediaKeySet.has(mediaKey)) {
        if (!mediaKeyToAlbums.has(mediaKey)) mediaKeyToAlbums.set(mediaKey, []);
        mediaKeyToAlbums.get(mediaKey).push({ albumId, albumTitle });
        matchCount++;
      }
    }

    console.log(`${albumKeys.length} items${matchCount ? `, ${matchCount} matched` : ''}`);
  }

  // Step 3: Update manifest
  let updated = 0;
  for (const item of manifest) {
    if (mediaKeyToAlbums.has(item.mediaKey)) {
      item.albums = mediaKeyToAlbums.get(item.mediaKey);
      updated++;
    }
  }

  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));

  console.log(`\n=== Summary ===`);
  console.log(`Items with album memberships saved: ${updated}`);
  const itemsInNoAlbum = quotaItems.length - updated;
  if (itemsInNoAlbum > 0) console.log(`Items in no album (library only): ${itemsInNoAlbum}`);
  console.log('\nManifest updated. Run batch-trash-reupload.mjs next.');

  cdp.ws.close();
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
