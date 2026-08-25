import fs from 'fs';
import { spawn } from 'child_process';
import { CHROME_PATHS, CHROME_PROFILE_DIR } from './config.mjs';
import { log } from './sse.mjs';

export function findChrome() {
  const envPath = process.env.CHROME_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const found = CHROME_PATHS.find(p => fs.existsSync(p));
  if (!found) throw new Error('Chrome not found. Set CHROME_PATH env var.');
  return found;
}

export function launchChrome() {
  const chromePath = findChrome();
  spawn(chromePath, [
    '--remote-debugging-port=9222',
    `--user-data-dir=${CHROME_PROFILE_DIR}`,
    'https://photos.google.com',
  ], { detached: true, stdio: 'ignore' }).unref();
  log(`Chrome launched with profile: ${CHROME_PROFILE_DIR}`, 'info');
  return { ok: true, profileDir: CHROME_PROFILE_DIR };
}

export function deleteProfile() {
  if (!fs.existsSync(CHROME_PROFILE_DIR)) {
    return { ok: true, note: 'Profile directory does not exist' };
  }
  fs.rmSync(CHROME_PROFILE_DIR, { recursive: true, force: true });
  log(`Deleted Chrome profile: ${CHROME_PROFILE_DIR}`, 'warn');
  return { ok: true, deleted: CHROME_PROFILE_DIR };
}
