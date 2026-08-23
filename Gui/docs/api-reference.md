# API Reference

Base URL: `http://localhost:8080`

All POST bodies are JSON. All responses are JSON. Operations that run long-term return `{ ok: true, queued: "name" }` immediately and stream progress via SSE.

---

## GET /api/events

Server-Sent Events stream. Connect once; stays open.

**Event types:**

| `type`         | Payload fields                              | When                              |
|----------------|---------------------------------------------|-----------------------------------|
| `log`          | `text: string`, `level: info|success|warn|error` | Any log line from an operation |
| `stats`        | `stats: ManifestStats`                      | After each operation completes    |
| `opStart`      | `name: string`                              | Operation begins                  |
| `opEnd`        | `name: string`, `ok: boolean`, `summary: string` | Operation finishes           |

`ManifestStats`: `{ total, quota, downloaded, enriched, albumsSaved, trashed, verified, restored }`

---

## GET /api/status

Current state snapshot.

```jsonc
{
  "cdpConnected": true,
  "account": "/u/0/",           // current Google Photos account path, null if not connected
  "photosTabs": [{ "url": "...", "title": "..." }],
  "manifest": ManifestStats,
  "currentOp": null,            // string name of running operation, or null
  "adbConnected": true,
  "workDir": "C:\\...\\project",
  "downloadsDir": "C:\\...\\project\\downloads",
  "downloadCount": 215
}
```

---

## GET /api/albums

Fetches all albums from Google Photos. Requires CDP connection.

```jsonc
{
  "albums": [
    { "albumId": "AF1Q...", "title": "Vacation 2023", "count": 142 }
  ]
}
```

---

## GET /api/manifest

Full manifest array plus stats.

```jsonc
{ "manifest": [...], "stats": ManifestStats }
```

---

## GET /api/chrome-info

Returns info about the temporary Chrome profile directory.

```jsonc
{ "profileDir": "C:\\...\\Temp\\Chrome-GPhotos-CDP", "exists": true, "sizeMb": 48 }
```

---

## POST /api/scan

Find quota-consuming items. If `albumIds` provided, only scans those albums.

**Body:** `{ "albumIds"?: string[] }`

Runs: `opScan`

---

## POST /api/enrich

Fill in missing `dedupKey` values by re-enumerating the library.

**Body:** `{}`

Runs: `opEnrich`

---

## POST /api/save-albums

Save album membership for all manifest items. Must run before trash.

**Body:** `{}`

Runs: `opSaveAlbums`

---

## POST /api/trash-reupload

Trash items from Google Photos and push to Pixel via ADB. Optionally saves album memberships first.

**Body:**
```jsonc
{
  "saveAlbumsFirst": true,      // default true — save albums before trashing
  "mediaKeys"?: string[]        // if provided, only process these specific items
}
```

Runs: `opTrashReupload`

---

## POST /api/verify

Confirm re-uploaded items are now quota-free. Run after Pixel backup completes (1–4 hours).

**Body:** `{}`

Runs: `opVerify`

---

## POST /api/restore-albums

Re-add items to their original albums using `newMediaKey`.

**Body:** `{}`

Runs: `opRestoreAlbums`

---

## POST /api/cleanup-pixel

Remove pushed files from `/sdcard/DCIM/Camera/*` via ADB.

**Body:** `{}`

Runs: `opCleanupPixel`

---

## POST /api/match

Enumerate selected albums, check quota, match filenames against `downloads/` directory, add matched items to manifest with `downloaded=true`.

**Body:** `{ "albumIds": string[] }` — required

Runs: `opMatchAlbums`

---

## POST /api/switch-account

Navigate the Google Photos tab to a different account path (`/u/0/`, `/u/1/`, …).

**Body:** `{ "path": "/u/1/" }`

---

## POST /api/launch-chrome

Launch Chrome with `--remote-debugging-port=9222` and the temp profile.

```jsonc
{ "ok": true, "profileDir": "C:\\...\\Temp\\Chrome-GPhotos-CDP" }
```

---

## POST /api/delete-profile

Delete the temp Chrome profile directory. Chrome must be closed first.

```jsonc
{ "ok": true, "deleted": "C:\\...\\Temp\\Chrome-GPhotos-CDP" }
// or if it didn't exist:
{ "ok": true, "note": "Profile directory does not exist" }
```

---

## Error responses

`409 Conflict` — another operation is running:
```jsonc
{ "error": "Operation 'scan' is running", "busy": true }
```

`500 Internal Server Error`:
```jsonc
{ "error": "No Google Photos tab found. Open photos.google.com in Chrome with --remote-debugging-port=9222" }
```
