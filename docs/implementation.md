# Implementation details

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

## CLI pipeline

Run scripts in order from the project root. Each is idempotent.

Start Chrome with CDP enabled (PowerShell):

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
    --remote-debugging-port=9222 `
    --user-data-dir="$env:TEMP\Chrome-GPhotos-CDP"
```

Navigate to https://photos.google.com and sign in.

```bash
npm run scan             # 1. Find quota items → manifest.json
npm run download         # 2. Download to ./downloads/
npm run enrich           # 3. Fill in dedupKeys
npm run albums-save      # 4. Save album memberships BEFORE deletion
npm run trash-reupload   # 5. Delete from cloud + push to Pixel  ← irreversible
                         #    Wait 1–4 hours for Pixel backup
npm run verify           # 6. Confirm quota freed + record newMediaKey
npm run albums-restore   # 7. Restore photos to albums
adb shell rm /sdcard/DCIM/Camera/*   # 8. Clean Pixel
```

### Optional: Better metadata via GooglePhotosTakeoutHelper

After `npm run download`, overwrite `./downloads/` with files processed by
[GooglePhotosTakeoutHelper Neo](https://github.com/Xentraxx/GooglePhotosTakeoutHelper_Neo).
GTH embeds descriptions, timestamps, and GPS from Google's JSON sidecars into EXIF.
Filenames must match what's in `downloadedAs` in `manifest.json`.

---

## RPCs used

All RPCs use `batchexecute` at `https://photos.google.com{/u/N/}data/batchexecute`.
Authentication uses XSRF tokens and session ID from `window.WIZ_global_data`, injected via CDP.

| RPC | Purpose | Request format |
|-----|---------|----------------|
| `lcxiM` | Library/archive/album enumeration (500/page) | `[pageToken, albumId\|null, pageSize, null, mode, 1]` |
| `EWgK9e` | Batch quota check (5000/call) | `[[[mappedKeys], [fieldMask]]]` |
| `pLFTfd` | Download URL (signed, short-lived) | `[["mediaKey"], [1]]` |
| `XwAOJf` | Move to trash / permanent delete | `[null, 1, ["dedupKey"], 3]` / `[null, 2, ["dedupKey"], 2]` |
| `F2A0H` | List all albums (100/page) | `[pageToken, null, 100]` |
| `E1Cajb` | Add items to album | `[[mediaKey, ...], albumId]` |

---

## Critical constraints

- **Delete-first required.** Google Photos uses perceptual hash deduplication. Re-uploading without deleting first does NOT reclaim quota.
- **`XwAOJf` uses dedupKey, not mediaKey.** The trash RPC takes a different identifier. Run Enrich first.
- **Archive items need mode 2.** Items in the Google Photos archive won't appear in library enumeration (mode 1). Use `lcxiM` with mode `2` to find them — only available via CLI currently.
- **In-page fetch is CORS-blocked.** Download URLs from `pLFTfd` must be fetched from Node.js, not from the page context.

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

## Acknowledgments

RPC discovery informed by [xob0t/Google-Photos-Toolkit](https://github.com/xob0t/Google-Photos-Toolkit) and [xob0t/google_photos_web_client](https://github.com/xob0t/google_photos_web_client).
