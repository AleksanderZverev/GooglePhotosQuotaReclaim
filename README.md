# gphotos-storage-recovery

Reclaim Google Photos storage quota by identifying quota-consuming items, downloading them, trashing from cloud, and re-uploading via a Pixel 1's grandfathered unlimited-original-quality backup.

## How it works

Google Photos counts Original quality uploads (any date) and Storage Saver uploads (after June 1, 2021) toward your 15 GB quota. Pixel 1 (2016) has a permanent exemption: anything it uploads at Original quality costs zero quota.

This pipeline exploits that by:

1. **Scanning** the full library via undocumented `batchexecute` RPCs to find quota-consuming items
2. **Downloading** those items locally (preserving EXIF metadata)
3. **Trashing** them from Google Photos (removes quota charge)
4. **Pushing** the files to a Pixel 1 via ADB
5. **Letting Google Photos on the Pixel back them up** as "new" uploads (zero quota cost)

The result: identical photos/videos in your library, same metadata, but marked "doesn't take up space."

---

## GUI (recommended)

A web interface for the full pipeline — no command line required after setup.

### Prerequisites

- **Pixel 1** (sailfish) with Google Photos set to Original quality backup. USB debugging enabled, ADB authorized.
- **Chrome** (installed in the default location)
- **Node.js 18+**
- **ADB** installed and in PATH

### Install

```bash
git clone https://github.com/nbarari/gphotos-storage-recovery.git
cd gphotos-storage-recovery
npm install
```

### Start the GUI

```bash
node Gui/server.mjs
```

Open **http://localhost:8080** in any browser.

### Step-by-step guide

#### 1. Launch Chrome

Click **Launch Chrome** in the top bar. This opens Chrome with a temporary profile and remote debugging enabled. The button disappears once CDP connects.

> If Chrome is already running with `--remote-debugging-port=9222`, skip this step. The CDP badge will show green.

Sign into Google Photos in the Chrome window that opens.

#### 2. Connect Pixel via USB

Plug in the Pixel 1. The **ADB** badge turns green when detected. If it stays red:

```bash
adb devices        # should show your device with "device" status
```

If it shows "unauthorized", accept the USB debugging prompt on the Pixel.

#### 3. Prepare your downloads folder

You have two options:

**Option A — Full pipeline (recommended):** Use the CLI scripts to download everything first (see [CLI pipeline](#cli-pipeline) below). Then use the GUI for the rest.

**Option B — Album-specific via Google Takeout + GTH:**
1. Export your library via [Google Takeout](https://takeout.google.com) (select Google Photos)
2. Process the Takeout archive with [GooglePhotosTakeoutHelper](https://github.com/TheLastGimbus/GooglePhotosTakeoutHelper) to embed metadata back into files
3. Place the processed files into a `downloads/` folder next to the project

#### 4. Scan for quota items

- **Full library:** Click **Scan Quota** (Step 1). This enumerates your entire library and records all quota-consuming items in `manifest.json`.
- **Specific albums:** Select albums in the left sidebar → click **Match Downloads**. This finds which photos in those albums have matching files in `downloads/` and registers them.

#### 5. Enrich (only if needed)

Click **Enrich** (Step 2). This fills in missing `dedupKey` values required for the trash step. Items added via **Scan Quota** already have dedupKeys — you only need this if some items were added by an older version.

#### 6. Trash + Reupload

Click **Trash + Reupload** (Step 3).

> ⚠️ This is **irreversible**. Photos are deleted from Google Photos before the Pixel backs them up. The operation refuses to run if any file is missing from disk.

- Albums are saved automatically before trashing (toggle `saveAlbumsFirst` if you've already run Save Albums separately)
- For album-specific workflow: click **Trash + Reupload Selected** in the Album-Specific section

The operation pushes files to `/sdcard/DCIM/Camera/` and restarts the Google Photos app to trigger backup.

#### 7. Wait for Pixel backup

Wait **1–4 hours** for Google Photos on the Pixel to back up all pushed files. You can check progress in Google Photos on the Pixel (backup queue in Settings → Backup).

#### 8. Verify

Click **Verify** (Step 4). This scans your library and confirms each photo now shows `takesUpSpace=false`. Also records the new `mediaKey` needed for album restoration.

#### 9. Restore Albums

Click **Restore Albums** (Step 5). Re-adds all re-uploaded photos to their original albums.

#### 10. Cleanup Pixel

Click **Cleanup Pixel** (Step 6). Runs `adb shell rm /sdcard/DCIM/Camera/*` to remove the pushed files from the Pixel's camera roll.

#### 11. Delete Chrome profile (optional)

If you used the GUI's **Launch Chrome** button, click **Delete Profile** when done. This removes the temporary profile directory (~50–100 MB).

---

### Account switching

If your photos are spread across multiple Google accounts, use the account selector in the top bar. Select `/u/0/`, `/u/1/`, etc. and click **Switch** — the Chrome tab navigates to that account. Run the full pipeline for each account separately.

---

## CLI pipeline

Run scripts in order from the project root. Each is idempotent.

Start Chrome with CDP enabled (PowerShell):

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
    --remote-debugging-port=9222 `
    --user-data-dir="$env:TEMP\Chrome-GPhotos-CDP"
```

Navigate to https://photos.google.com and sign in.

### 1. Scan for quota-consuming items

```bash
npm run scan
```

Enumerates the full library via `lcxiM` RPC (500 items/page), then batch-checks quota status via `EWgK9e` (5000 items/call). Creates `manifest.json`.

### 2. Download all quota items

```bash
npm run download
```

Fetches signed download URLs via `pLFTfd` RPC and downloads with session cookies. Saves to `./downloads/`. Skips already-downloaded items.

> **Optional — better metadata via GooglePhotosTakeoutHelper:**
> After downloading, overwrite `./downloads/` with files processed by
> [GooglePhotosTakeoutHelper](https://github.com/TheLastGimbus/GooglePhotosTakeoutHelper).
> GTH embeds descriptions, timestamps, and GPS from Google's JSON sidecars into EXIF.
> Filenames must match what's in `downloadedAs` in `manifest.json`.

### 3. Enrich manifest with dedupKeys

```bash
npm run enrich
```

The trash RPC (`XwAOJf`) requires `dedupKey`, not `mediaKey`. This script enumerates the library to map mediaKey → dedupKey.

### 4. Save album memberships

```bash
npm run albums-save
```

Must run **before** step 5. After deletion the original album membership is gone.

### 5. Trash + push to Pixel

```bash
npm run trash-reupload
```

Safety gates: refuses to run unless ALL items are downloaded locally and all files exist on disk.

### 6. Verify quota recovery

```bash
npm run verify
```

Run after the Pixel finishes backing up (1–4 hours). Confirms `takesUpSpace=false` and records `newMediaKey`.

### 7. Restore album memberships

```bash
npm run albums-restore
```

### 8. Clean up Pixel storage

```bash
adb shell rm /sdcard/DCIM/Camera/*
```

---

## Utilities

```bash
node check-quota-status.mjs <mediaKey>    # check quota status of one item
node download-test.mjs <mediaKey> <file>  # download one item for testing
```

---

## One-time Pixel setup

If the device previously saw these files, clear app data first:

```bash
adb shell pm clear com.google.android.apps.photos
```

Sign back into Google Photos on the Pixel and configure:
- Backup: **On**
- Quality: **Original quality**
- Folders to back up: **DCIM/Camera**

---

## Critical constraints

- **Delete-first required.** Google Photos uses perceptual hash deduplication. Re-uploading without deleting first does NOT reclaim quota.
- **`XwAOJf` uses dedupKey, not mediaKey.** The trash RPC takes a different identifier. Run Enrich first.
- **Archive items need mode 2.** Items in the Google Photos archive won't appear in library enumeration (mode 1). Use `lcxiM` with mode parameter `2` to find them — only available via CLI scripts currently.
- **In-page fetch is CORS-blocked.** Download URLs from `pLFTfd` must be fetched from Node.js, not from the page context.

---

## RPCs used

| RPC | Purpose | Request format |
|-----|---------|----------------|
| `lcxiM` | Library/archive/album enumeration (500/page) | `[pageToken, albumId\|null, pageSize, null, mode, 1]` |
| `EWgK9e` | Batch quota check (5000/call) | `[[[mappedKeys], [fieldMask]]]` |
| `pLFTfd` | Download URL (signed, short-lived) | `[["mediaKey"], [1]]` |
| `XwAOJf` | Move to trash | `[null, 1, ["dedupKey"], 3]` |
| `F2A0H` | List all albums (100/page) | `[pageToken, null, 100]` |
| `zy2MWb` | Add items to album | `[albumId, [[mediaKey], ...]]` |

All RPCs use `batchexecute` at `https://photos.google.com{/u/N/}data/batchexecute`. Authentication uses XSRF tokens and session ID from `window.WIZ_global_data`, injected via CDP.

---

## Acknowledgments

RPC discovery informed by [xob0t/Google-Photos-Toolkit](https://github.com/xob0t/Google-Photos-Toolkit) and [xob0t/google_photos_web_client](https://github.com/xob0t/google_photos_web_client).

## License

MIT
