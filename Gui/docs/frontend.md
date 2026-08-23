# Frontend

`index.html` is a self-contained single-page app. No build step, no npm dependencies, no external CDN. Pure HTML + CSS + vanilla JS.

---

## Layout

```
┌─────────────────────────────────── header ───────────────────────────────────┐
│ Title   [CDP badge] [ADB badge]  Account: [select] [Switch]                  │
│                                  [Launch Chrome] [Delete Profile]  [↺]       │
├──────────────────┬───────────────────────────────────────────────────────────┤
│ aside            │ .content (scrollable)                                      │
│                  │                                                             │
│ Albums panel     │  Manifest Stats (8 stat cards)                             │
│ [Load] [Reload]  │                                                             │
│                  │  Full Library Pipeline (7 op-btn cards)                    │
│ □ Album 1   142  │                                                             │
│ □ Album 2    38  │  Album-Specific Pipeline (2 op-btn cards)                  │
│ ...              │                                                             │
│                  │  #opSummary (last operation result)                         │
│ [All][None]      │                                                             │
│ [Match Downloads]│                                                             │
├──────────────────┴───────────────────────────────────────────────────────────┤
│ Log panel (SSE stream)                                              [Clear]   │
└──────────────────────────────────────────────────────────────────────────────┘
```

Grid: `grid-template-columns: 280px 1fr`, `grid-template-rows: 1fr 220px`. The aside spans both rows.

---

## SSE connection

```js
function connectSSE() {
  sse = new EventSource('/api/events');
  sse.onmessage = (e) => { ... }
  sse.onerror = () => setTimeout(connectSSE, 3000); // auto-reconnect
}
```

Reconnects automatically if the server restarts.

**Event handling in `onmessage`:**

| `msg.type` | Action |
|------------|--------|
| `log` | `appendLog(text, level)` |
| `stats` | `updateStats(stats)` — updates all 8 stat cards |
| `opStart` | Sets `currentOp`, calls `updateOpButtons()` |
| `opEnd` | Clears `currentOp`, marks button done/failed, updates `#opSummary`. If `name === 'match'`, calls `refreshMatchedKeys()` |

---

## State variables

| Variable | Type | Description |
|----------|------|-------------|
| `currentOp` | `string\|null` | Name of the running operation. Mirrors the server. |
| `albums` | `Array` | Loaded from `/api/albums` |
| `lastMatchedMediaKeys` | `string[]` | Keys of downloaded+unprocessed items. Set after `opMatchAlbums` completes. Used to scope `Trash+Reupload Selected`. |

---

## Key functions

### `refreshStatus()`

Polls `/api/status` every 10 seconds and on page load. Updates the CDP/ADB badges, account selector, and stat cards.

### `updateOpButtons()`

Called whenever `currentOp` changes. Disables all `.op-btn` elements while busy. Re-enables them when idle. Also re-evaluates the enabled state of context-sensitive buttons (`matchBtn`, `btn-scan-albums`, `btn-trash-sel`).

### `runOp(name)`

Generic operation trigger. Calls `POST /api/{name}` and clears the button's previous status indicator.

### `runTrashSelected()`

Like `runOp`, but sends `{ mediaKeys: lastMatchedMediaKeys }` to `/api/trash-reupload` so the operation scopes to album-matched items only.

### `loadAlbums()`

Fetches `/api/albums`, renders the album list, calls `onAlbumChange()`.

### `onAlbumChange()`

Recounts selected albums, updates the scope badge, enables/disables `matchBtn` and `btn-scan-albums`.

### `matchAlbums()`

Posts `{ albumIds }` to `/api/match`. Actual result handling happens via SSE `opEnd → refreshMatchedKeys()`.

### `refreshMatchedKeys()`

Fetches `/api/manifest` and filters for `downloaded && !reuploadComplete` items. Sets `lastMatchedMediaKeys` and enables `btn-trash-sel`.

### `loadChromeInfo()`

Fetches `/api/chrome-info`. Shows/hides and labels the `Delete Profile` button based on whether the profile directory exists.

### `appendLog(text, level)`

Appends a `<div class="log-{level}">` to `#logOutput`. Auto-scrolls. Limits to 2000 entries.

---

## Operation button states

Each `.op-btn` has a `.op-status` span in the top-right corner and cycles through CSS classes:

| Class | Visual | Meaning |
|-------|--------|---------|
| (none) | neutral | Idle, not yet run |
| `.running` | pulsing yellow border | Currently executing |
| `.done-ok` | green border + `✓` | Last run succeeded |
| `.done-fail` | red border + `✗` | Last run failed |

States are cleared at the start of each new run via `clearOpStatus(name)`.
