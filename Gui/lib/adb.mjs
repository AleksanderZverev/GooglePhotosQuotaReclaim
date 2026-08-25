import fs from 'fs';
import { execSync, exec } from 'child_process';
import { ADB_PATH, ADB_EXE, ADB_DOWNLOAD_URL } from './config.mjs';

export function adb(cmd) {
  if (!fs.existsSync(ADB_PATH)) {
    throw new Error(`ADB binary not found at ${ADB_PATH}. Download Platform Tools from ${ADB_DOWNLOAD_URL} and place ${ADB_EXE} in the adb/ folder.`);
  }
  return execSync(`"${ADB_PATH}" ${cmd}`, { encoding: 'utf8', timeout: 30000 }).trim();
}

export function adbAsync(cmd) {
  if (!fs.existsSync(ADB_PATH)) {
    return Promise.reject(new Error(`ADB binary not found at ${ADB_PATH}. Download Platform Tools from ${ADB_DOWNLOAD_URL} and place ${ADB_EXE} in the adb/ folder.`));
  }
  return new Promise((resolve, reject) => {
    exec(`"${ADB_PATH}" ${cmd}`, { encoding: 'utf8', timeout: 60000 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout.trim());
    });
  });
}

export function checkAdb() {
  try { return adb('devices').includes('\tdevice'); } catch { return false; }
}

export function safeName(name) {
  return name.replace(/[ /\\?%*:|"<>]/g, '_');
}
