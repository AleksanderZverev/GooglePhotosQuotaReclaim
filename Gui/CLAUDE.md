# Gui — контекст для Claude

Веб-интерфейс к пайплайну gphotos-storage-recovery. Node.js HTTP-сервер (`server.mjs`) + одностраничный HTML (`index.html`). Зависимости: только `ws` (уже есть в корневом `node_modules`).

## Быстрый старт

```bash
cd Gui && node server.mjs
# → http://localhost:8080
```

## Критические ограничения

- **Деструктивный шаг необратим.** `opTrashReupload` удаляет фото из облака до того как Pixel сделает бэкап. Перед запуском: все файлы должны быть в `downloads/`, у всех должен быть `dedupKey`.
- **Одна операция одновременно.** `currentOp` — модульная переменная. Все POST `/api/*` возвращают `409` если занято. Не добавляй параллельный запуск.
- **RPC идут через браузер, не напрямую.** `callRpc` инжектирует `fetch` в страницу через CDP (`Runtime.evaluate`), чтобы сессионные куки Google подцепились автоматически. Не переводи RPC-вызовы на прямой Node.js `fetch`.
- **`XwAOJf` требует `dedupKey`, не `mediaKey`.** Шаг trash без предварительного enrich не работает.
- **Верификация по имени файла, не по mediaKey.** После перезаливки у фото новый mediaKey. `opVerify` ищет совпадения по `pushedAs` / `filename`.

## Архитектура

```
Browser ──POST /api/scan──▶ api/router.mjs ──cdp.evaluate(fetch(...))──▶ Chrome tab
           SSE /api/events ◀── broadcast('log'/'stats'/'opEnd') ◀────────────────
```

`server.mjs` — тонкая обёртка: `http.createServer → handle()`. Вся логика роутинга и операций в `api/router.mjs`.
CDP-сессия создаётся свежей на каждую операцию (в каждом `step*.mjs` есть `connectCdp()` / `finally { cdp.close() }`).

`manifest.json` и `downloads/` лежат в **родительской** папке (`WORK_DIR = path.dirname(__dirname)`). При редактировании путей не путай `__dirname` (папка `Gui/`) с `WORK_DIR` (корень проекта).

## Схема данных

Жизненный цикл поля в manifest.json:

```
scan       →  mediaKey, dedupKey?, filename, sizeBytes, consumesQuota
enrich     →  + dedupKey
match      →  + downloaded=true, downloadedAs        ← альбомный workflow
save-albums → + albums: [{albumId, albumTitle}]
trash      →  + trashedAt, pushedAs, reuploadComplete=true
verify     →  + verified, newMediaKey, verifiedAt
restore    →  + albumsRestored=true
```

## Файлы steps/

| Файл | Операция API | Шаг |
|------|-------------|-----|
| `scanStep.mjs` | `/api/scan`, `/api/scan-full` | 2 — scan+enrich+saveAlbumMemberships |
| `enrichStep.mjs` | `/api/enrich` | 3 — standalone dedupKey enrich |
| `miscSteps.mjs` | `/api/match`, `/api/cleanup-pixel`, `/api/switch-account` | разные |
| `trashReuploadStep.mjs` | `/api/trash-reupload` | 4 — необратимый шаг |
| `verifyStep.mjs` | `/api/verify` | 5 — проверка quota-free |
| `albumsStep.mjs` | `/api/restore-albums` | 6 — restore + re-archive |

## i18n

Все переводы — inline-объект `LANGS` в `index.html` (строки ~405–1305). Нет отдельных файлов.
- Функция: `t(key, ...args)` — ищет в `LANGS[lang]`, fallback на `LANGS.en`; значение может быть функцией `(n) => \`...\``
- Смена языка: `setLang(l)` → `applyLang()` + `updateStepStats()` + `updateButtonStates()`
- Локали: `en`, `ru`, `zh_TW`, `zh_CN`, `ja_JP`
- Переключатель — custom dropdown (`#langDropdown`, `.lang-option[data-lang]`)

## Кеш альбомов (lib/rpc.mjs)

- `listAllAlbums` кешируется в `_albumListCache` — повторные вызовы не делают HTTP-запрос
- `enumerateAlbumCached(cdp, tokens, albumId)` — кешированный `enumerateAll` для альбома, результаты в `_albumContentCache`
- `clearAlbumsCache()` — очищает оба кеша
  - вызывается в `handleSseConnection` (= при обновлении страницы)
  - вызывается в начале `scanStep` / `scanFullStep` (чтобы повторный скан брал свежие данные)
- Кеш живёт в памяти процесса, не персистируется

## Паттерны для изменений

**Добавить операцию:**
1. Написать `async function opXxx()` с `opStart/opEnd` и `try/finally { cdp.close() }`
2. Добавить маршрут в `ops` объект в `handle()`
3. Добавить кнопку `.op-btn` в `index.html` с `onclick="runOp('xxx')"`

**Добавить SSE-событие:**
- Сервер: `broadcast('myType', { ... })`
- HTML: добавить ветку в `sse.onmessage` switch

**Добавить RPC:**
- Для чтения данных: использовать `callRpc(cdp, 'RPCID', data, tokens)`
- Для мутации (trash, add-to-album): можно инлайнить в `cdp.evaluate` как в `opTrashReupload` для проверки raw-ответа на наличие `"er"`

## Ссылки

- [Architecture & design decisions](docs/architecture.md)
- [HTTP API reference](docs/api-reference.md)
- [Operation functions](docs/operations.md)
- [CDP & RPC layer](docs/cdp-rpc.md)
- [Frontend structure](docs/frontend.md)
- [Project root CLAUDE.md](../CLAUDE.md)
