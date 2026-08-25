export async function getTokens(cdp) {
  const t = await cdp.evaluate(`
    (() => {
      const g = window.WIZ_global_data;
      if (!g) return { error: 'WIZ_global_data not found' };
      return { at: g.SNlM0e, fsid: g.FdrFJe, bl: g.cfb2h, path: g.eptZe };
    })()`);
  if (t?.error) throw new Error(t.error);
  return t;
}

export async function callRpc(cdp, rpcId, data, tokens, { allowEmpty = false, reqType = 'generic', sourcePath = null } = {}) {
  if (!tokens) tokens = await getTokens(cdp);
  const sourcePathExpr = sourcePath != null ? JSON.stringify(sourcePath) : 'window.location.pathname';
  const text = await cdp.evaluate(`
    (async () => {
      const rpcId = ${JSON.stringify(rpcId)};
      const wrapped = [[[rpcId, ${JSON.stringify(JSON.stringify(data))}, null, ${JSON.stringify(reqType)}]]];
      const body = 'f.req=' + encodeURIComponent(JSON.stringify(wrapped)) + '&at=' + encodeURIComponent(${JSON.stringify(tokens.at)}) + '&';
      const params = new URLSearchParams({
        rpcids: rpcId,
        'source-path': ${sourcePathExpr},
        'f.sid': ${JSON.stringify(tokens.fsid)},
        bl: ${JSON.stringify(tokens.bl)},
        pageId: 'none',
        rt: 'c',
      });
      const url = ${JSON.stringify(`https://photos.google.com${tokens.path}data/batchexecute?`)} + params;
      const resp = await fetch(url, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body,
      });
      return resp.text();
    })()`);
  const lines = text.split('\n').filter(l => l.includes('wrb.fr'));
  if (!lines.length) {
    if (allowEmpty) return null;
    throw new Error(`RPC ${rpcId}: empty response`);
  }
  const parsed = JSON.parse(lines[0]);
  return JSON.parse(parsed[0][2]);
}

export async function enumerateAll(cdp, tokens, { albumId = null, mode = 1, archive = false, onPage } = {}) {
  const items = [];
  let pageToken = null;
  let page = 0;
  let archivePath = null;
  if (archive) {
    const m = tokens.path.match(/^(\/u\/\d+)/);
    archivePath = (m ? m[1] : '') + '/archive';
  }
  do {
    let pageItems, nextToken;
    if (albumId) {
      // snAcKc [albumId, pageToken, null, null] → payload[1]=items, payload[2]=nextPage
      const payload = await callRpc(cdp, 'snAcKc', [albumId, pageToken, null, null], tokens);
      pageItems = payload?.[1] ?? [];
      nextToken = payload?.[2] ?? null;
    } else if (archive) {
      // archive uses source-path=/u/N/archive and payload position[5]=2
      const payload = await callRpc(cdp, 'lcxiM', [pageToken, null, 500, null, 1, 2], tokens, { sourcePath: archivePath });
      pageItems = payload?.[0] ?? [];
      nextToken = payload?.[1] ?? null;
    } else {
      const payload = await callRpc(cdp, 'lcxiM', [pageToken, null, 500, null, mode, 1], tokens);
      pageItems = payload?.[0] ?? [];
      nextToken = payload?.[1] ?? null;
    }
    page++;
    items.push(...pageItems);
    if (onPage) await onPage(page, items.length, pageItems);
    pageToken = nextToken;
  } while (pageToken);
  return items;
}

export async function batchQuotaInfo(cdp, tokens, mediaKeys) {
  const PARALLEL = 50;
  const results = [];
  for (let i = 0; i < mediaKeys.length; i += PARALLEL) {
    const chunk = mediaKeys.slice(i, i + PARALLEL);
    const items = await cdp.evaluate(`
      (async () => {
        const keys = ${JSON.stringify(chunk)};
        const prefix = (window.location.pathname.match(/^\\/u\\/\\d+/) || [''])[0];
        const fetched = await Promise.all(keys.map(async key => {
          try {
            const wrapped = [[["fDcn4b", JSON.stringify([key]), null, "1"]]];
            const body = 'f.req=' + encodeURIComponent(JSON.stringify(wrapped)) + '&at=' + encodeURIComponent(${JSON.stringify(tokens.at)}) + '&';
            const params = new URLSearchParams({
              rpcids: 'fDcn4b', 'source-path': prefix + '/photo/' + key,
              'f.sid': ${JSON.stringify(tokens.fsid)}, bl: ${JSON.stringify(tokens.bl)}, pageId: 'none', rt: 'c',
            });
            const url = ${JSON.stringify(`https://photos.google.com${tokens.path}data/batchexecute?`)} + params;
            const resp = await fetch(url, { method: 'POST', credentials: 'include', headers: {'content-type': 'application/x-www-form-urlencoded;charset=UTF-8'}, body });
            const text = await resp.text();
            const line = text.split('\\n').find(l => l.includes('wrb.fr'));
            if (!line) return null;
            const payload = JSON.parse(JSON.parse(line)[0][2]);
            return payload?.[0] ?? null;
          } catch { return null; }
        }));
        return fetched.filter(Boolean);
      })()`);
    if (Array.isArray(items)) results.push(...items);
  }
  return results;
}

export async function archivePhoto(cdp, tokens, dedupKey) {
  const r = await cdp.evaluate(`
    (async () => {
      const d = [[[null,[1],[null,${JSON.stringify(dedupKey)}]]],null,1];
      const w = [[['w7TP3c', JSON.stringify(d), null, 'generic']]];
      const body = 'f.req=' + encodeURIComponent(JSON.stringify(w)) + '&at=' + encodeURIComponent(${JSON.stringify(tokens.at)}) + '&';
      const p = new URLSearchParams({ rpcids: 'w7TP3c', 'source-path': ${JSON.stringify(tokens.path)}, 'f.sid': ${JSON.stringify(tokens.fsid)}, bl: ${JSON.stringify(tokens.bl)}, pageId: 'none', rt: 'c' });
      const resp = await fetch(${JSON.stringify(`https://photos.google.com${tokens.path}data/batchexecute?`)} + p, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body,
      });
      const t = await resp.text();
      return { status: resp.status, hasError: t.includes('"er"') };
    })()`);
  if (r.status !== 200 || r.hasError) throw new Error(`w7TP3c status=${r.status} hasError=${r.hasError}`);
}

export async function listAllAlbums(cdp, tokens) {
  const accountMatch = tokens.path.match(/^(\/u\/\d+\/)/);
  const accountPrefix = accountMatch ? accountMatch[1] : '/';
  const albumsUrl = `https://photos.google.com${accountPrefix}albums`;
  const result = await cdp.evaluate(`
    (async () => {
      const resp = await fetch(${JSON.stringify(albumsUrl)}, { credentials: 'include' });
      if (!resp.ok) return { error: 'HTTP ' + resp.status };
      const html = await resp.text();
      const marker = html.indexOf("key: 'ds:5'");
      if (marker < 0) return { error: 'ds:5 block not found — are you signed in and on google.com/photos?' };
      const dataPos = html.indexOf('data:', marker);
      const start = dataPos >= 0 ? html.indexOf('[', dataPos) : -1;
      if (start < 0) return { error: 'data array not found in ds:5 block' };
      let depth = 0, inStr = false, strChar = 0, esc = false, end = -1;
      for (let i = start; i < html.length; i++) {
        const cc = html.charCodeAt(i);
        if (esc) { esc = false; continue; }
        if (inStr) { if (cc === 92) esc = true; else if (cc === strChar) inStr = false; }
        else {
          if (cc === 34 || cc === 39) { inStr = true; strChar = cc; }
          else if (cc === 91 || cc === 123) depth++;
          else if ((cc === 93 || cc === 125) && --depth === 0) { end = i; break; }
        }
      }
      if (end < 0) return { error: 'bracket matching failed' };
      try { return { data: JSON.parse(html.slice(start, end + 1)) }; }
      catch (e) { return { error: 'JSON.parse: ' + e.message }; }
    })()`);

  if (result?.error) throw new Error(`Albums page: ${result.error}`);
  const albums = [];
  const entries = Array.isArray(result?.data?.[0]) ? result.data[0] : [];
  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    const albumId = entry[0];
    if (!albumId || typeof albumId !== 'string') continue;
    const infoObj = entry.find(e => e && typeof e === 'object' && !Array.isArray(e) && e['72930366']);
    if (!infoObj) continue;
    const info = infoObj['72930366'];
    const title = typeof info?.[1] === 'string' ? info[1] : `(untitled ${albumId.slice(-6)})`;
    const count = typeof info?.[3] === 'number' ? info[3] : null;
    albums.push({ albumId, title, count });
  }
  return albums;
}
