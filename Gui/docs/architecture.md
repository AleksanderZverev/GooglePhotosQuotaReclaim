# Architecture

## Design decisions

### Why a local HTTP server, not Electron?

The project already depends only on `ws`. A plain Node.js HTTP server reuses that same dependency and serves an HTML page that runs in the user's existing Chrome instance — the same one connected to Google Photos via CDP. No installer, no native binaries, no packaging step.

### Why Server-Sent Events for progress?

Operations like scan and trash+reupload run for minutes and log dozens of lines. SSE gives real-time streaming with zero extra dependencies (unlike WebSockets) and is natively supported by the browser `EventSource` API. The server just writes `data: ...\n\n` chunks.

### Why does the server make RPC calls via CDP `evaluate`, not directly?

Google Photos session cookies never leave the browser. All RPC calls are HTTP `fetch` calls injected into the authenticated page via `Runtime.evaluate` with `credentials: 'include'`. Node.js only handles orchestration and ADB; it never holds auth tokens long enough to make raw HTTPS requests to Google (except during download, which uses explicitly extracted cookies).

---

## Request lifecycle

```
Browser (index.html)
  │  POST /api/scan
  ▼
server.mjs HTTP handler
  │  fires opScan() async, returns { ok: true, queued: 'scan' } immediately
  ▼
opScan()
  │  connectCdp() → WebSocket to Chrome tab
  │  getTokens() → cdp.evaluate(WIZ_global_data) → { at, fsid, bl, path }
  │  enumerateAll() → loop: callRpc(lcxiM) per page
  │    callRpc() → builds URL+body in Node.js → cdp.evaluate(fetch(...)) in browser
  │  batchQuotaInfo() → callRpc(EWgK9e) in chunks
  │  writeManifest()
  │  log() → broadcast SSE to all connected clients
  ▼
Browser SSE stream receives 'log', 'stats', 'opEnd' events → UI updates
```

---

## State machine: manifest.json fields

Each item moves through these fields as operations run:

```
After scan:        { mediaKey, dedupKey?, filename, sizeBytes, consumesQuota }
After enrich:      + dedupKey (if missing)
After match:       + downloaded=true, downloadedAs (album workflow only)
After save-albums: + albums: [{albumId, albumTitle}]
After trash:       + trashedAt, pushedAs, reuploadComplete=true
After verify:      + verified=true/false, newMediaKey, verifyNote?
After restore:     + albumsRestored=true
```

Items from `opMatchAlbums` (album workflow) are created with `downloaded=true` from the start, skipping the download step.

---

## Concurrency model

Only one operation runs at a time. `currentOp` is a module-level string. All `POST /api/*` routes check it and return `409` if busy. The SSE `opStart` / `opEnd` events keep the frontend in sync.

The CDP session is created fresh per operation and closed in a `finally` block. This avoids state leakage between operations and handles Chrome tab reloads gracefully.

---

## File layout

```
Gui/
├── server.mjs          Entry point and HTTP server
├── index.html          Single-page UI (no build step)
├── package.json        { type: module, scripts: { start: node server.mjs } }
└── docs/
    ├── architecture.md  ← this file
    ├── api-reference.md HTTP endpoints
    ├── operations.md    Operation functions (opScan, opTrashReupload, …)
    ├── cdp-rpc.md       CDP session, RPC helpers, token extraction
    └── frontend.md      HTML/JS structure, SSE, state management
```

The `manifest.json`, `downloads/`, and all CLI scripts remain in the project root (parent of `Gui/`). `WORK_DIR` defaults to `path.dirname(__dirname)` and can be overridden with the `WORK_DIR` env var.
