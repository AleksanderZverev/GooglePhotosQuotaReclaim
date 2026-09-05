import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { getCdpTabs, connectCdp, tryGetAccountEmail } from '../lib/cdp.mjs';
import { getTokens, listAllAlbums, clearAlbumsCache } from '../lib/rpc.mjs';
import { readManifest, manifestStats, writeManifest } from '../lib/manifest.mjs';
import { broadcast, log, currentOp, sseClients, requestStop } from '../lib/sse.mjs';
import { launchChrome, deleteProfile } from '../lib/chrome.mjs';
import { checkAdb } from '../lib/adb.mjs';
import { CHROME_PROFILE_DIR, DOWNLOADS_DIR, MANIFEST_FILE, PORT, ADB_PATH, WORK_DIR } from '../lib/config.mjs';
import { scanStep, scanFullStep } from '../steps/scanStep.mjs';
import { enrichStep } from '../steps/enrichStep.mjs';
import { restoreAlbumsStep } from '../steps/albumsStep.mjs';
import { trashReuploadStep, repushStep } from '../steps/trashReuploadStep.mjs';
import { verifyStep } from '../steps/verifyStep.mjs';
import { cleanupPixelStep, matchManifestStep, matchAlbumsStep, switchAccountStep, pushFolderStep } from '../steps/miscSteps.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const emailCacheMap = new Map();

export function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

async function parseBody(req) {
  const raw = await new Promise(resolve => {
    let data = ''; req.on('data', c => data += c); req.on('end', () => resolve(data));
  });
  try { return JSON.parse(raw); } catch { return {}; }
}

function handleCors(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end();
}

function serveIndexHtml(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(path.join(__dirname, '..', 'index.html')).pipe(res);
}

function handleSseConnection(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('retry: 3000\n\n');
  res.write(`data: ${JSON.stringify({ type: 'stats', stats: manifestStats(readManifest()) })}\n\n`);
  clearAlbumsCache(); // page refresh → fresh album data on next fetch
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

async function resolveAccountEmail(photosTabs, account) {
  if (photosTabs.length === 0) return null;
  const now = Date.now();
  const cached = emailCacheMap.get(account);
  if (cached && now - cached.at < 30000) return cached.email;
  if (cached && now - cached.at <= 5000) return cached?.email || null;
  const email = await tryGetAccountEmail(photosTabs[0].webSocketDebuggerUrl);
  emailCacheMap.set(account, { email, at: now });
  return email;
}

async function handleStatusRequest(res) {
  try {
    const tabs = await getCdpTabs();
    const photosTabs = tabs.filter(t => t.url?.includes('photos.google.com'));
    const accountMatch = photosTabs[0]?.url.match(/photos\.google\.com(\/u\/\d+\/)/);
    const account = accountMatch?.[1] ?? (photosTabs.length > 0 ? '/' : null);
    const accountEmail = await resolveAccountEmail(photosTabs, account);
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
      adbBinaryFound: fs.existsSync(ADB_PATH),
      adbConnected: checkAdb(),
      workDir: WORK_DIR,
      downloadsDir: DOWNLOADS_DIR,
      downloadCount: fs.existsSync(DOWNLOADS_DIR) ? fs.readdirSync(DOWNLOADS_DIR).length : 0,
    });
  } catch (err) {
    return json(res, { cdpConnected: false, error: err.message, manifest: manifestStats([]) });
  }
}

async function handleAlbumsRequest(res) {
  try {
    const cdp = await connectCdp();
    const tokens = await getTokens(cdp);
    const albums = await listAllAlbums(cdp, tokens);
    cdp.close();

    // Compute quota item counts per album from manifest
    const manifest = readManifest();
    const albumQuotaCounts = new Map();
    for (const item of manifest) {
      if (!item.consumesQuota) continue;
      for (const a of item.albums || []) {
        albumQuotaCounts.set(a.albumId, (albumQuotaCounts.get(a.albumId) || 0) + 1);
      }
    }
    const albumsWithQuota = albums.map(a => ({
      ...a,
      quotaCount: albumQuotaCounts.get(a.albumId) || 0,
    }));

    return json(res, { albums: albumsWithQuota });
  } catch (err) {
    return json(res, { error: err.message }, 500);
  }
}

function handleChromeInfoRequest(res) {
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

function buildOperationsMap(body) {
  return {
    '/api/scan-full':      () => scanFullStep(body),
    '/api/scan':           () => scanStep(body),
    '/api/enrich':         () => enrichStep(),
    '/api/trash-reupload': () => trashReuploadStep(body),
    '/api/repush':         () => repushStep(body),
    '/api/verify':         () => verifyStep(),
    '/api/restore-albums': () => restoreAlbumsStep(),
    '/api/cleanup-pixel':  () => cleanupPixelStep(),
    '/api/match':          () => body.albumIds?.length ? matchAlbumsStep(body) : matchManifestStep(),
    '/api/switch-account': () => body.path ? switchAccountStep(body.path) : Promise.resolve({ error: 'path required' }),
    '/api/push-folder':    () => body.folderPath ? pushFolderStep(body) : Promise.resolve({ error: 'folderPath required' }),
    '/api/reset-manifest': () => {
      if (fs.existsSync(MANIFEST_FILE)) fs.unlinkSync(MANIFEST_FILE);
      broadcast('stats', manifestStats([]));
      log('Manifest deleted.', 'warn');
      return Promise.resolve({ ok: true });
    },
  };
}

export async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') return handleCors(res);
  if (pathname === '/' || pathname === '/index.html') return serveIndexHtml(res);
  if (pathname === '/api/events') return handleSseConnection(req, res);
  if (pathname === '/api/status' && req.method === 'GET') return handleStatusRequest(res);
  if (pathname === '/api/albums' && req.method === 'GET') return handleAlbumsRequest(res);
  if (pathname === '/api/manifest' && req.method === 'GET') {
    const m = readManifest();
    return json(res, { manifest: m, stats: manifestStats(m) });
  }
  if (pathname === '/api/launch-chrome' && req.method === 'POST') {
    try { return json(res, launchChrome()); }
    catch (err) { return json(res, { error: err.message }, 500); }
  }
  if (pathname === '/api/delete-profile' && req.method === 'POST') {
    try { return json(res, deleteProfile()); }
    catch (err) { return json(res, { error: err.message }, 500); }
  }
  if (pathname === '/api/chrome-info' && req.method === 'GET') return handleChromeInfoRequest(res);
  if (pathname === '/api/stop' && req.method === 'POST') {
    requestStop();
    log('Stop requested by user.', 'warn');
    return json(res, { ok: true });
  }

  if (req.method !== 'POST') { res.writeHead(404); return res.end('Not found'); }

  const body = await parseBody(req);

  if (currentOp) {
    return json(res, { error: `Operation '${currentOp}' is running`, busy: true }, 409);
  }

  const ops = buildOperationsMap(body);

  if (ops[pathname]) {
    ops[pathname]().catch(err => {
      console.error(err);
      if (currentOp) { broadcast('opEnd', { name: pathname.slice(5), ok: false, summary: err.message }); }
    });
    return json(res, { ok: true, queued: pathname.slice(5) });
  }

  res.writeHead(404);
  res.end('Not found');
}
