#!/usr/bin/env node
// Scan Google Photos library for quota-consuming items via CDP + batchexecute RPCs.
// Equivalent to GPTK's "Source: Library, Filter: Space-Consuming" but runs headlessly.
// Requires Chrome running with --remote-debugging-port=9222, authenticated to Google Photos.

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';

const CDP_URL = 'http://127.0.0.1:9222';
const OUTPUT_FILE = fileURLToPath(new URL('./quota-items-scan.json', import.meta.url));
const MANIFEST_FILE = fileURLToPath(new URL('./manifest.json', import.meta.url));
const PAGE_SIZE = 500;
const INFO_BATCH_SIZE = 5000;

async function getCdpWebSocketUrl() {
  const resp = await fetch(`${CDP_URL}/json`);
  const tabs = await resp.json();
  const photosTab = tabs.find(t => t.url?.includes('photos.google.com'));
  if (!photosTab) {
    const anyTab = tabs[0];
    if (!anyTab) throw new Error('No Chrome tabs found on CDP port 9222');
    console.log(`No photos.google.com tab found. Available tabs:`);
    tabs.forEach(t => console.log(`  - ${t.url}`));
    console.log(`\nNavigating first tab to photos.google.com...`);
    return { wsUrl: anyTab.webSocketDebuggerUrl, needsNavigate: true };
  }
  return { wsUrl: photosTab.webSocketDebuggerUrl, needsNavigate: false };
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
  console.log('Connecting to Chrome CDP...');
  const { wsUrl, needsNavigate } = await getCdpWebSocketUrl();
  const cdp = await connectCdp(wsUrl);

  if (needsNavigate) {
    await cdp.send('Page.navigate', { url: 'https://photos.google.com/' });
    console.log('Navigating to photos.google.com, waiting 5s for load...');
    await new Promise(r => setTimeout(r, 5000));
  }

  // Extract auth tokens from page context
  console.log('Extracting auth tokens from WIZ_global_data...');
  const tokens = await cdp.evaluate(`
    (() => {
      const g = window.WIZ_global_data;
      if (!g) return { error: 'WIZ_global_data not found' };
      return {
        at: g.SNlM0e,
        fsid: g.FdrFJe,
        bl: g.cfb2h,
        path: g.eptZe,
      };
    })()
  `);

  if (tokens?.error) {
    throw new Error(tokens.error + ' — is the page fully loaded and authenticated?');
  }
  console.log(`Auth tokens extracted. bl=${tokens.bl?.slice(0, 20)}...`);

  // Phase 1: Enumerate full library via lcxiM
  console.log('\n=== Phase 1: Library enumeration (lcxiM, 500 items/page) ===');
  const allMediaKeys = [];
  let pageToken = null;
  let pageNum = 0;

  while (true) {
    pageNum++;
    const pageResult = await cdp.evaluate(`
      (async () => {
        const rpcid = 'lcxiM';
        const requestData = [${pageToken ? `"${pageToken}"` : 'null'}, null, ${PAGE_SIZE}, null, 1, 1];
        const wrappedData = [[[rpcid, JSON.stringify(requestData), null, 'generic']]];
        const body = 'f.req=' + encodeURIComponent(JSON.stringify(wrappedData)) + '&at=' + encodeURIComponent('${tokens.at}') + '&';
        const params = new URLSearchParams({
          rpcids: rpcid,
          'source-path': window.location.pathname,
          'f.sid': '${tokens.fsid}',
          bl: '${tokens.bl}',
          pageId: 'none',
          rt: 'c',
        });
        const url = 'https://photos.google.com${tokens.path}data/batchexecute?' + params.toString();
        const resp = await fetch(url, {
          headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body,
          method: 'POST',
          credentials: 'include',
        });
        const text = await resp.text();
        const lines = text.split('\\n').filter(l => l.includes('wrb.fr'));
        if (!lines.length) return { error: 'No wrb.fr envelope', status: resp.status };
        const parsed = JSON.parse(lines[0]);
        const payload = JSON.parse(parsed[0][2]);
        const items = payload?.[0]?.map(item => ({
          mediaKey: item?.[0],
          dedupKey: item?.[3],
          timestamp: item?.[2],
        })) || [];
        return { items, nextPageId: payload?.[1] || null };
      })()
    `);

    if (pageResult?.error) {
      console.error(`Page ${pageNum} error: ${pageResult.error} (status: ${pageResult.status})`);
      break;
    }

    const { items, nextPageId } = pageResult;
    allMediaKeys.push(...items);
    console.log(`  Page ${pageNum}: ${items.length} items (total: ${allMediaKeys.length})`);

    if (!nextPageId || items.length === 0) break;
    pageToken = nextPageId;
  }

  console.log(`\nLibrary enumeration complete: ${allMediaKeys.length} total items`);

  // Phase 2: Batch check quota via EWgK9e
  console.log(`\n=== Phase 2: Batch quota check (EWgK9e, ${INFO_BATCH_SIZE} keys/call) ===`);
  const quotaItems = [];
  let processed = 0;

  for (let i = 0; i < allMediaKeys.length; i += INFO_BATCH_SIZE) {
    const batch = allMediaKeys.slice(i, i + INFO_BATCH_SIZE);
    const batchKeys = batch.map(item => item.mediaKey);
    const batchNum = Math.floor(i / INFO_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(allMediaKeys.length / INFO_BATCH_SIZE);

    const batchResult = await cdp.evaluate(`
      (async () => {
        const rpcid = 'EWgK9e';
        const mediaKeys = ${JSON.stringify(batchKeys)};
        const mappedKeys = mediaKeys.map(id => [id]);
        const requestData = [[[mappedKeys], [[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,[],null,null,null,null,null,null,null,null,null,null,[]]]]];
        const wrappedData = [[[rpcid, JSON.stringify(requestData), null, 'generic']]];
        const body = 'f.req=' + encodeURIComponent(JSON.stringify(wrappedData)) + '&at=' + encodeURIComponent('${tokens.at}') + '&';
        const params = new URLSearchParams({
          rpcids: rpcid,
          'source-path': window.location.pathname,
          'f.sid': '${tokens.fsid}',
          bl: '${tokens.bl}',
          pageId: 'none',
          rt: 'c',
        });
        const url = 'https://photos.google.com${tokens.path}data/batchexecute?' + params.toString();
        const resp = await fetch(url, {
          headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body,
          method: 'POST',
          credentials: 'include',
        });
        const text = await resp.text();
        const lines = text.split('\\n').filter(l => l.includes('wrb.fr'));
        if (!lines.length) return { error: 'No wrb.fr envelope', status: resp.status };
        const parsed = JSON.parse(lines[0]);
        const payload = JSON.parse(parsed[0][2]);
        const itemsData = payload?.[0]?.[1] || [];
        const results = itemsData.map(item => {
          const d = item?.[1];
          return {
            mediaKey: item?.[0],
            fileName: d?.[3],
            size: d?.[9],
            timestamp: d?.[6],
            takesUpSpace: d?.[23] === 2,
            spaceTaken: d?.[9],
            isOriginalQuality: d?.[18] === 2,
          };
        });
        return { results };
      })()
    `);

    if (batchResult?.error) {
      console.error(`Batch ${batchNum}/${totalBatches} error: ${batchResult.error}`);
      continue;
    }

    const spaceConsuming = batchResult.results.filter(item => item.takesUpSpace);
    quotaItems.push(...spaceConsuming);
    processed += batch.length;
    console.log(`  Batch ${batchNum}/${totalBatches}: checked ${batch.length} items, ${spaceConsuming.length} consuming quota (running total: ${quotaItems.length})`);
  }

  console.log(`\n=== Results ===`);
  console.log(`Total items scanned: ${allMediaKeys.length}`);
  console.log(`Quota-consuming items found: ${quotaItems.length}`);

  const totalSpaceBytes = quotaItems.reduce((sum, item) => sum + (item.spaceTaken || 0), 0);
  console.log(`Total space consumed: ${(totalSpaceBytes / 1024 / 1024).toFixed(1)} MB`);

  // Save raw scan results
  writeFileSync(OUTPUT_FILE, JSON.stringify(quotaItems, null, 2));
  console.log(`\nScan results saved to: ${OUTPUT_FILE}`);

  // Merge into existing manifest, or create a new one from scratch
  const existing = existsSync(MANIFEST_FILE)
    ? (() => { const p = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')); return Array.isArray(p) ? p : []; })()
    : [];
  const existingKeys = new Set(existing.map(e => e.mediaKey));
  let newCount = 0;
  for (const item of quotaItems) {
    if (!existingKeys.has(item.mediaKey)) {
      existing.push({
        mediaKey: item.mediaKey,
        filename: item.fileName,
        size: item.spaceTaken ? `${(item.spaceTaken / 1024 / 1024).toFixed(1)} MB` : item.size,
        sizeBytes: item.spaceTaken,
        timestamp: item.timestamp,
        consumesQuota: true,
        isOriginalQuality: item.isOriginalQuality,
        downloaded: false,
        downloadedAs: null,
      });
      newCount++;
    }
  }
  writeFileSync(MANIFEST_FILE, JSON.stringify(existing, null, 2));
  console.log(`Manifest saved: ${newCount} new items added (${existing.length} total)`);

  console.log('\nDone.');
  cdp.ws.close();
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
