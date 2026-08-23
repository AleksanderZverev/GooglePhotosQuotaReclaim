# CDP and RPC Layer

## CdpSession class

Thin wrapper over a WebSocket connection to Chrome DevTools Protocol.

```js
class CdpSession {
  send(method, params)   // → Promise<result>
  evaluate(expression)   // → Promise<any>  (returnByValue: true)
  close()
}
```

`evaluate` runs a JS string in the browser page and returns `result.value`. Throws if `exceptionDetails` is present in the response.

**Connection lifecycle:** created fresh per operation, closed in `finally`. Never reused across operations to avoid state accumulation.

---

## connectCdp()

```js
async function connectCdp() → CdpSession
```

1. `GET http://127.0.0.1:9222/json` → list of open tabs
2. Finds the tab where `url.includes('photos.google.com')`
3. Opens WebSocket to `tab.webSocketDebuggerUrl`
4. Returns a `CdpSession`

Throws: `"No Google Photos tab found"` if no matching tab.

---

## getCdpTabs()

```js
async function getCdpTabs() → Tab[]
```

Non-throwing version used by `/api/status`. Returns `[]` on network error (Chrome not running).

---

## getTokens(cdp)

```js
async function getTokens(cdp) → { at, fsid, bl, path }
```

Evaluates in the browser page:
```js
const g = window.WIZ_global_data;
return { at: g.SNlM0e, fsid: g.FdrFJe, bl: g.cfb2h, path: g.eptZe };
```

| Field | Wiz key | Used as |
|-------|---------|---------|
| `at`  | `SNlM0e` | XSRF token in POST body (`&at=...`) |
| `fsid`| `FdrFJe` | `f.sid` query param |
| `bl`  | `cfb2h`  | `bl` query param (build label) |
| `path`| `eptZe`  | URL prefix e.g. `/u/0/` |

Tokens are valid for the duration of the browser session. They are re-fetched at the start of each operation. Long-running operations (scan, trash) reuse the tokens fetched at the start — if the session expires mid-operation, the next RPC call will fail with an auth error.

---

## callRpc(cdp, rpcId, data, tokens?)

```js
async function callRpc(cdp, rpcId, data, tokens?) → payload
```

Builds the `batchexecute` request on the Node.js side, then sends a `fetch` call into the browser via CDP to execute it (so session cookies are included automatically).

**Request construction:**
```js
f.req = encodeURIComponent(JSON.stringify([[[rpcId, JSON.stringify(data), null, 'generic']]]))
     + '&at=' + encodeURIComponent(tokens.at)
```

**URL:**
```
https://photos.google.com{tokens.path}data/batchexecute
  ?rpcids={rpcId}&source-path=/photos&f.sid={tokens.fsid}&bl={tokens.bl}&pageId=none&rt=c
```

**Response parsing:**
```js
text.split('\n').filter(l => l.includes('wrb.fr'))[0]
→ JSON.parse → [0][2] → JSON.parse → payload
```

The `JSON.stringify(url)` and `JSON.stringify(body)` in the injected JS string ensure safe embedding of tokens and URLs with special characters.

---

## enumerateAll(cdp, tokens, opts?)

```js
async function enumerateAll(cdp, tokens, {
  albumId?: string,   // null = full library
  mode?: 1 | 2,       // 1 = library (default), 2 = archive
  onPage?: async (page, totalSoFar, pageItems) => void
}) → rawItem[]
```

Paginates `lcxiM` until `pageToken` is null.

**Raw item structure** (from lcxiM response):
- `[0]` = mediaKey
- `[3]` = dedupKey
- `[2]` = timestamp

Filenames are **not** available from `lcxiM` — use `batchQuotaInfo` for that.

**Mode note:** Mode `2` (archive) is not exposed in the GUI currently. If needed, items in the Google Photos archive must be scanned with mode 2 by modifying the CLI scripts.

---

## batchQuotaInfo(cdp, tokens, mediaKeys)

```js
async function batchQuotaInfo(cdp, tokens, mediaKeys: string[]) → quotaItem[]
```

Calls `EWgK9e` in chunks of 5000.

**Request payload:**
```js
[[[mediaKeys.map(k => [k])], [[...24 nulls, [], ...11 nulls, []]]]]
```

**Quota item structure** (from EWgK9e response, at `payload[0][1]`):
- `[0]` = mediaKey
- `[1][3]` = filename
- `[1][9]` = size (bytes, as string)
- `[1][6]` = timestamp
- `[1].at(-1)` = quota array `lastArr`:
  - `lastArr[0] === 1` → takes up space
  - `lastArr[1]` → bytes consumed
  - `lastArr[2] === 2` → original quality

---

## listAllAlbums(cdp, tokens)

```js
async function listAllAlbums(cdp, tokens) → { albumId, title, count? }[]
```

Paginates `F2A0H` (100 albums/page).

**Album entry structure** (from F2A0H response):
- `[0]` = albumId
- `[2]` or `[3]` = title (tries both; title field position varies)
- `[8]` = item count (not always present)

---

## RPC reference

| RPC ID | Method | Request data | Returns |
|--------|--------|--------------|---------|
| `lcxiM` | Library/album enum | `[pageToken, albumId\|null, 500, null, mode, 1]` | Items + next page token |
| `EWgK9e` | Batch quota info | `[[[keys.map(k=>[k])], [opts]]]` | `[0][1]` = quota item array |
| `F2A0H` | List albums | `[pageToken, null, 100]` | `[0]` = album array |
| `XwAOJf` | Trash item | `[null, 1, [dedupKey], 3]` | `status + hasError` |
| `zy2MWb` | Add to album | `[albumId, [[mediaKey], ...]]` | (checked for error) |

The `XwAOJf` call is constructed inline in `opTrashReupload` rather than via `callRpc`, because it checks the raw response text for `"er"` rather than parsing the wrb.fr envelope.
