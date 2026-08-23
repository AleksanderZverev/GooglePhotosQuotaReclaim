#!/usr/bin/env node
// Enrich manifest with dedupKeys from lcxiM library enumeration.
// The trash RPC (XwAOJf) requires dedupKeys, not mediaKeys.
// Run this before the trash phase.

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
  const needDedupKey = manifest.filter(item => item.mediaKey && !item.dedupKey);

  console.log(`Manifest: ${manifest.length} total items`);
  console.log(`Need dedupKey: ${needDedupKey.length}`);
  console.log(`Already have dedupKey: ${manifest.length - needDedupKey.length}`);

  if (needDedupKey.length === 0) {
    console.log('\nAll items already have dedupKeys!');
    return;
  }

  const targetKeys = new Set(needDedupKey.map(item => item.mediaKey));
  const keyToDedup = new Map();

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

  console.log('Enumerating library to collect dedupKeys...');
  let pageToken = null;
  let totalScanned = 0;
  let matched = 0;

  while (matched < targetKeys.size) {
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
        const items = payload?.[0]?.map(item => ({
          mediaKey: item?.[0],
          dedupKey: item?.[3],
        })) || [];
        return { items, nextPageId: payload?.[1] || null };
      })()
    `);

    if (pageResult?.error) {
      console.error('Error:', pageResult.error);
      break;
    }

    totalScanned += pageResult.items.length;

    for (const item of pageResult.items) {
      if (targetKeys.has(item.mediaKey) && !keyToDedup.has(item.mediaKey)) {
        keyToDedup.set(item.mediaKey, item.dedupKey);
        matched++;
      }
    }

    if (totalScanned % 5000 === 0 || matched > 0) {
      console.log(`  Scanned ${totalScanned} items, matched ${matched}/${targetKeys.size} dedupKeys`);
    }

    if (!pageResult.nextPageId || pageResult.items.length === 0) break;
    pageToken = pageResult.nextPageId;
  }

  // Update manifest
  let updated = 0;
  for (const item of manifest) {
    if (item.mediaKey && keyToDedup.has(item.mediaKey)) {
      item.dedupKey = keyToDedup.get(item.mediaKey);
      updated++;
    }
  }

  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
  console.log(`\nUpdated ${updated} items with dedupKeys.`);
  const unmatched = targetKeys.size - matched;
  console.log(`Unmatched: ${unmatched}`);
  if (unmatched > 0) {
    console.log(`  These items are not visible in library mode 1 (likely archived).`);
    console.log(`  To find them: change the requestData mode parameter from 1 to 2`);
    console.log(`  in the lcxiM call above, then run this script again.`);
  }

  cdp.ws.close();
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
