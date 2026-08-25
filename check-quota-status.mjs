#!/usr/bin/env node
// Check quota status of a single mediaKey via EWgK9e RPC.
// Usage: node check-quota-status.mjs <mediaKey>

const CDP_URL = 'http://127.0.0.1:9222';
const MEDIA_KEY = process.argv[2] || 'AF1QipN-Va3a5CcHpiyh-gxhfwIZ5KkoNgDXpRDmsF7b';

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
  console.log(`Checking quota status for mediaKey: ${MEDIA_KEY}`);

  const wsUrl = await getCdpWebSocketUrl();
  const cdp = await connectCdp(wsUrl);

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

  const result = await cdp.evaluate(`
    (async () => {
      const key = '${MEDIA_KEY}';
      const prefix = (window.location.pathname.match(/^\/u\/\d+/) || [''])[0];
      const wrapped = [[["fDcn4b", JSON.stringify([key]), null, "1"]]];
      const body = 'f.req=' + encodeURIComponent(JSON.stringify(wrapped)) + '&at=' + encodeURIComponent('${tokens.at}') + '&';
      const params = new URLSearchParams({
        rpcids: 'fDcn4b', 'source-path': prefix + '/photo/' + key,
        'f.sid': '${tokens.fsid}', bl: '${tokens.bl}', pageId: 'none', rt: 'c',
      });
      const url = 'https://photos.google.com${tokens.path}data/batchexecute?' + params;
      const resp = await fetch(url, { method: 'POST', credentials: 'include', headers: {'content-type': 'application/x-www-form-urlencoded;charset=UTF-8'}, body });
      const text = await resp.text();
      const line = text.split('\\n').find(l => l.includes('wrb.fr'));
      if (!line) return { error: 'No wrb.fr envelope', raw: text.slice(0, 500) };
      const item = JSON.parse(JSON.parse(line)[0][2])?.[0];
      if (!item) return { error: 'No item data returned' };
      return {
        mediaKey: item[0],
        fileName: item[2],
        size: item[5],
        timestamp: item[3],
        takesUpSpace: item[30]?.[0] === 1,
        spaceTaken: item[5],
        isOriginalQuality: item[14] === 2,
        rawLastArr: item[30],
      };
    })()
  `);

  if (result?.error) {
    console.error('Error:', result.error);
    if (result.raw) console.error('Raw:', result.raw);
    cdp.ws.close();
    process.exit(1);
  }

  console.log('\n=== Quota Status ===');
  console.log(`  File: ${result.fileName}`);
  console.log(`  Media Key: ${result.mediaKey}`);
  console.log(`  Takes Up Space: ${result.takesUpSpace}`);
  console.log(`  Space Taken: ${result.spaceTaken ? (result.spaceTaken / 1024 / 1024).toFixed(2) + ' MB' : 'none'}`);
  console.log(`  Is Original Quality: ${result.isOriginalQuality}`);
  console.log(`  Timestamp: ${result.timestamp}`);
  console.log(`  Raw quota array: ${JSON.stringify(result.rawLastArr)}`);

  cdp.ws.close();
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
