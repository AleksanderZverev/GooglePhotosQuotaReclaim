#!/usr/bin/env node
import http from 'http';
import { handle, json } from './api/router.mjs';
import { PORT, WORK_DIR, DOWNLOADS_DIR } from './lib/config.mjs';
import { openAppWindow } from './lib/chrome.mjs';

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) json(res, { error: err.message }, 500);
  });
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\nGoogle Photos Recovery GUI`);
  console.log(`  ${url}`);
  console.log(`  Work dir: ${WORK_DIR}`);
  console.log(`  Downloads: ${DOWNLOADS_DIR}\n`);
  openAppWindow(url);
});
