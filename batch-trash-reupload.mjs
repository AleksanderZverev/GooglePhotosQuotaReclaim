#!/usr/bin/env node
// Phase 2: Trash items from Google Photos and re-upload via Pixel 1.
// SAFETY: refuses to run unless ALL items are downloaded first.
// Re-runnable — skips already-processed items.

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const CDP_URL = 'http://127.0.0.1:9222';
const MANIFEST_FILE = fileURLToPath(new URL('./manifest.json', import.meta.url));
const BATCH_SIZE = 10;
const TRASH_DELAY_MS = 300;
const PUSH_DELAY_MS = 200;
const MAX_RECONNECTS = 5;

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

function adb(cmd) {
  return execSync(`adb ${cmd}`, { encoding: 'utf8', timeout: 30000 }).trim();
}

function checkAdb() {
  try {
    const devices = adb('devices');
    if (!devices.includes('\tdevice')) {
      throw new Error('No adb device connected');
    }
  } catch (e) {
    throw new Error(`adb check failed: ${e.message}`);
  }
}

async function createSession() {
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
  return { cdp, tokens };
}

async function trashItem(cdp, tokens, dedupKey) {
  return cdp.evaluate(`
    (async () => {
      const rpcid = 'XwAOJf';
      const requestData = [null, 1, ["${dedupKey}"], 3];
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
      return { status: resp.status, hasError: text.includes('"er"') };
    })()
  `);
}

async function run() {
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));

  // Safety check: ALL quota-consuming items must be downloaded
  const quotaItems = manifest.filter(item => item.mediaKey && item.consumesQuota);
  const notDownloaded = quotaItems.filter(item => !item.downloaded || !item.downloadedAs);

  if (notDownloaded.length > 0) {
    console.error('=== SAFETY CHECK FAILED ===');
    console.error(`${notDownloaded.length} items not yet downloaded locally.`);
    console.error('Run batch-download.mjs first until all items are saved.');
    console.error('First undownloaded:', notDownloaded[0]?.filename || notDownloaded[0]?.mediaKey);
    process.exit(1);
  }

  // Verify local files still exist
  const missingFiles = quotaItems.filter(item => item.downloadedAs && !existsSync(item.downloadedAs));
  if (missingFiles.length > 0) {
    console.error('=== SAFETY CHECK FAILED ===');
    console.error(`${missingFiles.length} downloaded files missing from disk!`);
    console.error('First missing:', missingFiles[0].downloadedAs);
    process.exit(1);
  }

  // Items ready for processing: downloaded, have dedupKey, not yet processed
  const ready = quotaItems.filter(item => item.dedupKey && !item.reuploadComplete);
  const noDedupKey = quotaItems.filter(item => !item.dedupKey);
  const done = quotaItems.filter(item => item.reuploadComplete);

  console.log(`=== Batch Trash & Re-upload ===`);
  console.log(`Total quota items: ${quotaItems.length}`);
  console.log(`Already processed: ${done.length}`);
  console.log(`Ready to process: ${ready.length}`);
  console.log(`Missing dedupKey (run enrich-dedupkeys.mjs): ${noDedupKey.length}`);

  if (ready.length === 0) {
    if (noDedupKey.length > 0) {
      console.log('\nRun enrich-dedupkeys.mjs to get dedupKeys before continuing.');
    } else {
      console.log('\nAll items processed!');
    }
    return;
  }

  // Check adb
  console.log('\nChecking adb connection...');
  checkAdb();
  console.log('Pixel connected.');

  // Connect CDP
  console.log('Connecting to CDP...');
  let session = await createSession();
  let { cdp, tokens } = session;
  let reconnects = 0;
  console.log('Auth ready.\n');

  let processed = 0;
  let errors = 0;
  const startTime = Date.now();

  for (let i = 0; i < ready.length; i += BATCH_SIZE) {
    const batch = ready.slice(i, i + BATCH_SIZE);
    console.log(`--- Batch ${Math.floor(i / BATCH_SIZE) + 1} (items ${i + 1}-${i + batch.length}) ---`);

    // Step 1: Trash all items in this batch
    for (const item of batch) {
      const label = item.filename || item.mediaKey.slice(0, 20);
      process.stdout.write(`  Trash ${label}... `);

      let result;
      try {
        result = await trashItem(cdp, tokens, item.dedupKey);
      } catch (e) {
        // CDP connection lost — reconnect
        if (reconnects >= MAX_RECONNECTS) {
          console.log(`FATAL: too many reconnects`);
          saveManifest(manifest);
          process.exit(1);
        }
        console.log(`RECONNECT (${e.message.slice(0, 50)})`);
        reconnects++;
        await new Promise(r => setTimeout(r, 3000));
        try {
          session = await createSession();
          cdp = session.cdp;
          tokens = session.tokens;
          result = await trashItem(cdp, tokens, item.dedupKey);
        } catch (e2) {
          console.log(`FAIL after reconnect: ${e2.message.slice(0, 50)}`);
          item.trashError = e2.message;
          errors++;
          continue;
        }
      }

      if (result.status === 200 && !result.hasError) {
        item.trashedAt = new Date().toISOString();
        console.log('OK');
      } else {
        console.log(`FAIL (status=${result.status})`);
        item.trashError = `status=${result.status}`;
        errors++;
      }
      await new Promise(r => setTimeout(r, TRASH_DELAY_MS));
    }

    // Step 2: Push files to Pixel (only successfully trashed ones)
    const trashed = batch.filter(item => item.trashedAt && !item.trashError);
    const pushed = [];
    for (const item of trashed) {
      const localFile = item.downloadedAs;
      // Use the already-unique downloaded filename (includes dedup suffix for collisions);
      // also sanitize spaces so adb shell args don't break.
      const rawName = localFile.replace(/.*[/\\]/, '');
      const safeName = rawName.replace(/[ /\\?%*:|"<>]/g, '_');
      process.stdout.write(`  Push ${safeName}... `);

      try {
        adb(`push "${localFile}" "/sdcard/DCIM/Camera/${safeName}"`);
        item.pushedAs = safeName;
        pushed.push(item);
        console.log('OK');
      } catch (e) {
        console.log(`FAIL: ${e.message}`);
        item.pushError = e.message;
        errors++;
      }
      await new Promise(r => setTimeout(r, PUSH_DELAY_MS));
    }

    // Step 3: Trigger MediaStore insert for successfully pushed files
    console.log('  Triggering MediaStore scan...');
    for (const item of pushed) {
      const safeName = item.pushedAs;
      try {
        adb(`shell content insert --uri content://media/external/images/media --bind "_data:s:/sdcard/DCIM/Camera/${safeName}" --bind "mime_type:s:image/jpeg" --bind "_display_name:s:${safeName}"`);
      } catch (e) {
        // Non-fatal — file may already be indexed
      }
    }

    // Mark items as complete only if both trash AND push succeeded.
    // An item that was trashed but not pushed is permanently lost otherwise.
    for (const item of pushed) {
      item.reuploadComplete = true;
      item.reuploadedAt = new Date().toISOString();
      processed++;
    }

    // Save progress
    saveManifest(manifest);
    console.log(`  Batch done. Progress: ${done.length + processed}/${quotaItems.length}\n`);
  }

  // One restart at the end to kick off backup for all pushed files
  console.log('Restarting Photos to trigger backup of all pushed files...');
  try {
    adb('shell am force-stop com.google.android.apps.photos');
    await new Promise(r => setTimeout(r, 1000));
    adb('shell am start -a android.intent.action.MAIN -n com.google.android.apps.photos/.home.HomeActivity');
  } catch (e) {
    console.log(`Warning: ${e.message}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\n=== Summary ===`);
  console.log(`Processed: ${processed}`);
  console.log(`Errors: ${errors}`);
  console.log(`Total complete: ${done.length + processed}/${quotaItems.length}`);
  console.log(`Time: ${elapsed}s`);
  console.log(`\nFiles are on the Pixel — Google Photos will back them up asynchronously.`);
  console.log(`Run verify-reupload.mjs after backup completes to confirm quota recovery.`);
  console.log(`Then run: adb shell rm /sdcard/DCIM/Camera/* to remove files from the device.`);

  try { cdp.ws.close(); } catch (e) {}
}

function saveManifest(manifest) {
  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
