import { WebSocket } from 'ws';
import { CDP_URL } from './config.mjs';

export class CdpSession {
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

export async function connectCdp() {
  const res = await fetch(`${CDP_URL}/json`);
  const tabs = await res.json();
  const tab = tabs.find(t => t.url?.includes('photos.google.com'));
  if (!tab) throw new Error('No Google Photos tab found. Open photos.google.com in Chrome with --remote-debugging-port=9222');
  const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return new CdpSession(ws);
}

export async function getCdpTabs() {
  try {
    const res = await fetch(`${CDP_URL}/json`);
    return await res.json();
  } catch { return []; }
}

export async function tryGetAccountEmail(wsUrl) {
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
