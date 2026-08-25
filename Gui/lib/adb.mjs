import fs from 'fs';
import { execSync } from 'child_process';
import { ADB_PATH, ADB_EXE, ADB_DOWNLOAD_URL } from './config.mjs';

export function adb(cmd) {
  if (!fs.existsSync(ADB_PATH)) {
    throw new Error(`ADB binary not found at ${ADB_PATH}. Download Platform Tools from ${ADB_DOWNLOAD_URL} and place ${ADB_EXE} in the adb/ folder.`);
  }
  return execSync(`"${ADB_PATH}" ${cmd}`, { encoding: 'utf8', timeout: 30000 }).trim();
}

export function checkAdb() {
  try { return adb('devices').includes('\tdevice'); } catch { return false; }
}

export function safeName(name) {
  return name.replace(/[ /\\?%*:|"<>]/g, '_');
}
