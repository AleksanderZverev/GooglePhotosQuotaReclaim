#!/usr/bin/env node
// Download a single photo via pLFTfd RPC (original quality download URL) through CDP.
// Usage: node download-test.mjs <mediaKey> <outputFilename>

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const CDP_URL = 'http://127.0.0.1:9222';
const MEDIA_KEY = process.argv[2] || 'AF1QipN-Va3a5CcHpiyh-gxhfwIZ5KkoNgDXpRDmsF7b';
const OUTPUT_NAME = process.argv[3] || 'PXL_20220528_001118338.jpg';
const OUTPUT_PATH = join(fileURLToPath(new URL('./downloads/', import.meta.url)), OUTPUT_NAME);

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
  console.log(`Downloading mediaKey: ${MEDIA_KEY}`);
  console.log(`Output: ${OUTPUT_PATH}`);

  const wsUrl = await getCdpWebSocketUrl();
  const cdp = await connectCdp(wsUrl);

  // Extract auth tokens
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

  if (tokens?.error) throw new Error(tokens.error);
  console.log('Auth tokens extracted.');

  // Call pLFTfd to get the download URL
  console.log('Calling pLFTfd RPC for download URL...');
  const downloadResult = await cdp.evaluate(`
    (async () => {
      const rpcid = 'pLFTfd';
      const mediaKey = '${MEDIA_KEY}';
      // pLFTfd request format: [[mediaKey], [1]] requests original quality download
      const requestData = [[mediaKey], [1]];
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
      if (!lines.length) return { error: 'No wrb.fr envelope', raw: text.slice(0, 500) };
      const parsed = JSON.parse(lines[0]);
      const payload = JSON.parse(parsed[0][2]);
      return { payload };
    })()
  `);

  if (downloadResult?.error) {
    console.error('pLFTfd error:', downloadResult.error);
    if (downloadResult.raw) console.error('Raw response:', downloadResult.raw);
    cdp.ws.close();
    process.exit(1);
  }

  console.log('pLFTfd response structure:', JSON.stringify(downloadResult.payload).slice(0, 300));

  // Extract download URL from payload - typically at payload[0] or payload[1]
  const payload = downloadResult.payload;
  let downloadUrl = null;

  // Try common positions for the download URL
  if (typeof payload === 'string' && payload.startsWith('http')) {
    downloadUrl = payload;
  } else if (Array.isArray(payload)) {
    // Walk the structure looking for a URL
    const findUrl = (obj, depth = 0) => {
      if (depth > 5) return null;
      if (typeof obj === 'string' && obj.startsWith('https://')) return obj;
      if (Array.isArray(obj)) {
        for (const item of obj) {
          const found = findUrl(item, depth + 1);
          if (found) return found;
        }
      }
      return null;
    };
    downloadUrl = findUrl(payload);
  }

  if (!downloadUrl) {
    console.error('Could not find download URL in payload.');
    console.error('Full payload:', JSON.stringify(payload, null, 2).slice(0, 1000));
    cdp.ws.close();
    process.exit(1);
  }

  console.log(`Download URL: ${downloadUrl.slice(0, 80)}...`);

  // Get cookies from the browser session for authenticated download
  const cookies = await cdp.send('Network.getCookies', { urls: ['https://photos.google.com', 'https://video-downloads.googleusercontent.com'] });
  const cookieHeader = cookies.cookies.map(c => `${c.name}=${c.value}`).join('; ');

  // Download via node fetch with cookies (avoids CORS restrictions of in-page fetch)
  console.log('Downloading file with session cookies...');
  const resp = await fetch(downloadUrl, {
    headers: { 'Cookie': cookieHeader },
    redirect: 'follow',
  });

  if (!resp.ok) {
    console.error(`Download failed: ${resp.status} ${resp.statusText}`);
    cdp.ws.close();
    process.exit(1);
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  console.log(`Downloaded ${buffer.length} bytes (${(buffer.length / 1024 / 1024).toFixed(2)} MB), content-type: ${resp.headers.get('content-type')}`);

  writeFileSync(OUTPUT_PATH, buffer);
  console.log(`Saved to: ${OUTPUT_PATH}`);

  cdp.ws.close();
  console.log('Done.');
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
