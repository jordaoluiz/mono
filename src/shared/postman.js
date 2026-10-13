// Importação e exportação: coleção Postman v2.1 e formato nativo do Mono.
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.MonoPostman = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
  const kvGet = (arr, key) => ((arr || []).find((x) => x.key === key) || {}).value;

  // ---------- Postman → modelo ----------
  function authFromPostman(a) {
    if (!a || !a.type) return null;
    if (a.type === 'noauth') return { type: 'none' };
    if (a.type === 'bearer') return { type: 'bearer', token: kvGet(a.bearer, 'token') || '' };
    if (a.type === 'basic') return { type: 'basic', username: kvGet(a.basic, 'username') || '', password: kvGet(a.basic, 'password') || '' };
    if (a.type === 'apikey') return { type: 'apikey', key: kvGet(a.apikey, 'key') || '', value: kvGet(a.apikey, 'value') || '', in: kvGet(a.apikey, 'in') === 'query' ? 'query' : 'header' };
    if (a.type === 'oauth2') {
      const g = kvGet(a.oauth2, 'grant_type');
      return { type: 'oauth2', oauth2: { grant: g === 'password_credentials' ? 'password' : 'client_credentials', tokenUrl: kvGet(a.oauth2, 'accessTokenUrl') || '', clientId: kvGet(a.oauth2, 'clientId') || '', clientSecret: kvGet(a.oauth2, 'clientSecret') || '', scope: kvGet(a.oauth2, 'scope') || '', clientAuth: kvGet(a.oauth2, 'client_authentication') === 'header' ? 'header' : 'body' } };
    }
    return null;
  }
  const desc = (d) => (typeof d === 'string' ? d : d && d.content) || '';
  // Scripts do Postman: event[{ listen: 'prerequest' | 'test', script: { exec: [...] } }]
  const evCode = (events, listen) => (events || []).filter((e) => e && e.listen === listen && e.script && !e.disabled)
    .map((e) => [].concat(e.script.exec || []).join('\n')).join('\n').trim();
  function toEvents(o) {
    const ev = [];
    const add = (listen, code) => { if (String(code || '').trim()) ev.push({ listen, script: { type: 'text/javascript', exec: String(code).split('\n') } }); };
    add('prerequest', o.pre); add('test', o.tests);
    return ev.length ? { event: ev } : {};
  }
  function fromPostman(json, sourceUrl = '') {
    const endpoints = [];
    const vars = (json.variable || []).map((v) => ({ key: v.key, value: v.value == null ? '' : String(v.value) }));
    const folderMeta = [];
    const walk = (items, path) => {
      for (const it of items || []) {
        if (Array.isArray(it.item)) {
          const fp = [...path, it.name];
          folderMeta.push({ path: fp, pre: evCode(it.event, 'prerequest'), tests: evCode(it.event, 'test'), auth: authFromPostman(it.auth), description: desc(it.description) });
          walk(it.item, fp);
          continue;
        }
        const r = it.request || {};
        const req = typeof r === 'string' ? { method: 'GET', url: r } : r;
        const url = typeof req.url === 'string' ? req.url : (req.url && (req.url.raw || [req.url.protocol ? req.url.protocol + '://' : '', [].concat(req.url.host || []).join('.'), '/' + [].concat(req.url.path || []).join('/')].join(''))) || '';
        const query = typeof req.url === 'object' && req.url ? (req.url.query || []).map((q) => ({ key: q.key, value: q.value ?? '', enabled: !q.disabled })) : [];
        let body = { type: 'none', raw: '', form: [] };
        const b = req.body;
        const lang = (b && b.options && b.options.raw && b.options.raw.language) || '';
        if (b && b.mode === 'raw') body = { type: /json/i.test(lang) || (!lang && /^\s*[[{]/.test(b.raw || '')) ? 'json' : /xml/i.test(lang) || /^\s*<\?xml|^\s*<[\w:]+Envelope/i.test(b.raw || '') ? 'xml' : 'text', raw: b.raw || '', form: [] };
        if (b && b.mode === 'urlencoded') body = { type: 'form', raw: '', form: (b.urlencoded || []).map((f) => ({ key: f.key, value: f.value ?? '', enabled: !f.disabled })) };
        // Arquivos: o caminho de outro computador não é usado — o usuário escolhe o arquivo de novo.
        if (b && b.mode === 'formdata') body = { type: 'multipart', raw: '', form: [], multipart: (b.formdata || []).map((f) => (f.type === 'file' ? { key: f.key, kind: 'file', file: null, fileName: String([].concat(f.src || '')[0] || '').split(/[\\/]/).pop(), enabled: !f.disabled } : { key: f.key, kind: 'text', value: f.value ?? '', enabled: !f.disabled })) };
        if (b && b.mode === 'file') body = { type: 'binary', raw: '', form: [], file: { path: null, name: String((b.file && b.file.src) || '').split(/[\\/]/).pop() } };
        endpoints.push({
          name: it.name || `${req.method} ${url}`, folder: path.length ? path : null, method: (req.method || 'GET').toUpperCase(), url,
          path: url.replace(/^\{\{\w+\}\}/, '').replace(/^https?:\/\/[^/]+/, '').split('?')[0] || '/',
          headers: (req.header || []).map((h) => ({ key: h.key, value: h.value ?? '', enabled: !h.disabled })),
          params: query, body, auth: authFromPostman(req.auth) || null, description: desc(req.description || it.description),
          returnsToken: /token|auth|login/i.test(it.name || '') && req.method === 'POST', tokenField: null,
          pre: evCode(it.event, 'prerequest'), tests: evCode(it.event, 'test'),
        });
      }
    };
    walk(json.item, []);
    const base = (vars.find((v) => /^(baseUrl|base_url|url|host)$/i.test(v.key)) || {}).value || '';
    return {
      format: 'Coleção Postman', source: sourceUrl, title: (json.info && json.info.name) || 'Coleção', version: '',
      description: desc(json.info && json.info.description), baseUrl: base.replace(/\/+$/, ''), endpoints,
      collectionAuth: authFromPostman(json.auth), authKinds: json.auth ? [json.auth.type] : [],
      // Variáveis da coleção continuam sendo da coleção (como no Postman); o ambiente só ganha o que faltar.
      collectionVariables: vars, extraVars: [], folderMeta,
      collectionScripts: { pre: evCode(json.event, 'prerequest'), tests: evCode(json.event, 'test') },
    };
  }

  // ---------- Mono → Postman v2.1 ----------
  function authToPostman(a) {
    if (!a || a.type === 'inherit') return undefined;
    const kv = (o) => Object.entries(o).map(([key, value]) => ({ key, value, type: 'string' }));
    if (a.type === 'none') return { type: 'noauth' };
    if (a.type === 'bearer') return { type: 'bearer', bearer: kv({ token: a.token || '' }) };
    if (a.type === 'basic') return { type: 'basic', basic: kv({ username: a.username || '', password: a.password || '' }) };
    if (a.type === 'apikey') return { type: 'apikey', apikey: kv({ key: a.key || '', value: a.value || '', in: a.in || 'header' }) };
    if (a.type === 'oauth2') { const o = a.oauth2 || {}; return { type: 'oauth2', oauth2: kv({ grant_type: o.grant === 'password' ? 'password_credentials' : 'client_credentials', accessTokenUrl: o.tokenUrl || '', clientId: o.clientId || '', clientSecret: o.clientSecret || '', scope: o.scope || '', client_authentication: o.clientAuth === 'header' ? 'header' : 'body' }) }; }
    return undefined;
  }
  function requestToPostman(r) {
    const raw = r.url || '';
    const body = !r.body || r.body.type === 'none' ? undefined
      : r.body.type === 'multipart' ? { mode: 'formdata', formdata: (r.body.multipart || []).filter((f) => f.key).map((f) => (f.kind === 'file' ? { key: f.key, type: 'file', src: f.file || f.fileName || '' } : { key: f.key, value: f.value, type: 'text' })).map((f, i) => ((r.body.multipart || []).filter((x) => x.key)[i].enabled === false ? { ...f, disabled: true } : f)) }
      : r.body.type === 'binary' ? { mode: 'file', file: { src: (r.body.file && (r.body.file.path || r.body.file.name)) || '' } }
      : r.body.type === 'form' ? { mode: 'urlencoded', urlencoded: (r.body.form || []).filter((f) => f.key).map((f) => ({ key: f.key, value: f.value, disabled: f.enabled === false || undefined })) }
      : { mode: 'raw', raw: r.body.raw || '', options: { raw: { language: r.body.type === 'json' ? 'json' : r.body.type === 'xml' ? 'xml' : 'text' } } };
    const item = {
      name: r.name,
      request: {
        method: r.method, header: (r.headers || []).filter((h) => h.key).map((h) => ({ key: h.key, value: h.value, disabled: h.enabled === false || undefined })),
        url: { raw, query: (r.params || []).filter((p) => p.key).map((p) => ({ key: p.key, value: p.value, disabled: p.enabled === false || undefined })) },
        ...(body ? { body } : {}), ...(authToPostman(r.auth) ? { auth: authToPostman(r.auth) } : {}),
        ...(r.description ? { description: r.description } : {}),
      },
    };
    Object.assign(item, toEvents(r));
    return item;
  }
  function toPostman(col, vars = []) {
    const build = (pid) => [
      ...(col.folders || []).filter((f) => (f.parentId || null) === pid).map((f) => ({ name: f.name, item: build(f.id), ...(authToPostman(f.auth) ? { auth: authToPostman(f.auth) } : {}), ...toEvents(f) })),
      ...col.requests.filter((r) => (r.folderId || null) === pid).map(requestToPostman),
    ];
    return {
      info: { _postman_id: col.id, name: col.name, schema: SCHEMA, ...(col.overview && col.overview.purpose ? { description: col.overview.purpose } : {}) },
      item: build(null),
      ...(authToPostman(col.auth) && col.auth.type !== 'none' ? { auth: authToPostman(col.auth) } : {}),
      ...toEvents(col),
      variable: [...(col.variables || []), ...vars.filter((v) => !(col.variables || []).some((c) => c.key === v.key))]
        .filter((v) => v.key).map((v) => ({ key: v.key, value: v.secret ? '' : v.value })),
    };
  }

  // ---------- Formato nativo ----------
  function exportMono(col, vars = []) {
    return { format: 'mono-collection', version: 1, exportedAt: new Date().toISOString(), collection: col, variables: vars.map((v) => ({ key: v.key, value: v.secret ? '' : v.value, secret: !!v.secret })) };
  }
  // Gera ids novos para não colidir com coleções existentes.
  function importMono(obj, uid) {
    const col = JSON.parse(JSON.stringify(obj.collection));
    const fmap = new Map();
    col.id = uid('col');
    col.folders = (col.folders || []).map((f) => { const id = uid('fld'); fmap.set(f.id, id); return { ...f, id }; });
    col.folders.forEach((f) => { f.parentId = f.parentId ? fmap.get(f.parentId) || null : null; });
    col.requests = (col.requests || []).map((r) => ({ ...r, id: uid('req'), folderId: r.folderId ? fmap.get(r.folderId) || null : null, ...(r.contract ? { contract: { ...r.contract, colId: col.id } } : {}) }));
    return { collection: col, vars: obj.variables || [] };
  }

  // ---------- Links do postman.com ----------
  // Ex.: https://www.postman.com/<time>/workspace/<slug>/collection/<owner>-<uuid>
  //      https://documenter.getpostman.com/view/<owner>/<publishId>
  const UID = /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function parsePostmanUrl(raw) {
    let u;
    try { u = new URL(String(raw).trim()); } catch { return null; }
    const host = u.hostname.toLowerCase();
    const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (/(^|\.)documenter\.getpostman\.com$/.test(host) && parts[0] === 'view' && parts[1] && parts[2]) {
      return { kind: 'documenter', owner: parts[1], publishId: parts[2], api: `https://documenter.gw.postman.com/api/collections/${parts[1]}/${parts[2]}?segregateAuth=true&versionTag=latest` };
    }
    if (!/(^|\.)(postman\.com|postman\.co|getpostman\.com)$/.test(host)) return null;
    if (parts[0] === 'collections' && parts[1]) return { kind: 'collection', collectionUid: parts[1] };
    const wi = parts.indexOf('workspace');
    if (wi < 0) return { kind: 'unknown' };
    const team = wi > 0 ? parts[wi - 1] : null;
    const slug = parts[wi + 1] || null;
    const elementType = parts[wi + 2] || null;
    const rawId = parts[wi + 3] || '';
    const id = rawId.replace(/\?.*$/, '');
    const out = { kind: 'workspace', team, slug, elementType, elementUid: UID.test(id) ? id : null };
    if (elementType === 'collection' && out.elementUid) out.collectionUid = out.elementUid;
    return out;
  }
  // A API do Postman devolve { collection: {...} }; o documenter devolve a coleção direto.
  const unwrapCollection = (j) => (j && j.collection && j.collection.item ? j.collection : j);
  // Procura uids de coleção em qualquer formato de resposta.
  function findCollectionRefs(j) {
    const out = new Map();
    const walk = (v, key, depth) => {
      if (depth > 6 || v == null) return;
      if (typeof v === 'string') { if (UID.test(v) && /collection/i.test(key || '')) out.set(v, out.get(v) || ''); return; }
      if (Array.isArray(v)) { v.forEach((x) => walk(x, key, depth + 1)); return; }
      if (typeof v === 'object') {
        const uid = [v.uid, v.id].find((x) => typeof x === 'string' && UID.test(x));
        if (uid && /collection/i.test(key || '')) out.set(uid, v.name || out.get(uid) || '');
        for (const [k, x] of Object.entries(v)) walk(x, /collection/i.test(k) ? k : key, depth + 1);
      }
    };
    walk(j, '', 0);
    return [...out].map(([uid, name]) => ({ uid, name }));
  }
  function findWorkspaceId(j, slug) {
    let found = null;
    const walk = (v, depth) => {
      if (found || depth > 6 || !v || typeof v !== 'object') return;
      if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
      if (typeof v.id === 'string' && /^[0-9a-f-]{36}$/i.test(v.id) && (!slug || v.slug === slug || v.handle === slug || /workspace/i.test(v.type || 'workspace'))) { found = v.id; return; }
      Object.values(v).forEach((x) => walk(x, depth + 1));
    };
    walk(j, 0);
    return found;
  }

  return { fromPostman, toPostman, exportMono, importMono, parsePostmanUrl, unwrapCollection, findCollectionRefs, findWorkspaceId };
});
