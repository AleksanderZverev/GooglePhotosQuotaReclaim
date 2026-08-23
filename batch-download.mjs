#!/usr/bin/env node
// Phase 1: Download all quota-consuming items locally.
// Run this until manifest shows all items downloaded.
// Safe to re-run — skips already-downloaded items.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { stat } from 'fs/promises';
import { fileURLToPath } from 'url';
import { join } from 'path';

const CDP_URL = 'http://127.0.0.1:9222';
const MANIFEST_FILE = fileURLToPath(new URL('./manifest.json', import.meta.url));
const DOWNLOADS_DIR = fileURLToPath(new URL('./downloads/', import.meta.url));
const DELAY_MS = 500; // delay between downloads to avoid rate limits

if (!existsSync(DOWNLOADS_DIR)) mkdirSync(DOWNLOADS_DIR, { recursive: true });

async function getCdpWebSocketUrl() {
  const resp = await fetch(`${CDP_URL}/json`);
  const tabs = await resp.json();
  const photosTab = tabs.find(t => t.url?.includes('photos.google.com'));
  if (!photosTab) throw new Error('No photos.google.com tab found — open photos.google.com in Chrome with CDP on port 9222');
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

function saveManifest(manifest) {
  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
}

async function getDownloadUrl(cdp, tokens, mediaKey) {
  return cdp.evaluate(`
    (async () => {
      const rpcid = 'pLFTfd';
      const requestData = [["${mediaKey}"], [1]];
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
      // Find the download URL in the response
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
      const downloadUrl = findUrl(payload);
      if (!downloadUrl) return { error: 'No URL in payload' };
      return { url: downloadUrl };
    })()
  `);
}

async function run() {
  if (!existsSync(MANIFEST_FILE)) {
    throw new Error('manifest.json not found — run scan-quota-items.mjs first');
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
  const pending = manifest.filter(item => item.mediaKey && item.consumesQuota && !item.downloaded);
  const alreadyDone = manifest.filter(item => item.downloaded).length;

  console.log(`Manifest: ${manifest.length} total items`);
  console.log(`Already downloaded: ${alreadyDone}`);
  console.log(`Remaining: ${pending.length}`);

  if (pending.length === 0) {
    console.log('\nAll items already downloaded!');
    return;
  }

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

  // Get cookies for download
  const cookies = await cdp.send('Network.getCookies', {
    urls: ['https://photos.google.com', 'https://video-downloads.googleusercontent.com']
  });
  const cookieHeader = cookies.cookies.map(c => `${c.name}=${c.value}`).join('; ');

  console.log('Auth ready. Starting downloads...\n');

  // Detect filename collisions and use mediaKey suffix for dupes
  const nameCounts = new Map();
  for (const item of manifest) {
    const name = item.filename || `${item.mediaKey}.bin`;
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  }

  function getUniqueName(item) {
    const filename = item.filename || `${item.mediaKey}.bin`;
    const safeName = filename.replace(/[/\\?%*:|"<>]/g, '_');
    if ((nameCounts.get(filename) || 0) > 1) {
      // Append short mediaKey hash to disambiguate
      const ext = safeName.includes('.') ? safeName.slice(safeName.lastIndexOf('.')) : '';
      const base = safeName.includes('.') ? safeName.slice(0, safeName.lastIndexOf('.')) : safeName;
      const suffix = item.mediaKey.slice(-8);
      return `${base}_${suffix}${ext}`;
    }
    return safeName;
  }

  let downloaded = 0;
  let errors = 0;
  const startTime = Date.now();

  for (const item of pending) {
    const idx = manifest.indexOf(item);
    const safeName = getUniqueName(item);

    process.stdout.write(`[${alreadyDone + downloaded + 1}/${manifest.length}] ${safeName}... `);

    try {
      // Get download URL
      const dlResult = await getDownloadUrl(cdp, tokens, item.mediaKey);
      if (dlResult.error) {
        console.log(`SKIP (${dlResult.error})`);
        errors++;
        continue;
      }

      // Download with cookies
      const resp = await fetch(dlResult.url, {
        headers: { 'Cookie': cookieHeader },
        redirect: 'follow',
      });

      if (!resp.ok) {
        console.log(`FAIL (HTTP ${resp.status})`);
        errors++;
        continue;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      const outPath = join(DOWNLOADS_DIR, safeName);
      writeFileSync(outPath, buffer);

      // Verify size if we have expected size
      const expectedBytes = item.sizeBytes;
      if (expectedBytes && Math.abs(buffer.length - expectedBytes) > 1024) {
        console.log(`WARN size mismatch: got ${buffer.length}, expected ${expectedBytes}`);
      }

      // Update manifest
      item.downloaded = true;
      item.downloadedAs = outPath;
      item.downloadedBytes = buffer.length;
      item.downloadedAt = new Date().toISOString();
      downloaded++;

      console.log(`OK (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);

      // Save manifest every 10 downloads
      if (downloaded % 10 === 0) {
        saveManifest(manifest);
      }

      // Rate limit
      await new Promise(r => setTimeout(r, DELAY_MS));

    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      errors++;

      // If we get auth errors, tokens may have expired
      if (err.message.includes('WIZ_global_data') || err.message.includes('401')) {
        console.error('\nAuth may have expired. Save progress and retry.');
        break;
      }
    }
  }

  // Final save
  saveManifest(manifest);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\n=== Download Summary ===`);
  console.log(`Downloaded: ${downloaded}`);
  console.log(`Errors: ${errors}`);
  console.log(`Total downloaded: ${alreadyDone + downloaded}/${manifest.length}`);
  console.log(`Time: ${elapsed}s`);
  console.log(`Manifest saved.`);

  cdp.ws.close();
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
