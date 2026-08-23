#!/usr/bin/env node
// Phase 3: Verify that re-uploaded items are now quota-free.
// Scans the library for items matching our manifest filenames and checks quota status.

import { writeFileSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const CDP_URL = 'http://127.0.0.1:9222';
const MANIFEST_FILE = fileURLToPath(new URL('./manifest.json', import.meta.url));

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
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`JS error: ${result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)}`);
    }
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

async function run() {
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
  const toVerify = manifest.filter(item => item.reuploadComplete && !item.verified);

  console.log(`Items to verify: ${toVerify.length}`);
  console.log(`Already verified: ${manifest.filter(i => i.verified).length}`);

  if (toVerify.length === 0) {
    const unverified = manifest.filter(i => i.reuploadComplete && i.verified === false);
    if (unverified.length > 0) {
      console.log(`\nWARNING: ${unverified.length} items failed verification (still consuming quota).`);
      for (const item of unverified.slice(0, 10)) {
        console.log(`  - ${item.filename}`);
      }
    }
    return;
  }

  // Build set of filenames to look for. Use pushedAs (the unique name on the Pixel)
  // when available — it includes a dedup suffix for items with colliding filenames.
  const targetFilenames = new Set(toVerify.map(item => item.pushedAs || item.filename));

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

  // Enumerate library and check quota for matching filenames
  console.log('Scanning library for re-uploaded items...');
  let pageToken = null;
  let totalScanned = 0;
  let verified = 0;
  let failed = 0;
  const foundItems = new Map(); // filename -> quota status

  while (foundItems.size < targetFilenames.size) {
    const pageResult = await cdp.evaluate(`
      (async () => {
        const rpcid = 'lcxiM';
        const requestData = [${pageToken ? `"${pageToken}"` : 'null'}, null, 500, null, 1, 1];
        const wrappedData = [[[rpcid, JSON.stringify(requestData), null, 'generic']]];
        const body = 'f.req=' + encodeURIComponent(JSON.stringify(wrappedData)) + '&at=' + encodeURIComponent('${tokens.at}') + '&';
        const params = new URLSearchParams({
          rpcids: rpcid, 'source-path': '/', 'f.sid': '${tokens.fsid}', bl: '${tokens.bl}', pageId: 'none', rt: 'c',
        });
        const url = 'https://photos.google.com${tokens.path}data/batchexecute?' + params.toString();
        const resp = await fetch(url, {
          headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body, method: 'POST', credentials: 'include',
        });
        const text = await resp.text();
        const lines = text.split('\\n').filter(l => l.includes('wrb.fr'));
        if (!lines.length) return { error: 'No wrb.fr envelope' };
        const parsed = JSON.parse(lines[0]);
        const payload = JSON.parse(parsed[0][2]);
        const items = payload?.[0]?.map(item => ({ mediaKey: item?.[0] })) || [];
        return { items: items.map(i => i.mediaKey), nextPageId: payload?.[1] || null };
      })()
    `);

    if (pageResult?.error) { console.error(pageResult.error); break; }
    totalScanned += pageResult.items.length;

    // Batch check quota
    const quotaResult = await cdp.evaluate(`
      (async () => {
        const rpcid = 'EWgK9e';
        const mediaKeys = ${JSON.stringify(pageResult.items)};
        const mappedKeys = mediaKeys.map(id => [id]);
        const requestData = [[[mappedKeys], [[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,[],null,null,null,null,null,null,null,null,null,null,[]]]]];
        const wrappedData = [[[rpcid, JSON.stringify(requestData), null, 'generic']]];
        const body = 'f.req=' + encodeURIComponent(JSON.stringify(wrappedData)) + '&at=' + encodeURIComponent('${tokens.at}') + '&';
        const params = new URLSearchParams({
          rpcids: rpcid, 'source-path': '/', 'f.sid': '${tokens.fsid}', bl: '${tokens.bl}', pageId: 'none', rt: 'c',
        });
        const url = 'https://photos.google.com${tokens.path}data/batchexecute?' + params.toString();
        const resp = await fetch(url, {
          headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body, method: 'POST', credentials: 'include',
        });
        const text = await resp.text();
        const lines = text.split('\\n').filter(l => l.includes('wrb.fr'));
        if (!lines.length) return [];
        const parsed = JSON.parse(lines[0]);
        const payload = JSON.parse(parsed[0][2]);
        return (payload?.[0]?.[1] || []).map(item => {
          const d = item?.[1];
          return {
            mediaKey: item?.[0],
            fileName: d?.[3],
            takesUpSpace: d?.[23] === 2,
            isOriginalQuality: d?.[18] === 2,
          };
        });
      })()
    `);

    if (Array.isArray(quotaResult)) {
      for (const item of quotaResult) {
        if (item.fileName && targetFilenames.has(item.fileName) && !foundItems.has(item.fileName)) {
          foundItems.set(item.fileName, item);
        }
      }
    }

    if (!pageResult.nextPageId || pageResult.items.length === 0) break;
    pageToken = pageResult.nextPageId;

    if (totalScanned % 10000 === 0) {
      console.log(`  ${totalScanned} scanned, ${foundItems.size}/${targetFilenames.size} found`);
    }
  }

  // Update manifest with verification results
  for (const item of toVerify) {
    const found = foundItems.get(item.pushedAs || item.filename);
    if (found) {
      if (!found.takesUpSpace && found.isOriginalQuality) {
        item.verified = true;
        item.newMediaKey = found.mediaKey;
        item.verifiedAt = new Date().toISOString();
        verified++;
      } else {
        item.verified = false;
        item.verifyNote = `quota=${found.takesUpSpace}, original=${found.isOriginalQuality}`;
        failed++;
      }
    } else {
      item.verified = false;
      item.verifyNote = 'not found in library (may not have uploaded yet)';
      failed++;
    }
  }

  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));

  console.log(`\n=== Verification Results ===`);
  console.log(`Verified quota-free: ${verified}`);
  console.log(`Failed/not found: ${failed}`);
  console.log(`Total scanned: ${totalScanned} library items`);

  if (failed > 0) {
    console.log('\nFailed items (first 10):');
    const failedItems = toVerify.filter(i => i.verified === false);
    for (const item of failedItems.slice(0, 10)) {
      console.log(`  ${item.filename}: ${item.verifyNote}`);
    }
  }

  cdp.ws.close();
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
