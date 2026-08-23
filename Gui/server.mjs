#!/usr/bin/env node
import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const CDP_URL = 'http://127.0.0.1:9222';

const CHROME_PROFILE_DIR = process.env.CHROME_PROFILE_DIR || path.join(os.tmpdir(), 'Chrome-GPhotos-CDP');
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const WORK_DIR = process.env.WORK_DIR || path.dirname(__dirname);
const MANIFEST_FILE = path.join(WORK_DIR, 'manifest.json');
const DOWNLOADS_DIR = path.join(WORK_DIR, 'downloads');

const emailCacheMap = new Map(); // path -> { email, at }

// ── SSE broadcast ─────────────────────────────────────────────────────────────

const sseClients = new Set();
let currentOp = null;

function broadcast(type, payload) {
  const msg = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch {}
  }
}

function log(msg, level = 'info') {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  broadcast('log', { text: `[${ts}] ${msg}`, level });
  console.log(`[${ts}] [${level.toUpperCase()}] ${msg}`);
}

function opStart(name) {
  currentOp = name;
  broadcast('opStart', { name });
}

function opEnd(name, ok, summary = '') {
  currentOp = null;
  broadcast('opEnd', { name, ok, summary });
  broadcast('stats', { stats: manifestStats(readManifest()) });
}

// ── Manifest ─────────────────────────────────────────────────────────────────

function readManifest() {
  if (!fs.existsSync(MANIFEST_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')); } catch { return []; }
}

function writeManifest(data) {
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(data, null, 2));
}

function manifestStats(manifest) {
  return {
    total: manifest.length,
    quota: manifest.filter(i => i.consumesQuota).length,
    downloaded: manifest.filter(i => i.downloaded).length,
    enriched: manifest.filter(i => i.dedupKey).length,
    albumsSaved: manifest.filter(i => i.albums !== undefined).length,
    trashed: manifest.filter(i => i.reuploadComplete).length,
    verified: manifest.filter(i => i.verified === true).length,
    restored: manifest.filter(i => i.albumsRestored).length,
  };
}

// ── CDP ──────────────────────────────────────────────────────────────────────

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
    if (result.exceptionDetails) throw new Error(`JS: ${result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)}`);
    return result.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

async function connectCdp() {
  const res = await fetch(`${CDP_URL}/json`);
  const tabs = await res.json();
  const tab = tabs.find(t => t.url?.includes('photos.google.com'));
  if (!tab) throw new Error('No Google Photos tab found. Open photos.google.com in Chrome with --remote-debugging-port=9222');
  const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return new CdpSession(ws);
}

async function getCdpTabs() {
  try {
    const res = await fetch(`${CDP_URL}/json`);
    return await res.json();
  } catch { return []; }
}

// ── RPC ──────────────────────────────────────────────────────────────────────

async function getTokens(cdp) {
  const t = await cdp.evaluate(`
    (() => {
      const g = window.WIZ_global_data;
      if (!g) return { error: 'WIZ_global_data not found' };
      return { at: g.SNlM0e, fsid: g.FdrFJe, bl: g.cfb2h, path: g.eptZe };
    })()`);
  if (t?.error) throw new Error(t.error);
  return t;
}

async function callRpc(cdp, rpcId, data, tokens) {
  if (!tokens) tokens = await getTokens(cdp);
  // Build URL inside evaluate so source-path = window.location.pathname (same as original CLI scripts).
  // Using hardcoded '/photos' produces a different EWgK9e response format.
  const text = await cdp.evaluate(`
    (async () => {
      const rpcId = ${JSON.stringify(rpcId)};
      const wrapped = [[[rpcId, ${JSON.stringify(JSON.stringify(data))}, null, 'generic']]];
      const body = 'f.req=' + encodeURIComponent(JSON.stringify(wrapped)) + '&at=' + encodeURIComponent(${JSON.stringify(tokens.at)}) + '&';
      const params = new URLSearchParams({
        rpcids: rpcId,
        'source-path': window.location.pathname,
        'f.sid': ${JSON.stringify(tokens.fsid)},
        bl: ${JSON.stringify(tokens.bl)},
        pageId: 'none',
        rt: 'c',
      });
      const url = ${JSON.stringify(`https://photos.google.com${tokens.path}data/batchexecute?`)} + params;
      const resp = await fetch(url, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body,
      });
      return resp.text();
    })()`);
  const lines = text.split('\n').filter(l => l.includes('wrb.fr'));
  if (!lines.length) throw new Error(`RPC ${rpcId}: empty response`);
  const parsed = JSON.parse(lines[0]);
  return JSON.parse(parsed[0][2]);
}

async function enumerateAll(cdp, tokens, { albumId = null, mode = 1, onPage } = {}) {
  const items = [];
  let pageToken = null;
  let page = 0;
  do {
    let pageItems, nextToken;
    if (albumId) {
      // Album items: snAcKc [albumMediaKey, pageId, null, authKey] → payload[1]=items, payload[2]=nextPage
      const payload = await callRpc(cdp, 'snAcKc', [albumId, pageToken, null, null], tokens);
      pageItems = payload?.[1] ?? [];
      nextToken = payload?.[2] ?? null;
    } else {
      // Library/archive: lcxiM [pageId, null, pageSize, null, mode, 1] → payload[0]=items, payload[1]=nextPage
      const payload = await callRpc(cdp, 'lcxiM', [pageToken, null, 500, null, mode, 1], tokens);
      pageItems = payload?.[0] ?? [];
      nextToken = payload?.[1] ?? null;
    }
    page++;
    items.push(...pageItems);
    if (onPage) await onPage(page, items.length, pageItems);
    pageToken = nextToken;
  } while (pageToken);
  return items;
}

async function batchQuotaInfo(cdp, tokens, mediaKeys) {
  const BATCH = 5000;
  const opts = [...Array(24).fill(null), [], ...Array(11).fill(null), []];
  const results = [];
  for (let i = 0; i < mediaKeys.length; i += BATCH) {
    const chunk = mediaKeys.slice(i, i + BATCH);
    const payload = await callRpc(cdp, 'EWgK9e', [[[chunk.map(k => [k])], [opts]]], tokens);
    const batch = payload?.[0]?.[1] ?? [];
    results.push(...batch);
  }
  return results;
}

async function listAllAlbums(cdp, tokens) {
  const albumsUrl = `https://photos.google.com/albums`;
  const result = await cdp.evaluate(`
    (async () => {
      const resp = await fetch(${JSON.stringify(albumsUrl)}, { credentials: 'include' });
      if (!resp.ok) return { error: 'HTTP ' + resp.status };
      const html = await resp.text();
      const marker = html.indexOf("key: 'ds:5'");
      if (marker < 0) return { error: 'ds:5 block not found — are you signed in and on google.com/photos?' };
      const dataPos = html.indexOf('data:', marker);
      const start = dataPos >= 0 ? html.indexOf('[', dataPos) : -1;
      if (start < 0) return { error: 'data array not found in ds:5 block' };
      let depth = 0, inStr = false, strChar = 0, esc = false, end = -1;
      for (let i = start; i < html.length; i++) {
        const cc = html.charCodeAt(i);
        if (esc) { esc = false; continue; }
        if (inStr) { if (cc === 92) esc = true; else if (cc === strChar) inStr = false; }
        else {
          if (cc === 34 || cc === 39) { inStr = true; strChar = cc; }
          else if (cc === 91 || cc === 123) depth++;
          else if ((cc === 93 || cc === 125) && --depth === 0) { end = i; break; }
        }
      }
      if (end < 0) return { error: 'bracket matching failed' };
      try { return { data: JSON.parse(html.slice(start, end + 1)) }; }
      catch (e) { return { error: 'JSON.parse: ' + e.message }; }
    })()`);

  if (result?.error) throw new Error(`Albums page: ${result.error}`);
  const albums = [];
  const entries = Array.isArray(result?.data?.[0]) ? result.data[0] : [];
  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    const albumId = entry[0];
    if (!albumId || typeof albumId !== 'string') continue;
    const infoObj = entry.find(e => e && typeof e === 'object' && !Array.isArray(e) && e['72930366']);
    if (!infoObj) continue;
    const info = infoObj['72930366'];
    const title = typeof info?.[1] === 'string' ? info[1] : `(untitled ${albumId.slice(-6)})`;
    const count = typeof info?.[3] === 'number' ? info[3] : null;
    albums.push({ albumId, title, count });
  }
  return albums;
}

async function tryGetAccountEmail(wsUrl) {
  return new Promise(resolve => {
    const done = v => { clearTimeout(t); resolve(v); };
    const t = setTimeout(() => resolve(null), 3500);
    let ws;
    (async () => {
      try {
        ws = new WebSocket(wsUrl, { perMessageDeflate: false });
        await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
        const tmp = new CdpSession(ws);
        const email = await tmp.evaluate(`
          (() => {
            const el = document.querySelector('[data-email]');
            if (el?.dataset?.email?.includes('@')) return el.dataset.email;
            for (const e of document.querySelectorAll('[aria-label]')) {
              const m = (e.getAttribute('aria-label') || '').match(/[\\w.+\\-]+@[\\w.\\-]+\\.\\w+/);
              if (m) return m[0];
            }
            return null;
          })()`);
        tmp.close();
        done(email);
      } catch { try { ws?.close(); } catch {} done(null); }
    })();
  });
}

// ── ADB ──────────────────────────────────────────────────────────────────────

function adb(cmd) {
  return execSync(`adb ${cmd}`, { encoding: 'utf8', timeout: 30000 }).trim();
}

function checkAdb() {
  try { return adb('devices').includes('\tdevice'); } catch { return false; }
}

function safeName(name) {
  return name.replace(/[ /\\?%*:|"<>]/g, '_');
}

// ── Operations ────────────────────────────────────────────────────────────────

async function opScan({ albumIds } = {}) {
  opStart('scan');
  const cdp = await connectCdp();
  try {
    const tokens = await getTokens(cdp);
    log(`Scanning... (account: ${tokens.path})`);

    const rawItems = [];
    if (albumIds?.length) {
      for (const albumId of albumIds) {
        log(`Enumerating album ${albumId}...`);
        const items = await enumerateAll(cdp, tokens, {
          albumId,
          onPage: (p, total) => log(`  Album page ${p}: ${total} items`),
        });
        rawItems.push(...items);
      }
    } else {
      const items = await enumerateAll(cdp, tokens, {
        onPage: (p, total) => log(`Page ${p}: ${total} items`),
      });
      rawItems.push(...items);
    }

    log(`Enumerated ${rawItems.length} items. Checking quota...`);
    const dedupMap = new Map(rawItems.filter(i => i?.[0] && i?.[3]).map(i => [i[0], i[3]]));
    const mediaKeys = rawItems.map(i => i?.[0]).filter(Boolean);
    const quotaInfos = await batchQuotaInfo(cdp, tokens, mediaKeys);

    const manifest = readManifest();
    const existingKeys = new Set(manifest.map(m => m.mediaKey));
    let added = 0;

    for (const qi of quotaInfos) {
      const mediaKey = qi?.[0];
      const d = qi?.[1];
      const inExisting = existingKeys.has(mediaKey);
      if (!mediaKey || inExisting) continue;
      if (d?.[23] !== 2) continue;
      manifest.push({
        mediaKey,
        dedupKey: dedupMap.get(mediaKey) || null,
        filename: d?.[3] ?? '',
        sizeBytes: d?.[9] ?? 0,
        consumesQuota: true,
        isOriginalQuality: d?.[18] === 2,
      });
      existingKeys.add(mediaKey);
      added++;
    }

    writeManifest(manifest);
    const summary = `Added ${added} new quota items. Total quota: ${manifest.filter(i => i.consumesQuota).length}`;
    log(summary, 'success');
    opEnd('scan', true, summary);
    return { ok: true, added };
  } catch (err) {
    log(`Scan failed: ${err.message}`, 'error');
    opEnd('scan', false, err.message);
    return { ok: false, error: err.message };
  } finally { cdp.close(); }
}

async function opEnrich() {
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

    let enriched = 0;
    for (const item of manifest) {
      if (found.has(item.mediaKey)) { item.dedupKey = found.get(item.mediaKey); enriched++; }
    }
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

async function opSaveAlbums() {
  opStart('save-albums');
  const cdp = await connectCdp();
  try {
    const tokens = await getTokens(cdp);
    log('Listing albums...');
    const albums = await listAllAlbums(cdp, tokens);
    log(`Found ${albums.length} albums.`);
    const manifest = readManifest();
    const targetKeys = new Set(manifest.filter(i => i.consumesQuota || i.downloaded).map(i => i.mediaKey));
    const keyToItem = new Map(manifest.map(i => [i.mediaKey, i]));
    for (let i = 0; i < albums.length; i++) {
      const { albumId, title } = albums[i];
      const albumItems = await enumerateAll(cdp, tokens, { albumId });
      let matched = 0;
      for (const rawItem of albumItems) {
        const key = rawItem?.[0];
        if (!key || !targetKeys.has(key)) continue;
        const item = keyToItem.get(key);
        if (!item) continue;
        if (!item.albums) item.albums = [];
        if (!item.albums.find(a => a.albumId === albumId)) {
          item.albums.push({ albumId, albumTitle: title });
          matched++;
        }
      }
      log(`[${i + 1}/${albums.length}] "${title}": ${albumItems.length} items, ${matched} matched`);
    }
    writeManifest(manifest);
    const withAlbums = manifest.filter(i => i.albums?.length > 0).length;
    const summary = `Done. ${withAlbums} items have album data.`;
    log(summary, 'success');
    opEnd('save-albums', true, summary);
    return { ok: true };
  } catch (err) {
    log(`Save albums failed: ${err.message}`, 'error');
    opEnd('save-albums', false, err.message);
    return { ok: false, error: err.message };
  } finally { cdp.close(); }
}

async function opScanFull({ albumIds } = {}) {
  if (!albumIds?.length) {
    const msg = 'No albums selected — select at least one album first';
    log(msg, 'error');
    return { ok: false, error: msg };
  }
  opStart('scan-full');
  const cdp = await connectCdp();
  try {
    const tokens = await getTokens(cdp);
    log(`Scanning... (account: ${tokens.path})`);

    // Fetch album titles up front
    const allAlbums = await listAllAlbums(cdp, tokens);
    const albumTitleMap = new Map(allAlbums.map(a => [a.albumId, a.title]));

    // Phase 1: Enumerate selected albums
    const rawItems = [];
    const albumToKeys = new Map();
    for (const albumId of albumIds) {
      const title = albumTitleMap.get(albumId) || albumId.slice(-8);
      log(`Enumerating "${title}"...`);
      const items = await enumerateAll(cdp, tokens, {
        albumId,
        onPage: (p, total) => log(`  Page ${p}: ${total} items`),
      });
      rawItems.push(...items);
      albumToKeys.set(albumId, new Set(items.map(i => i?.[0]).filter(Boolean)));
    }

    // Dedup
    const seen = new Set();
    const uniqueItems = rawItems.filter(i => {
      const k = i?.[0];
      if (!k || seen.has(k)) return false;
      seen.add(k); return true;
    });

    log(`${uniqueItems.length} unique items. Checking quota...`);
    const dedupMap = new Map(uniqueItems.filter(i => i?.[0] && i?.[3]).map(i => [i[0], i[3]]));
    const mediaKeys = uniqueItems.map(i => i?.[0]).filter(Boolean);
    const quotaInfos = await batchQuotaInfo(cdp, tokens, mediaKeys);

    const manifest = readManifest();
    const existingKeys = new Set(manifest.map(m => m.mediaKey));
    let added = 0;

    for (const qi of quotaInfos) {
      const mediaKey = qi?.[0];
      const d = qi?.[1];
      if (!mediaKey || existingKeys.has(mediaKey)) continue;
      if (d?.[23] !== 2) continue;
      const itemAlbums = [];
      for (const [albumId, keys] of albumToKeys) {
        if (keys.has(mediaKey)) itemAlbums.push({ albumId, albumTitle: albumTitleMap.get(albumId) || '' });
      }
      manifest.push({
        mediaKey,
        dedupKey: dedupMap.get(mediaKey) || null,
        filename: d?.[3] ?? '',
        sizeBytes: d?.[9] ?? 0,
        consumesQuota: true,
        isOriginalQuality: d?.[18] === 2,
        albums: itemAlbums,
      });
      existingKeys.add(mediaKey);
      added++;
    }
    writeManifest(manifest);
    log(`Scan: ${added} new quota items. Total: ${manifest.filter(i => i.consumesQuota).length}`, 'success');

    // Phase 2: Enrich
    const needsEnrich = manifest.filter(i => !i.dedupKey);
    if (needsEnrich.length > 0) {
      log(`Enriching ${needsEnrich.length} items...`);
      const targetKeys = new Set(needsEnrich.map(i => i.mediaKey));
      const found = new Map();
      let pageToken = null, page = 0;
      do {
        const payload = await callRpc(cdp, 'lcxiM', [pageToken, null, 500, null, 1, 1], tokens);
        const items = payload?.[0] ?? [];
        pageToken = payload?.[1] ?? null;
        page++;
        for (const item of items) {
          const key = item?.[0], dk = item?.[3];
          if (key && dk && targetKeys.has(key)) found.set(key, dk);
        }
        log(`  Page ${page}: ${found.size}/${targetKeys.size} found`);
        if (found.size === targetKeys.size) break;
      } while (pageToken);
      let enriched = 0;
      for (const item of manifest) {
        if (found.has(item.mediaKey)) { item.dedupKey = found.get(item.mediaKey); enriched++; }
      }
      writeManifest(manifest);
      const notFound = needsEnrich.length - enriched;
      log(`Enriched ${enriched}${notFound ? `, ${notFound} not found (may be archived)` : ''}.`, 'success');
    } else {
      log('All items already have dedupKeys.', 'success');
    }

    // Phase 3: Check other albums for additional memberships
    const targetSet = new Set(manifest.filter(i => i.consumesQuota).map(i => i.mediaKey));
    const otherAlbums = allAlbums.filter(a => !albumIds.includes(a.albumId));
    if (targetSet.size > 0 && otherAlbums.length > 0) {
      log(`Checking ${otherAlbums.length} other albums for additional memberships...`);
      const keyToItem = new Map(manifest.map(i => [i.mediaKey, i]));
      let extraFound = 0;
      for (const { albumId, title } of otherAlbums) {
        const albumItems = await enumerateAll(cdp, tokens, { albumId });
        for (const rawItem of albumItems) {
          const key = rawItem?.[0];
          if (!key || !targetSet.has(key)) continue;
          const item = keyToItem.get(key);
          if (!item) continue;
          if (!item.albums) item.albums = [];
          if (!item.albums.find(a => a.albumId === albumId)) {
            item.albums.push({ albumId, albumTitle: title });
            extraFound++;
          }
        }
      }
      if (extraFound > 0) { writeManifest(manifest); log(`Found ${extraFound} additional memberships.`, 'success'); }
    }

    const totalQuota = manifest.filter(i => i.consumesQuota).length;
    const summary = `Done. ${totalQuota} quota items ready for processing.`;
    log(summary, 'success');
    opEnd('scan-full', true, summary);
    return { ok: true, added };
  } catch (err) {
    log(`Scan failed: ${err.message}`, 'error');
    opEnd('scan-full', false, err.message);
    return { ok: false, error: err.message };
  } finally { cdp.close(); }
}

async function permanentDeleteFromTrash(cdp, tokens, dedupKey) {
  // XwAOJf with action=2 and source-path=/trash permanently deletes from trash
  const r = await cdp.evaluate(`
    (async () => {
      const d = [null, 2, [${JSON.stringify(dedupKey)}], 2];
      const w = [[['XwAOJf', JSON.stringify(d), null, 'generic']]];
      const body = 'f.req=' + encodeURIComponent(JSON.stringify(w)) + '&at=' + encodeURIComponent(${JSON.stringify(tokens.at)}) + '&';
      const p = new URLSearchParams({ rpcids: 'XwAOJf', 'source-path': '/trash', 'f.sid': ${JSON.stringify(tokens.fsid)}, bl: ${JSON.stringify(tokens.bl)}, pageId: 'none', rt: 'c' });
      const resp = await fetch(${JSON.stringify(`https://photos.google.com${tokens.path}data/batchexecute?`)} + p, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body,
      });
      const t = await resp.text();
      return { status: resp.status, hasError: t.includes('"er"') };
    })()`);
  if (r.status !== 200 || r.hasError) throw new Error(`XwAOJf/trash status=${r.status} hasError=${r.hasError}`);
}

async function opTrashReupload({ mediaKeys: filterKeys, saveAlbumsFirst = true, emptyTrash = false } = {}) {
  opStart('trash-reupload');
  if (!checkAdb()) {
    const msg = 'No ADB device connected';
    log(msg, 'error');
    opEnd('trash-reupload', false, msg);
    return { ok: false, error: msg };
  }
  const cdp = await connectCdp();
  try {
    const manifest = readManifest();
    const items = manifest.filter(i =>
      i.downloaded && i.downloadedAs && i.dedupKey && !i.reuploadComplete &&
      (filterKeys ? filterKeys.includes(i.mediaKey) : i.consumesQuota)
    );
    const missing = items.filter(i => !fs.existsSync(i.downloadedAs));
    if (missing.length > 0) {
      const msg = `${missing.length} files missing from disk.`;
      log(msg, 'error');
      opEnd('trash-reupload', false, msg);
      return { ok: false, error: msg };
    }
    if (!items.length) {
      const msg = 'No items ready for trash+reupload';
      log(msg, 'success');
      opEnd('trash-reupload', true, msg);
      return { ok: true, done: 0 };
    }
    log(`${items.length} items to process.`);

    // Save album memberships first if needed
    if (saveAlbumsFirst) {
      const needsAlbums = items.filter(i => !i.albums);
      if (needsAlbums.length > 0) {
        log(`Saving album memberships for ${needsAlbums.length} items...`);
        const tokens2 = await getTokens(cdp);
        const albums = await listAllAlbums(cdp, tokens2);
        log(`Found ${albums.length} albums.`);
        const targetKeys = new Set(needsAlbums.map(i => i.mediaKey));
        const keyToItem = new Map(manifest.map(i => [i.mediaKey, i]));
        for (let i = 0; i < albums.length; i++) {
          const { albumId, title } = albums[i];
          const albumItems = await enumerateAll(cdp, tokens2, { albumId });
          for (const rawItem of albumItems) {
            const key = rawItem?.[0];
            if (!key || !targetKeys.has(key)) continue;
            const item = keyToItem.get(key);
            if (!item) continue;
            if (!item.albums) item.albums = [];
            if (!item.albums.find(a => a.albumId === albumId))
              item.albums.push({ albumId, albumTitle: title });
          }
          if ((i + 1) % 10 === 0) log(`  Albums: ${i + 1}/${albums.length}`);
        }
        writeManifest(manifest);
        log('Album memberships saved.', 'success');
      }
    }

    const tokens = await getTokens(cdp);
    const BATCH = 10;
    let done = 0, errors = 0;

    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH);
      for (const item of batch) {
        const label = item.filename || item.mediaKey.slice(0, 16);
        try {
          log(`[${done + errors + 1}/${items.length}] Trashing ${label}...`);
          const tr = await cdp.evaluate(`
            (async () => {
              const d = [null, 1, [${JSON.stringify(item.dedupKey)}], 3];
              const w = [[['XwAOJf', JSON.stringify(d), null, 'generic']]];
              const body = 'f.req=' + encodeURIComponent(JSON.stringify(w)) + '&at=' + encodeURIComponent(${JSON.stringify(tokens.at)}) + '&';
              const p = new URLSearchParams({ rpcids: 'XwAOJf', 'source-path': '/photos', 'f.sid': ${JSON.stringify(tokens.fsid)}, bl: ${JSON.stringify(tokens.bl)}, pageId: 'none', rt: 'c' });
              const r = await fetch(${JSON.stringify(`https://photos.google.com${tokens.path}data/batchexecute?`)} + p, {
                method: 'POST', credentials: 'include',
                headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body,
              });
              const t = await r.text();
              return { status: r.status, hasError: t.includes('"er"') };
            })()`);

          if (tr.status !== 200 || tr.hasError) throw new Error(`Trash status=${tr.status}`);
          item.trashedAt = new Date().toISOString();

          if (emptyTrash) {
            try {
              await permanentDeleteFromTrash(cdp, tokens, item.dedupKey);
              log(`  Permanently deleted from trash: ${label}`);
            } catch (e) {
              log(`  Could not permanently delete from trash: ${e.message}`, 'warn');
            }
          }

          const rawName = path.basename(item.downloadedAs);
          const pushName = safeName(rawName);
          const remote = `/sdcard/DCIM/Camera/${pushName}`;
          adb(`push "${item.downloadedAs}" "${remote}"`);
          item.pushedAs = pushName;
          try {
            adb(`shell content insert --uri content://media/external/images/media --bind "_data:s:${remote}" --bind "mime_type:s:image/jpeg" --bind "_display_name:s:${pushName}"`);
          } catch {}

          item.reuploadComplete = true;
          item.reuploadedAt = new Date().toISOString();
          done++;
          log(`  OK ${label}`);
        } catch (err) {
          log(`  FAIL ${label}: ${err.message}`, 'error');
          item.trashError = err.message;
          errors++;
        }
        await new Promise(r => setTimeout(r, 300));
      }
      writeManifest(manifest);
      log(`Batch done. Progress: ${done + errors}/${items.length}`);
    }

    try {
      adb('shell am force-stop com.google.android.apps.photos');
      await new Promise(r => setTimeout(r, 1000));
      adb('shell am start -a android.intent.action.MAIN -n com.google.android.apps.photos/.home.HomeActivity');
      log('Photos app restarted.', 'success');
    } catch (err) { log(`Could not restart Photos: ${err.message}`, 'warn'); }

    const summary = `Done: ${done} processed, ${errors} errors.`;
    log(summary, errors > 0 ? 'warn' : 'success');
    opEnd('trash-reupload', errors === 0, summary);
    return { ok: true, done, errors };
  } catch (err) {
    log(`Trash+Reupload failed: ${err.message}`, 'error');
    opEnd('trash-reupload', false, err.message);
    return { ok: false, error: err.message };
  } finally { cdp.close(); }
}

async function opVerify() {
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
    const nameMap = new Map(items.map(i => [(i.pushedAs || i.filename).toLowerCase(), i]));
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
          const fname = (qi?.[1]?.[3] ?? '').toLowerCase();
          const item = nameMap.get(fname);
          if (!item || item.verified !== undefined) continue;
          const d = qi?.[1];
          if (d?.[23] !== 2 && d?.[18] === 2) {
            item.verified = true;
            item.newMediaKey = qi?.[0];
            item.verifiedAt = new Date().toISOString();
            verified.add(item.mediaKey);
          } else {
            item.verified = false;
            item.verifyNote = d?.[23] === 2 ? 'Still takes space' : 'Not original quality';
          }
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

async function opRestoreAlbums() {
  opStart('restore-albums');
  const cdp = await connectCdp();
  try {
    const manifest = readManifest();
    const items = manifest.filter(i => i.verified && i.newMediaKey && i.albums?.length && !i.albumsRestored);
    if (!items.length) {
      const msg = 'No items to restore into albums';
      log(msg, 'success');
      opEnd('restore-albums', true, msg);
      return { ok: true, restored: 0 };
    }
    log(`Restoring ${items.length} items into albums...`);
    const tokens = await getTokens(cdp);
    const albumGroups = new Map();
    for (const item of items) {
      for (const a of item.albums) {
        if (!albumGroups.has(a.albumId)) albumGroups.set(a.albumId, { title: a.albumTitle, items: [] });
        albumGroups.get(a.albumId).items.push(item);
      }
    }
    let totalRestored = 0;
    const BATCH = 50;
    for (const [albumId, { title, items: aItems }] of albumGroups) {
      log(`Album "${title}": ${aItems.length} items`);
      for (let i = 0; i < aItems.length; i += BATCH) {
        const batch = aItems.slice(i, i + BATCH);
        await callRpc(cdp, 'zy2MWb', [albumId, batch.map(it => [it.newMediaKey])], tokens);
        totalRestored += batch.length;
      }
      for (const item of aItems) { item.albumsRestored = true; item.albumsRestoredAt = new Date().toISOString(); }
    }
    writeManifest(manifest);
    const summary = `Restored ${totalRestored} items into albums.`;
    log(summary, 'success');
    opEnd('restore-albums', true, summary);
    return { ok: true, restored: totalRestored };
  } catch (err) {
    log(`Restore albums failed: ${err.message}`, 'error');
    opEnd('restore-albums', false, err.message);
    return { ok: false, error: err.message };
  } finally { cdp.close(); }
}

async function opCleanupPixel() {
  opStart('cleanup-pixel');
  try {
    if (!checkAdb()) throw new Error('No ADB device connected');
    log('Removing files from /sdcard/DCIM/Camera/...');
    adb('shell rm /sdcard/DCIM/Camera/*');
    const summary = 'Pixel camera roll cleaned.';
    log(summary, 'success');
    opEnd('cleanup-pixel', true, summary);
    return { ok: true };
  } catch (err) {
    log(`Cleanup failed: ${err.message}`, 'error');
    opEnd('cleanup-pixel', false, err.message);
    return { ok: false, error: err.message };
  }
}

async function opMatchAlbums({ albumIds }) {
  opStart('match');
  const cdp = await connectCdp();
  try {
    if (!fs.existsSync(DOWNLOADS_DIR)) throw new Error(`downloads/ not found at ${DOWNLOADS_DIR}`);
    const downloadFiles = fs.readdirSync(DOWNLOADS_DIR);
    const downloadMap = new Map(downloadFiles.map(f => [f.toLowerCase(), f]));
    log(`${downloadFiles.length} files in downloads/`);
    const tokens = await getTokens(cdp);
    const manifest = readManifest();
    const existingKeys = new Set(manifest.map(m => m.mediaKey));
    let added = 0, matched = 0;
    for (const albumId of albumIds) {
      log(`Enumerating album ${albumId}...`);
      const rawItems = await enumerateAll(cdp, tokens, { albumId });
      log(`  ${rawItems.length} items in album`);
      const keys = rawItems.map(i => i?.[0]).filter(Boolean);
      const qis = await batchQuotaInfo(cdp, tokens, keys);
      const quotaMap = new Map(qis.map(qi => [qi?.[0], qi]));
      const dedupMap = new Map(rawItems.filter(i => i?.[0] && i?.[3]).map(i => [i[0], i[3]]));
      for (const rawItem of rawItems) {
        const mediaKey = rawItem?.[0];
        if (!mediaKey) continue;
        const qi = quotaMap.get(mediaKey);
        const filename = qi?.[1]?.[3] ?? '';
        if (!filename) continue;
        const matchedFile = downloadMap.get(filename.toLowerCase());
        if (!matchedFile) continue;
        matched++;
        const d = qi?.[1];
        const downloadedAs = path.join(DOWNLOADS_DIR, matchedFile);
        if (existingKeys.has(mediaKey)) {
          const existing = manifest.find(m => m.mediaKey === mediaKey);
          if (existing && !existing.downloadedAs) { existing.downloadedAs = downloadedAs; existing.downloaded = true; }
          continue;
        }
        manifest.push({
          mediaKey,
          dedupKey: dedupMap.get(mediaKey) || null,
          filename,
          sizeBytes: d?.[9] ?? 0,
          consumesQuota: d?.[23] === 2,
          isOriginalQuality: d?.[18] === 2,
          downloaded: true,
          downloadedAs,
        });
        existingKeys.add(mediaKey);
        added++;
      }
      log(`  Matched ${matched} files so far`);
    }
    writeManifest(manifest);
    const summary = `Matched ${matched} files. Added ${added} new items.`;
    log(summary, 'success');
    opEnd('match', true, summary);
    return { ok: true, matched, added };
  } catch (err) {
    log(`Match failed: ${err.message}`, 'error');
    opEnd('match', false, err.message);
    return { ok: false, error: err.message };
  } finally { cdp.close(); }
}

async function opSwitchAccount(accountPath) {
  opStart('switch-account');
  const cdp = await connectCdp();
  try {
    await cdp.send('Page.navigate', { url: `https://photos.google.com${accountPath}` });
    await new Promise(r => setTimeout(r, 3000));
    const tokens = await getTokens(cdp);
    const summary = `Switched to ${tokens.path}`;
    log(summary, 'success');
    opEnd('switch-account', true, summary);
    return { ok: true, path: tokens.path };
  } catch (err) {
    log(`Switch account failed: ${err.message}`, 'error');
    opEnd('switch-account', false, err.message);
    return { ok: false, error: err.message };
  } finally { cdp.close(); }
}

// ── Chrome management ────────────────────────────────────────────────────────

function findChrome() {
  const envPath = process.env.CHROME_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const found = CHROME_PATHS.find(p => fs.existsSync(p));
  if (!found) throw new Error('Chrome not found. Set CHROME_PATH env var.');
  return found;
}

function launchChrome() {
  const chromePath = findChrome();
  spawn(chromePath, [
    '--remote-debugging-port=9222',
    `--user-data-dir=${CHROME_PROFILE_DIR}`,
    'https://photos.google.com',
  ], { detached: true, stdio: 'ignore' }).unref();
  log(`Chrome launched with profile: ${CHROME_PROFILE_DIR}`, 'info');
  return { ok: true, profileDir: CHROME_PROFILE_DIR };
}

function deleteProfile() {
  if (!fs.existsSync(CHROME_PROFILE_DIR)) {
    return { ok: true, note: 'Profile directory does not exist' };
  }
  fs.rmSync(CHROME_PROFILE_DIR, { recursive: true, force: true });
  log(`Deleted Chrome profile: ${CHROME_PROFILE_DIR}`, 'warn');
  return { ok: true, deleted: CHROME_PROFILE_DIR };
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

async function parseBody(req) {
  const raw = await new Promise(resolve => {
    let data = ''; req.on('data', c => data += c); req.on('end', () => resolve(data));
  });
  try { return JSON.parse(raw); } catch { return {}; }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }

  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify({ type: 'stats', stats: manifestStats(readManifest()) })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (p === '/api/status' && req.method === 'GET') {
    try {
      const tabs = await getCdpTabs();
      const photosTabs = tabs.filter(t => t.url?.includes('photos.google.com'));
      let account = null;
      if (photosTabs.length > 0) {
        const m = photosTabs[0].url.match(/photos\.google\.com(\/u\/\d+\/)/);
        account = m?.[1] ?? '/';
      }
      let accountEmail = null;
      if (photosTabs.length > 0) {
        const now = Date.now();
        const cached = emailCacheMap.get(account);
        if (cached && now - cached.at < 30000) {
          accountEmail = cached.email;
        } else if (!cached || now - cached.at > 5000) {
          const email = await tryGetAccountEmail(photosTabs[0].webSocketDebuggerUrl);
          emailCacheMap.set(account, { email, at: now });
          accountEmail = email;
        } else {
          accountEmail = cached?.email || null;
        }
      }
      const knownEmails = {};
      for (const [p, d] of emailCacheMap.entries()) { if (d.email) knownEmails[p] = d.email; }
      return json(res, {
        cdpConnected: photosTabs.length > 0,
        account,
        accountEmail,
        knownEmails,
        photosTabs: photosTabs.map(t => ({ url: t.url, title: t.title })),
        manifest: manifestStats(readManifest()),
        currentOp,
        adbConnected: checkAdb(),
        workDir: WORK_DIR,
        downloadsDir: DOWNLOADS_DIR,
        downloadCount: fs.existsSync(DOWNLOADS_DIR) ? fs.readdirSync(DOWNLOADS_DIR).length : 0,
      });
    } catch (err) {
      return json(res, { cdpConnected: false, error: err.message, manifest: manifestStats([]) });
    }
  }

  if (p === '/api/albums' && req.method === 'GET') {
    try {
      const cdp = await connectCdp();
      const tokens = await getTokens(cdp);
      const albums = await listAllAlbums(cdp, tokens);
      cdp.close();
      return json(res, { albums });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  if (p === '/api/manifest' && req.method === 'GET') {
    const m = readManifest();
    return json(res, { manifest: m, stats: manifestStats(m) });
  }

  if (p === '/api/launch-chrome' && req.method === 'POST') {
    try { return json(res, launchChrome()); }
    catch (err) { return json(res, { error: err.message }, 500); }
  }

  if (p === '/api/delete-profile' && req.method === 'POST') {
    try { return json(res, deleteProfile()); }
    catch (err) { return json(res, { error: err.message }, 500); }
  }

  if (p === '/api/chrome-info' && req.method === 'GET') {
    const exists = fs.existsSync(CHROME_PROFILE_DIR);
    let sizeMb = null;
    if (exists) {
      try {
        const out = execSync(
          `powershell -NoProfile -Command "(Get-ChildItem -Path '${CHROME_PROFILE_DIR.replace(/'/g, "''")}' -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum"`,
          { encoding: 'utf8', timeout: 8000 }
        );
        const bytes = parseInt(out.trim());
        if (!isNaN(bytes)) sizeMb = Math.round(bytes / 1024 / 1024);
      } catch {}
    }
    return json(res, { profileDir: CHROME_PROFILE_DIR, exists, sizeMb });
  }

  if (req.method !== 'POST') { res.writeHead(404); return res.end('Not found'); }

  const body = await parseBody(req);

  if (currentOp) {
    return json(res, { error: `Operation '${currentOp}' is running`, busy: true }, 409);
  }

  const ops = {
    '/api/scan-full':       () => body.albumIds?.length ? opScanFull(body) : Promise.resolve({ error: 'albumIds required' }),
    '/api/scan':            () => opScan(body),
    '/api/enrich':          () => opEnrich(),
    '/api/save-albums':     () => opSaveAlbums(),
    '/api/trash-reupload':  () => opTrashReupload(body),
    '/api/verify':          () => opVerify(),
    '/api/restore-albums':  () => opRestoreAlbums(),
    '/api/cleanup-pixel':   () => opCleanupPixel(),
    '/api/match':           () => body.albumIds?.length ? opMatchAlbums(body) : Promise.resolve({ error: 'albumIds required' }),
    '/api/switch-account':  () => body.path ? opSwitchAccount(body.path) : Promise.resolve({ error: 'path required' }),
    '/api/reset-manifest':  () => {
      if (fs.existsSync(MANIFEST_FILE)) fs.unlinkSync(MANIFEST_FILE);
      broadcast('stats', manifestStats([]));
      log('Manifest deleted.', 'warn');
      return Promise.resolve({ ok: true });
    },
  };

  if (ops[p]) {
    ops[p]().catch(err => {
      console.error(err);
      if (currentOp) { currentOp = null; broadcast('opEnd', { name: p.slice(5), ok: false, summary: err.message }); }
    });
    return json(res, { ok: true, queued: p.slice(5) });
  }

  res.writeHead(404); res.end('Not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) json(res, { error: err.message }, 500);
  });
});

server.listen(PORT, () => {
  console.log(`\nGoogle Photos Recovery GUI`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Work dir: ${WORK_DIR}`);
  console.log(`  Downloads: ${DOWNLOADS_DIR}\n`);
});
