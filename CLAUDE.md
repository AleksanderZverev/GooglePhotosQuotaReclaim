# gphotos-storage-recovery — контекст для Claude

> **Основная кодовая база — `Gui/`** (веб-интерфейс). Старые CLI-скрипты в корне (`scan-quota-items.mjs` и др.) **не существуют**. Весь код — в `Gui/`. Подробный контекст GUI: [Gui/CLAUDE.md](Gui/CLAUDE.md).

## Что делает проект

Node.js веб-приложение (GUI), которое освобождает квоту Google Photos. Находит фото/видео, занимающие место, скачивает их, удаляет из облака, пушит на Pixel 1 через ADB — Google Photos на Pixel перезаливает их бесплатно (у Pixel 1 есть вечное исключение на Original quality бэкап).

## Быстрый старт

```
cd Gui && node server.mjs
# → http://localhost:8080
```

Chrome должен быть запущен с `--remote-debugging-port=9222`.

## Структура Gui/

```
Gui/
  server.mjs          — тонкая обёртка: http.createServer → handle()
  api/router.mjs      — всё HTTP-роутирование, SSE, обработка операций
  lib/
    cdp.mjs           — CDP-соединение с Chrome
    rpc.mjs           — Google Photos RPC: getTokens, callRpc, enumerateAll,
                        batchQuotaInfo, listAllAlbums, enumerateAlbumCached,
                        clearAlbumsCache, archivePhoto
    manifest.mjs      — readManifest / writeManifest / manifestStats
    sse.mjs           — SSE broadcast, log, opStart, opEnd
    adb.mjs, chrome.mjs, config.mjs
  steps/
    scanStep.mjs      — Шаг 2: scan + enrich + saveAlbumMemberships
    enrichStep.mjs    — Шаг 3 (standalone enrich)
    miscSteps.mjs     — match, cleanup-pixel, switch-account
    trashReuploadStep.mjs — Шаг 4: trash + ADB push (необратимо)
    verifyStep.mjs    — Шаг 5: проверка quota-free после бэкапа Pixel
    albumsStep.mjs    — Шаг 6: restore album memberships + re-archive
  index.html          — весь фронтенд (CSS + HTML + JS, ~1800 строк)
```

## RPC-коды

| RPC | Действие |
|-----|----------|
| `lcxiM` | Постраничный обход библиотеки (mode 1), архива (mode 2); album via `snAcKc` |
| `fDcn4b` | Квота/качество одного фото (используется в batchQuotaInfo) |
| `EWgK9e` | Пакетная проверка квоты до 5000 ключей (не реализован в GUI пока) |
| `pLFTfd` | Подписанный URL для скачивания |
| `XwAOJf` | Корзина: `[null,1,[dk],3]` /photos; удалить: `[null,2,[dk],2]` /trash |
| `snAcKc` | Перечислить альбом: `[albumId, pageToken, null, null]` |
| `E1Cajb` | Добавить в альбом: `[[mediaKeys], albumId]`, source-path=/album/{id} |
| `w7TP3c` | Архивировать фото |
| `F2A0H` / ds:5 HTML | Список всех альбомов (через fetch страницы /albums) |

## Схема manifest.json

```jsonc
{
  "mediaKey": "...",        // ID в API (нестабилен — меняется после re-upload)
  "dedupKey": "...",        // стабильный ID физического файла (нужен для XwAOJf)
  "filename": "IMG_0001.jpg",
  "sizeBytes": 4200000,
  "consumesQuota": true,
  "isOriginalQuality": true,
  "isArchived": false,
  "albums": [{ "albumId": "...", "albumTitle": "..." }],
  // — после шагов:
  "downloaded": true, "downloadedAs": "C:\\...\\IMG_0001.jpg",
  "pushedAs": "IMG_0001.jpg",   // имя на Pixel (уникальное)
  "reuploadComplete": true,
  "verified": true, "newMediaKey": "...", "verifiedAt": "...",
  "albumsRestored": true, "archivedRestored": true
}
```

## Критические ограничения

- **Шаг 4 необратим**: фото удаляется до бэкапа Pixel.
- `XwAOJf` требует `dedupKey`, не `mediaKey`.
- Архивные фото не видны в mode 1 (`lcxiM`) — нужен mode 2 / archive path.
- Скачивание (pLFTfd) нельзя делать через CDP страницы (CORS) — только Node.js fetch с куками.
- `mediaKey` нестабилен после re-upload — `dedupKey` стабилен, использовать его для дедупликации.

## Известные проблемы с файлами из Google Takeout

**GooglePhotosTakeoutHelper (и Neo-форки) зашивают oversized EXIF-thumbnail.**
Файлы, обработанные этим инструментом, содержат в EXIF-блоке (APP1) встроенную миниатюру ~496×280 px (~15 КБ) вместо стандартной 160×120. Это приводит к тому, что Android MediaStore / Google Photos на устройстве не видит файл совсем.

Симптом: APP1 сегмент > 5 КБ при том что файл — обычное JPEG без XMP.

Решение реализовано в `pushPhotoToPixel` (`Gui/steps/trashReuploadStep.mjs`): функция `stripExifThumbnail` перед каждым ADB push вырезает IFD1 + thumbnail байты и пересобирает APP1. Оригинал на диске не изменяется — правка применяется только к временному файлу для передачи.

Алгоритм: найти IFD1 pointer в IFD0 → запомнить TIFF-offset IFD1 → обнулить pointer → обрезать APP1 до этого offset → пересобрать JPEG.
