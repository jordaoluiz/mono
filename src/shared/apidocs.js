// Entende documentação de API e transforma num modelo único → coleção do Mono.
// Formatos: OpenAPI 3 / Swagger 2 (JSON ou YAML), apiDoc (api_data.json/js), coleção Postman v2.x,
// e páginas HTML de Swagger UI / Redoc / apiDoc (descobre o arquivo de dados por trás).
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const deps = isNode
    ? { OpenApi: require('./openapi'), Yaml: require('./yaml') }
    : { OpenApi: root.MonoOpenApi, Yaml: root.MonoYaml };
  const m = factory(deps);
  if (isNode) module.exports = m; else root.MonoDocs = m;
})(typeof self !== 'undefined' ? self : this, function (deps) {
  'use strict';
  const { OpenApi, Yaml } = deps;

  const ENT = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
  const decode = (s) => String(s ?? '').replace(/&(lt|gt|amp|quot|#39|nbsp);/g, (m) => ENT[m]);
  function stripHtml(s) {
    return decode(String(s ?? '').replace(/<a\b[^>]*>(.*?)<\/a>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, ''))
      .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  }
  const humanize = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  const trimSlash = (u) => String(u || '').replace(/\/+$/, '');

  // ---------- Detecção de formato ----------
  function parseText(text, contentType = '') {
    const t = String(text || '').trim();
    const ct = String(contentType).toLowerCase();
    if (/^define\(\s*\{/.test(t)) {
      const inner = t.replace(/^define\(\s*/, '').replace(/\)\s*;?\s*$/, '');
      try { return { kind: 'json', value: JSON.parse(inner) }; } catch { /* segue */ }
    }
    if (t.startsWith('{') || t.startsWith('[')) { try { return { kind: 'json', value: JSON.parse(t) }; } catch { /* segue */ } }
    if (/^(openapi|swagger)\s*:/m.test(t) && !/<html/i.test(t.slice(0, 500))) {
      return { kind: 'json', value: Yaml.parse(t), yaml: true };
    }
    if (/html/.test(ct) || /^<!doctype html|^<html|<head|<body/i.test(t.slice(0, 2000))) return { kind: 'html', value: t };
    return { kind: 'text', value: t };
  }
  function detectFormat(v) {
    if (!v || typeof v !== 'object') return null;
    if (v.openapi || v.swagger) return 'openapi';
    if (v.format === 'mono-collection' && v.collection) return 'mono';
    if (v.info && Array.isArray(v.item) && /collection/i.test(v.info.schema || '')) return 'postman';
    if (v.info && Array.isArray(v.item)) return 'postman';
    if (v.collection && v.collection.info && Array.isArray(v.collection.item)) return 'postman';
    const api = Array.isArray(v) ? v : Array.isArray(v.api) ? v.api : null;
    if (api && api.length && api.every((x) => x && typeof x.type === 'string' && typeof x.url === 'string')) return 'apidoc';
    if (v.generator && /apidoc/i.test(v.generator.name || '')) return 'apidoc-project';
    return null;
  }

  // ---------- Descoberta a partir de HTML ----------
  function resolveUrl(u, base) { try { return new URL(decode(u), base).toString(); } catch { return null; } }
  function candidatesFromHtml(html, pageUrl) {
    const out = [];
    const add = (u, why) => { const r = resolveUrl(u, pageUrl); if (r && !out.some((c) => c.url === r)) out.push({ url: r, why }); };
    let m;
    const reSpecUrl = /(?:spec-url|data-url|specUrl|openapi-url)\s*=\s*["']([^"']+)["']/gi;
    while ((m = reSpecUrl.exec(html))) add(m[1], 'redoc');
    const reCfg = /\burl\s*:\s*["']([^"']+\.(?:json|ya?ml)(?:\?[^"']*)?)["']/gi;
    while ((m = reCfg.exec(html))) add(m[1], 'swagger-ui');
    const reUrls = /\{\s*url\s*:\s*["']([^"']+)["']\s*,\s*name\s*:/gi;
    while ((m = reUrls.exec(html))) add(m[1], 'swagger-ui');
    const reLink = /(?:href|src)\s*=\s*["']([^"']*(?:swagger|openapi|api-docs|apispec)[^"']*\.(?:json|ya?ml))["']/gi;
    while ((m = reLink.exec(html))) add(m[1], 'link');
    const reInit = /<script[^>]+src\s*=\s*["']([^"']*(?:swagger-initializer|swagger-config|initializer)[^"']*)["']/gi;
    while ((m = reInit.exec(html))) add(m[1], 'script');
    if (/apidoc|api_data|api_project/i.test(html) || /main\.bundle\.js/.test(html)) {
      add('api_data.json', 'apidoc'); add('api_data.js', 'apidoc');
    }
    return out;
  }
  function wellKnown(pageUrl) {
    let u;
    try { u = new URL(pageUrl); } catch { return []; }
    const dir = u.pathname.endsWith('/') ? u.pathname : u.pathname.replace(/[^/]*$/, '');
    const paths = [
      dir + 'swagger.json', dir + 'openapi.json', dir + 'api_data.json',
      '/swagger/v1/swagger.json', '/openapi.json', '/swagger.json', '/v3/api-docs', '/v2/api-docs',
      '/api-docs', '/api/swagger.json', '/api/openapi.json', '/swagger/doc.json', '/openapi.yaml', '/swagger.yaml',
    ];
    return [...new Set(paths)].map((p) => ({ url: u.origin + p, why: 'caminho comum' }));
  }
  function apidocProjectUrl(dataUrl) {
    return dataUrl.replace(/api_data\.js(on)?(\?.*)?$/, 'api_project.json');
  }

  // ---------- curl (exemplos do apiDoc) ----------
  function parseCurl(cmd) {
    const src = String(cmd).replace(/\\\r?\n/g, ' ').replace(/\\\\\n/g, ' ');
    const tokens = [];
    const re = /'((?:[^'\\]|\\.|'\\'')*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g;
    let m;
    while ((m = re.exec(src))) tokens.push(m[1] != null ? m[1].replace(/'\\''/g, "'") : m[2] != null ? m[2].replace(/\\"/g, '"') : m[3]);
    if (!/^curl$/i.test(tokens[0] || '')) return null;
    const out = { method: null, url: '', headers: [], data: null, user: null };
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === '-X' || t === '--request') out.method = (tokens[++i] || '').toUpperCase();
      else if (t === '-H' || t === '--header') { const v = tokens[++i] || ''; const j = v.indexOf(':'); if (j > 0) out.headers.push({ key: v.slice(0, j).trim(), value: v.slice(j + 1).trim() }); }
      else if (/^(-d|--data|--data-raw|--data-binary|--data-urlencode)$/.test(t)) out.data = (out.data ? out.data + '&' : '') + (tokens[++i] || '');
      else if (t === '-u' || t === '--user') out.user = tokens[++i];
      else if (/^https?:\/\//i.test(t)) out.url = t;
    }
    out.method ||= out.data ? 'POST' : 'GET';
    return out;
  }
  function bodyFromCurl(c) {
    if (!c || c.data == null) return null;
    const ct = (c.headers.find((h) => /^content-type$/i.test(h.key)) || {}).value || '';
    const d = c.data.trim();
    if (/json/i.test(ct) || /^[[{]/.test(d)) {
      try { return { type: 'json', raw: JSON.stringify(JSON.parse(d), null, 2), form: [] }; } catch { return { type: 'json', raw: d, form: [] }; }
    }
    if (/x-www-form-urlencoded/i.test(ct) || /^[\w.%-]+=/.test(d)) {
      return { type: 'form', raw: '', form: d.split('&').map((p) => { const [k, ...v] = p.split('='); return { key: decodeURIComponent(k), value: decodeURIComponent(v.join('=')), enabled: true }; }) };
    }
    return { type: 'text', raw: d, form: [] };
  }

  // ---------- apiDoc ----------
  const SAMPLE = { string: '', number: 0, integer: 0, boolean: false, date: '2026-01-01', object: {}, array: [] };
  function sampleFor(type, def) {
    if (def != null && def !== '') { const t = String(type || '').toLowerCase(); if (t === 'number' && !isNaN(def)) return Number(def); if (t === 'boolean') return def === 'true'; return decode(def); }
    const t = String(type || 'string').toLowerCase().replace(/\[\]$/, '');
    if (/\[\]$/.test(type || '')) return [];
    return SAMPLE[t] ?? '';
  }
  function setPath(obj, path, val) {
    const parts = path.split('.');
    let cur = obj;
    parts.forEach((p, i) => { if (i === parts.length - 1) cur[p] = val; else { if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {}; cur = cur[p]; } });
  }
  function parseHttpExample(content) {
    const m = String(content || '').match(/^HTTP\/[\d.]+\s+(\d{3})[^\n]*\n?([\s\S]*)$/);
    if (!m) return null;
    return { status: Number(m[1]), body: m[2].trim() };
  }
  function fromApiDoc(data, project = {}, sourceUrl = '') {
    const items = Array.isArray(data) ? data : data.api || [];
    let base = trimSlash(project.url || project.sampleUrl || '');
    if (!base) {
      const fromCurl = items.map((it) => (it.examples || []).map((e) => parseCurl(e.content)).find((c) => c && c.url)).find(Boolean);
      if (fromCurl) { try { base = new URL(fromCurl.url).origin; } catch { /* ignora */ } }
    }
    if (!base && sourceUrl) { try { base = new URL(sourceUrl).origin; } catch { /* ignora */ } }
    // Mantém só a versão mais recente de cada endpoint (apiDoc lista versões antigas também).
    const latest = new Map();
    for (const it of items) {
      const k = `${it.group}|${it.name}`;
      if (!latest.has(k) || String(it.version) > String(latest.get(k).version)) latest.set(k, it);
    }
    const order = project.order || [];
    const endpoints = [];
    const kinds = new Set();
    for (const it of latest.values()) {
      const method = String(it.type || 'get').toUpperCase();
      const curls = (it.examples || []).map((e) => ({ title: e.title || '', c: parseCurl(e.content) })).filter((x) => x.c);
      const best = curls.find((x) => /json/i.test(x.title)) || curls.find((x) => x.c.data != null) || curls[0];
      let path = /^https?:\/\//i.test(it.url) ? new URL(it.url).pathname : '/' + String(it.url).replace(/^\/+/, '');
      if (best && best.c.url && base && best.c.url.startsWith(base)) path = best.c.url.slice(base.length) || '/';
      path = path.replace(/:(\w+)/g, '{{$1}}');
      const pf = (it.parameter && it.parameter.fields) || {};
      const urlParams = Object.entries(pf).filter(([g]) => /url|path/i.test(g)).flatMap(([, f]) => f);
      const queryParams = Object.entries(pf).filter(([g]) => /query/i.test(g)).flatMap(([, f]) => f);
      const bodyFields = Object.entries(pf).filter(([g]) => !/url|path|query/i.test(g)).flatMap(([, f]) => f);
      for (const p of urlParams) { const def = p.defaultValue; if (def) path = path.replace(`{{${p.field}}}`, def); }
      const hdrFields = Object.values((it.header && it.header.fields) || {}).flat();
      const headers = [];
      let authHint = null;
      for (const hf of hdrFields) {
        const key = hf.field, def = decode(hf.defaultValue || '');
        if (/^cookie$/i.test(key) && /token/i.test(def)) { authHint = { kind: 'cookie-token', header: 'Cookie', template: def.replace(/<[^>]+>|token_value/gi, '').replace(/=\s*$/, '=') }; kinds.add('cookie-token'); continue; }
        if (/^authorization$/i.test(key)) { kinds.add(/basic/i.test(def) ? 'basic' : 'bearer'); if (!authHint) authHint = { kind: /basic/i.test(def) ? 'basic' : 'bearer' }; continue; }
        headers.push({ key, value: def || (/accept|content-type/i.test(key) ? 'application/json' : ''), enabled: !hf.optional });
      }
      if (best) for (const h of best.c.headers) if (!/^(cookie|authorization)$/i.test(h.key) && !headers.some((x) => x.key.toLowerCase() === h.key.toLowerCase())) headers.push({ key: h.key, value: h.value, enabled: true });
      let body = bodyFromCurl(best && best.c);
      if (!body && bodyFields.length && !['GET', 'HEAD', 'DELETE'].includes(method)) {
        const obj = {};
        for (const f of bodyFields) setPath(obj, f.field, sampleFor(f.type, f.defaultValue));
        body = { type: 'json', raw: JSON.stringify(obj, null, 2), form: [] };
      }
      const successFields = Object.values((it.success && it.success.fields) || {}).flat().map((f) => f.field);
      const responses = ((it.success && it.success.examples) || []).map((e) => parseHttpExample(e.content)).filter(Boolean);
      const errors = ((it.error && it.error.examples) || []).map((e) => parseHttpExample(e.content)).filter(Boolean);
      endpoints.push({
        name: humanize(it.title || it.name),
        group: it.groupTitle || it.group || 'Geral',
        method, url: '{{baseUrl}}' + path, path,
        description: stripHtml(it.description),
        headers, params: queryParams.map((q) => ({ key: q.field, value: q.defaultValue || '', enabled: !q.optional })),
        body: body || { type: 'none', raw: '', form: [] },
        authHint, returnsToken: successFields.includes('token') || /token/i.test(it.name || ''),
        tokenField: successFields.includes('token') ? 'token' : null,
        responses: [...responses, ...errors],
        sortKey: order.indexOf(it.name) === -1 ? 999 : order.indexOf(it.name),
      });
    }
    endpoints.sort((a, b) => a.group.localeCompare(b.group) || a.sortKey - b.sortKey || a.path.localeCompare(b.path));
    return {
      format: 'apiDoc', source: sourceUrl,
      title: project.title || project.name || 'API', version: project.version || '',
      description: stripHtml(project.description || ''),
      baseUrl: base, endpoints, authKinds: [...kinds],
    };
  }

  // ---------- OpenAPI ----------
  function fromOpenApi(spec, sourceUrl = '', yaml = false) {
    const parsed = OpenApi.parseSpec(spec, sourceUrl);
    const v2 = !!spec.swagger;
    const schemes = (v2 ? spec.securityDefinitions : spec.components && spec.components.securitySchemes) || {};
    const kinds = [];
    let collectionAuth = null;
    const globalSec = (spec.security || [])[0];
    const pickScheme = (name) => {
      const s = schemes[name];
      if (!s) return null;
      if ((s.type === 'http' && /bearer/i.test(s.scheme)) || (v2 && s.type === 'apiKey' && /authorization/i.test(s.name) && s.in === 'header')) return { type: 'bearer', token: '{{token}}' };
      if ((s.type === 'http' && /basic/i.test(s.scheme)) || s.type === 'basic') return { type: 'basic', username: '{{usuario}}', password: '{{senha}}' };
      if (s.type === 'apiKey') return { type: 'apikey', key: s.name, value: '{{apiKey}}', in: s.in === 'query' ? 'query' : 'header' };
      if (s.type === 'oauth2') {
        const f = s.flows ? (s.flows.clientCredentials || s.flows.password || s.flows.authorizationCode || {}) : s;
        return { type: 'oauth2', oauth2: { grant: s.flows && s.flows.password && !s.flows.clientCredentials ? 'password' : 'client_credentials', tokenUrl: f.tokenUrl || '', clientId: '{{clientId}}', clientSecret: '{{clientSecret}}', scope: Object.keys(f.scopes || {}).join(' '), clientAuth: 'body' } };
      }
      return null;
    };
    for (const s of Object.values(schemes)) kinds.push(s.type === 'http' ? s.scheme : s.type === 'apiKey' ? `apiKey:${s.in}` : s.type);
    if (globalSec) collectionAuth = pickScheme(Object.keys(globalSec)[0]);
    if (!collectionAuth && Object.keys(schemes).length === 1) collectionAuth = pickScheme(Object.keys(schemes)[0]);
    const endpoints = parsed.requests.map((r) => {
      const op = spec.paths[r.contract.path][r.contract.method] || {};
      const sec = op.security;
      const isPublic = Array.isArray(sec) && sec.length === 0;
      const resp = op.responses && (op.responses['200'] || op.responses['201']);
      const hasToken = JSON.stringify(resp || {}).match(/"(access_token|token|accessToken|jwt)"/);
      return {
        name: r.name, group: r.tag || 'Geral', method: r.method, url: r.url, path: r.contract.path,
        description: stripHtml(op.description || ''), headers: r.headers, params: r.params, body: r.body,
        auth: isPublic ? { type: 'none' } : null, contract: r.contract, deprecated: r.deprecated,
        returnsToken: !!hasToken && /auth|login|token|session|signin/i.test(r.contract.path + ' ' + r.name), tokenField: hasToken ? hasToken[1] : null,
        responses: Object.keys(op.responses || {}).map((s) => ({ status: Number(s) || s, body: '' })),
      };
    });
    return {
      format: v2 ? 'Swagger 2.0' : `OpenAPI ${spec.openapi}${yaml ? ' (YAML)' : ''}`, source: sourceUrl,
      title: parsed.title, version: parsed.version, description: stripHtml(spec.info && spec.info.description),
      baseUrl: parsed.baseUrl, endpoints, authKinds: kinds, collectionAuth, spec,
    };
  }

  // ---------- Modelo → coleção ----------
  // uid: gerador de ids; retorna { collection, vars }
  function buildCollection(model, uid) {
    const colId = uid('col');
    const col = { id: colId, name: `${model.title}${model.version ? ' ' + model.version : ''}`, open: true, requests: [], folders: [],
      auth: model.collectionAuth || { type: 'none' }, source: { format: model.format, url: model.source, importedAt: Date.now() } };
    if (model.spec) { col.spec = model.spec; col.specSource = model.source || ''; }
    const folderByName = new Map();
    const folderFor = (path) => {
      if (!path) return null;
      const parts = Array.isArray(path) ? path : [path];
      let parent = null, key = '';
      for (const p of parts) {
        key += '/' + p;
        if (!folderByName.has(key)) { const f = { id: uid('fld'), name: p, parentId: parent, open: false, auth: { type: 'inherit' } }; col.folders.push(f); folderByName.set(key, f.id); }
        parent = folderByName.get(key);
      }
      return parent;
    };
    const needsTokenVar = model.endpoints.some((e) => e.authHint && e.authHint.kind === 'cookie-token');
    for (const e of model.endpoints) {
      let auth = e.auth || { type: 'inherit' };
      if (!e.auth && e.authHint && e.authHint.kind === 'cookie-token') auth = { type: 'apikey', key: 'Cookie', value: 'token={{token}}', in: 'header' };
      const tests = e.tests ? e.tests : e.returnsToken && e.tokenField
        ? `// Gerado na importação: guarda o token no ambiente ativo para as próximas requisições.\nconst body = pm.response.json();\npm.test('recebeu ${e.tokenField}', () => pm.expect(body.${e.tokenField}).to.exist);\npm.environment.set('token', body.${e.tokenField});\n`
        : '';
      col.requests.push({
        id: uid('req'), name: e.deprecated ? `${e.name} (obsoleto)` : e.name, method: e.method, url: e.url,
        params: e.params || [], headers: e.headers || [], body: e.body || { type: 'none', raw: '', form: [] },
        auth, pre: e.pre || '', tests, folderId: folderFor(e.folder || e.group), description: e.description || '',
        ...(e.contract ? { contract: { ...e.contract, colId } } : {}),
        ...(e.soap ? { soap: e.soap } : {}),
      });
    }
    for (const fm of model.folderMeta || []) {
      const f = col.folders.find((x) => x.id === folderFor(fm.path));
      if (!f) continue;
      if (fm.pre) f.pre = fm.pre;
      if (fm.tests) f.tests = fm.tests;
      if (fm.auth) f.auth = fm.auth;
      if (fm.description) f.description = fm.description;
    }
    if (model.collectionScripts) { col.pre = model.collectionScripts.pre || ''; col.tests = model.collectionScripts.tests || ''; }
    const colVars = (model.collectionVariables || []).filter((v) => v.key);
    if (colVars.length) col.variables = colVars.map((v) => ({ key: v.key, value: v.value, enabled: true }));
    const inCol = (k) => colVars.some((v) => v.key === k);
    const vars = [];
    if (model.baseUrl && !inCol('baseUrl')) vars.push({ key: 'baseUrl', value: model.baseUrl });
    if (needsTokenVar || model.endpoints.some((e) => e.returnsToken)) vars.push({ key: 'token', value: '', secret: true });
    for (const v of model.extraVars || []) if (v.key && !vars.some((x) => x.key === v.key)) vars.push({ key: v.key, value: v.value });
    for (const m of JSON.stringify(model.endpoints.map((e) => e.url)).matchAll(/\{\{(\w+)\}\}/g)) if (m[1] !== 'baseUrl' && !inCol(m[1]) && !vars.some((v) => v.key === m[1])) vars.push({ key: m[1], value: '' });
    return { collection: col, vars };
  }

  return { parseText, detectFormat, candidatesFromHtml, wellKnown, apidocProjectUrl, parseCurl, bodyFromCurl, fromApiDoc, fromOpenApi, buildCollection, stripHtml, humanize };
});
