# Operations

Each operation follows the same pattern:
1. Call `opStart(name)` → sets `currentOp`, broadcasts SSE
2. Open a fresh CDP session
3. Do work, call `log()` throughout
4. Write manifest to disk
5. Call `opEnd(name, ok, summary)` → clears `currentOp`, broadcasts SSE + updated stats
6. Close CDP in `finally`

---

## opScan({ albumIds? })

**Purpose:** Enumerate library (or specific albums) and add quota-consuming items to manifest.

**Steps:**
1. `enumerateAll()` with `lcxiM` RPC — collects `[mediaKey, dedupKey]` pairs for every item
2. `batchQuotaInfo()` with `EWgK9e` RPC — gets filename, size, quota status
3. Filters for `lastArr[0] === 1` (takes up space)
4. Deduplicates against existing manifest by `mediaKey`
5. Appends new items to manifest

**Key behaviour:** dedupKey is extracted from `lcxiM` results (position `[3]`), so items scanned via this function don't need a separate enrich step.

**When to use:** First step of any workflow. Re-run anytime to pick up new quota-consuming uploads.

---

## opEnrich()

**Purpose:** Fill in `dedupKey` for manifest items that are missing it.

This is only needed for items added by an older version of the scan script, or for items found in the archive (mode 2) which weren't scanned through `opScan`.

**Steps:**
1. Find manifest items where `dedupKey` is falsy
2. Paginate `lcxiM` mode 1 (library)
3. For each page, match `item[0]` (mediaKey) → `item[3]` (dedupKey)
4. Stop early once all targets are found

**Limitation:** Items in the Google Photos archive won't be found — they require mode 2. The log will say "X not found (may be archived)."

---

## opSaveAlbums()

**Purpose:** Record which albums each manifest item belongs to, before the destructive trash step.

**Steps:**
1. `listAllAlbums()` via `F2A0H` RPC
2. For each album: `enumerateAll()` with `albumId` via `lcxiM`
3. Cross-reference returned mediaKeys against manifest
4. Writes `item.albums = [{ albumId, albumTitle }]` per item

**Must run before `opTrashReupload`** — after deletion the original album membership is gone from Google's side.

---

## opTrashReupload({ mediaKeys?, saveAlbumsFirst? })

**Purpose:** The destructive core step. Trashes items from Google Photos and pushes local files to Pixel via ADB.

**Safety checks (pre-flight):**
- ADB device must be connected
- All target items must have `downloaded=true` and `downloadedAs` pointing to an existing file
- All target items must have `dedupKey`

**Steps:**
1. If `saveAlbumsFirst=true` (default): runs inline album save for items missing `albums`
2. Processes in batches of 10:
   - Trash via `XwAOJf` RPC (uses `dedupKey`, not `mediaKey`)
   - `adb push` to `/sdcard/DCIM/Camera/<safeName>`
   - `adb shell content insert` for MediaStore (non-fatal if fails)
   - Marks `reuploadComplete=true` only if **both** trash and push succeed
3. Saves manifest after each batch
4. Restarts Google Photos app on Pixel to trigger backup

**Filter behaviour:** If `mediaKeys` array is provided, only those items are processed. Otherwise, all `consumesQuota && downloaded && dedupKey && !reuploadComplete` items.

**Critical:** An item is never marked complete if only trash succeeded but push failed — that would mean the photo is deleted with no local copy pushed. The `trashError` field records failures.

---

## opVerify()

**Purpose:** Confirm that re-uploaded items are now quota-free and record their new mediaKey.

**When to run:** 1–4 hours after `opTrashReupload`, once the Pixel has finished backing up.

**Steps:**
1. Builds a map of `filename.toLowerCase() → manifest item` for unverified items
2. Paginates the library with `lcxiM`
3. For each page, calls `batchQuotaInfo()` (EWgK9e)
4. Matches by filename (uses `pushedAs` field first, falls back to `filename`)
5. Success: `lastArr[0]` is falsy (no space) AND `lastArr[2] === 2` (original quality)
6. Sets `verified=true`, `newMediaKey`, `verifiedAt` on success

**Why match by filename, not mediaKey?** After trash+reupload, the photo has a new mediaKey assigned by Google. The old mediaKey from the manifest no longer exists.

---

## opRestoreAlbums()

**Purpose:** Re-add verified photos to their original albums using their new mediaKeys.

**Requirements:** `item.verified=true`, `item.newMediaKey`, `item.albums` (saved before trash)

**Steps:**
1. Groups items by `albumId`
2. For each album: calls `zy2MWb` RPC in batches of 50 `newMediaKey`s
3. Sets `albumsRestored=true` per item

---

## opCleanupPixel()

**Purpose:** Remove pushed files from the Pixel's camera roll after backup is confirmed.

Runs `adb shell rm /sdcard/DCIM/Camera/*`. Fails cleanly if ADB is not connected.

Run this **after** `opVerify` confirms quota recovery.

---

## opMatchAlbums({ albumIds })

**Purpose:** Album-specific workflow entry point. Finds which photos in the selected albums have matching files in `downloads/` and registers them in the manifest.

**Steps:**
1. Reads `downloads/` directory → builds a case-insensitive filename → path map
2. For each albumId: `enumerateAll()` with `albumId`
3. `batchQuotaInfo()` to get filenames (lcxiM doesn't return filenames)
4. Matches `filename.toLowerCase()` against the downloads map
5. New items are added to manifest with `downloaded=true`, `downloadedAs` set
6. Existing items get `downloadedAs` filled in if it was missing
7. `dedupKey` is extracted from lcxiM results — no separate enrich step needed

**After this runs**, items are ready for `opTrashReupload` with the `mediaKeys` filter.

---

## opSwitchAccount(path)

Navigates the Google Photos CDP tab to `https://photos.google.com{path}` (e.g. `/u/1/`) and waits 3 seconds for the page to load. Reads the new tokens to confirm the switch.

---

## Chrome management functions

### launchChrome()

Finds Chrome at standard Windows install paths (or `CHROME_PATH` env var), spawns it with:
- `--remote-debugging-port=9222`
- `--user-data-dir=<CHROME_PROFILE_DIR>`
- Opens `https://photos.google.com`

Uses `spawn(..., { detached: true, stdio: 'ignore' }).unref()` so the Chrome process outlives the Node server.

### deleteProfile()

Calls `fs.rmSync(CHROME_PROFILE_DIR, { recursive: true, force: true })`. Chrome must be closed or the deletion will partially fail on Windows (locked files).

### findChrome()

Checks `CHROME_PATH` env var first, then probes standard paths:
- `C:\Program Files\Google\Chrome\Application\chrome.exe`
- `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`
