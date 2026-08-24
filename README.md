# gphotos-storage-recovery

Reclaim Google Photos storage quota. Finds quota-consuming photos, downloads them, trashes from cloud, and re-uploads via a Pixel 1's grandfathered unlimited-original-quality backup — so they cost zero quota.

## Prerequisites

- **Pixel 1** (sailfish) with USB debugging enabled and Google Photos set to Original quality backup
- **Chrome** installed in the default location
- **Node.js 18+**
- **ADB (Android Debug Bridge)** — download [Platform Tools](https://developer.android.com/tools/releases/platform-tools) and place `adb.exe` (Windows) or `adb` (Linux/macOS) in the `adb/` folder

## Install

```bash
git clone https://github.com/nbarari/gphotos-storage-recovery.git
cd gphotos-storage-recovery
npm install
```

## Start the GUI

```bash
node Gui/server.mjs
```

Open **http://localhost:8080** in any browser.

## Workflow

1. **Launch Chrome** — click Launch Chrome in the top bar, sign into Google Photos
2. **Connect Pixel** via USB — ADB badge turns green when detected
3. **Scan** — select albums in the sidebar, or check **Scan all library** to find all quota-consuming photos
4. **Match Downloads** — place downloaded photo files in the `downloads/` folder, then click Match
   - To preserve metadata (dates, GPS), process files with [GooglePhotosTakeoutHelper Neo](https://github.com/Xentraxx/GooglePhotosTakeoutHelper_Neo) before placing them in `downloads/`
5. **Trash + Reupload** — deletes from cloud and pushes to Pixel *(irreversible)*
6. **Wait 1–4 h** for Pixel to back up
7. **Verify** — confirm quota freed
8. **Restore Albums** — put photos back into original albums
9. **Cleanup Pixel** — remove pushed files from device

## Implementation details

See [docs/implementation.md](docs/implementation.md) for the CLI pipeline, RPC reference, critical constraints, and technical notes.

## License

MIT
