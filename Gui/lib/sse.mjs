import { manifestStats } from './manifest.mjs';
import { readManifest } from './manifest.mjs';

export const sseClients = new Set();
export let currentOp = null;

export function broadcast(type, payload) {
  const msg = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch {}
  }
}

export function log(msg, level = 'info') {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  broadcast('log', { text: `[${ts}] ${msg}`, level });
  console.log(`[${ts}] [${level.toUpperCase()}] ${msg}`);
}

export function opStart(name) {
  currentOp = name;
  broadcast('opStart', { name });
}

export function opEnd(name, ok, summary = '') {
  currentOp = null;
  broadcast('opEnd', { name, ok, summary });
  broadcast('stats', { stats: manifestStats(readManifest()) });
}
