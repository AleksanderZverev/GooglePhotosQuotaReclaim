# gphotos-storage-recovery — контекст для Claude

Описание проекта и инструкция по запуску: [README.md](README.md)

## Что делает проект

Node.js CLI-пайплайн, который освобождает квоту Google Photos. Находит фото/видео, занимающие место, скачивает их, удаляет из облака, пушит на Pixel 1 через ADB — Google Photos на Pixel перезаливает их бесплатно (у Pixel 1 есть вечное исключение на неограниченный Original quality бэкап).

## Архитектура

Все 5 шагов — отдельные скрипты, каждый идемпотентен. Состояние хранится в `manifest.json` (массив объектов). Общение с Google Photos идёт через CDP (Chrome DevTools Protocol на порту 9222): скрипты инжектируют JS в аутентифицированную вкладку и вызывают недокументированные `batchexecute` RPC.

### Файлы

| Файл | Шаг | Назначение |
|------|-----|------------|
| `scan-quota-items.mjs` | 1 | Сканирует библиотеку, находит элементы с `takesUpSpace=true`, пишет `manifest.json` |
| `batch-download.mjs` | 2 | Скачивает все элементы из манифеста в `./downloads/` |
| `enrich-dedupkeys.mjs` | 3 | Дополняет манифест `dedupKey` (нужен для RPC удаления) |
| `save-album-memberships.mjs` | 3b | Перебирает все альбомы, сохраняет `item.albums` в манифест |
| `batch-trash-reupload.mjs` | 4 | **Деструктивный шаг**: удаляет из облака + пушит на Pixel по ADB |
| `verify-reupload.mjs` | 5 | После бэкапа Pixel проверяет `takesUpSpace=false`, сохраняет `newMediaKey` |
| `restore-album-memberships.mjs` | 6 | Возвращает фото в альбомы по сохранённым `item.albums` + `item.newMediaKey` |
| `check-quota-status.mjs` | — | Утилита: проверить статус одного элемента по mediaKey |
| `download-test.mjs` | — | Утилита: скачать один файл для теста |

### RPC-коды

| RPC | Действие |
|-----|----------|
| `lcxiM` | Постраничный обход библиотеки (mode 1), архива (mode 2), или конкретного альбома (albumId как 2-й параметр) |
| `EWgK9e` | Пакетная проверка квоты (до 5000 ключей за раз) |
| `pLFTfd` | Получить подписанный URL для скачивания |
| `XwAOJf` | Переместить в корзину `[null,1,[dedupKey],3]` source-path=/photos; постоянно удалить из корзины `[null,2,[dedupKey],2]` source-path=/trash |
| `F2A0H` | Перечислить все альбомы пользователя |
| `E1Cajb` | Добавить элементы в альбом: `[[mediaKey, ...], albumId]`, source-path=/album/{albumId} |

### Схема manifest.json

```jsonc
[
  {
    "mediaKey": "...",       // идентификатор в API Google Photos
    "dedupKey": "...",       // нужен для XwAOJf (шаг 3 enrich)
    "filename": "IMG_0001.jpg",
    "sizeBytes": 4200000,
    "consumesQuota": true,
    "downloaded": true,
    "downloadedAs": "C:\\...\\downloads\\IMG_0001.jpg",
    "pushedAs": "IMG_0001.jpg",   // имя файла на Pixel (уникальное)
    "reuploadComplete": true,
    "verified": true
  }
]
```

## Критические ограничения

- **Шаг 4 необратим**: фото удаляется из облака до того, как Pixel его перезальёт. Скрипт не запустится, пока все файлы не скачаны локально.
- `XwAOJf` требует `dedupKey`, а не `mediaKey` — без шага enrich шаг 4 не работает.
- Архивированные фото не видны в mode 1 (`lcxiM`). Для них нужно вручную поменять параметр mode на `2`.
- Скачивание (`pLFTfd`) нельзя делать из страницы (CORS) — только через Node.js `fetch` с куками сессии.
- **Альбомы не сохраняются**: после удаления и повторной загрузки фото теряют членство в альбомах.
- **`mediaKey` нестабилен**: одно и то же фото может иметь разные `mediaKey` в контексте разных альбомов. `dedupKey` — стабильный идентификатор физического фото. Все дедупликации должны использовать `dedupKey` (с фолбэком на `mediaKey` для старых записей). `scan-quota-items.mjs` дедуплицирует `allMediaKeys` по `dedupKey` после Phase 1 и хранит `dedupKey` в `manifest.json` с шага 1 (не нужно ждать `enrich-dedupkeys.mjs`).

## Порядок запуска (Windows)

Chrome запускать с:
```
chrome.exe --remote-debugging-port=9222 --user-data-dir="%cd%\.browser-profile"
```

Затем последовательно:
```
npm run scan             # 1. найти квотные фото → manifest.json
npm run download         # 2. скачать в ./downloads/
                         #    (опц.) перезаписать GTH-обогащёнными файлами
npm run enrich           # 3. получить dedupKey для каждого элемента
npm run albums-save      # 4. сохранить альбомы ПЕРЕД удалением ← нельзя пропускать
npm run trash-reupload   # 5. удалить из облака + push на Pixel  ← необратимо
                         #    подождать 1–4 часа пока Pixel делает бэкап
npm run verify           # 6. подтвердить quota-free + записать newMediaKey
npm run albums-restore   # 7. вернуть фото в альбомы
adb shell rm /sdcard/DCIM/Camera/*   # 8. почистить Pixel
```

### GTH-интеграция (опционально, шаг 2.5)

GooglePhotosTakeoutHelper встраивает в EXIF описания, исправленные timestamps и GPS из JSON-sidecar файлов Google. Чтобы воспользоваться:
1. Запусти `npm run download`
2. Обработай те же файлы через GTH
3. Скопируй результат поверх `./downloads/` — имена файлов должны совпадать с `downloadedAs` в manifest.json
4. Продолжай с `npm run enrich`

Обогащённые EXIF-метаданные попадут в Google Photos вместе с перезаливкой.

## Пути и платформа

Все пути к файлам используют `fileURLToPath(new URL(..., import.meta.url))` — корректно работает на Windows (без этого `.pathname` возвращает `/C:/...`).
