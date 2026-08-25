import fs from 'fs';
import { MANIFEST_FILE } from './config.mjs';

export function readManifest() {
  if (!fs.existsSync(MANIFEST_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')); } catch { return []; }
}

export function writeManifest(data) {
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(data, null, 2));
}

export function manifestStats(manifest) {
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
