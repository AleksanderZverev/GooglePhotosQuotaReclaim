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
Browser ──POST /api/scan──▶ server.mjs ──cdp.evaluate(fetch(...))──▶ Chrome tab
           SSE /api/events ◀── broadcast('log'/'stats'/'opEnd') ◀──────────────
```

Сервер держит одно SSE-соединение на вкладку браузера. CDP-сессия создаётся свежей на каждую операцию.

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

## Структура server.mjs

| Блок | Строки | Содержание |
|------|--------|------------|
| Constants | 1–20 | PORT, CDP_URL, WORK_DIR, CHROME_* |
| SSE | ~25–45 | `broadcast`, `log`, `opStart`, `opEnd` |
| Manifest | ~50–70 | `readManifest`, `writeManifest`, `manifestStats` |
| CDP | ~75–120 | `CdpSession`, `connectCdp`, `getCdpTabs` |
| RPC | ~125–200 | `getTokens`, `callRpc`, `enumerateAll`, `batchQuotaInfo`, `listAllAlbums` |
| ADB | ~205–220 | `adb`, `checkAdb`, `safeName` |
| Operations | ~225–680 | `opScan` … `opSwitchAccount` |
| Chrome mgmt | ~685–720 | `findChrome`, `launchChrome`, `deleteProfile` |
| HTTP server | ~725–end | `json`, `parseBody`, `handle`, `server.listen` |

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
