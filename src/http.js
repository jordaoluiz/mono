// Executa requisições HTTP no processo principal (sem CORS, sem limites do navegador).
'use strict';

const { dynamicVar } = require('./shared/sandbox');

const VAR_RE = /\{\{\s*(\$?[\w.-]+)\s*\}\}/g;

// {{nome}} vem das variáveis; {{$guid}}, {{$timestamp}}, {{$randomInt}}… são geradas a cada uso, como no Postman.
function interpolate(value, vars) {
  if (typeof value !== 'string') return value;
  return value.replace(VAR_RE, (m, name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return String(vars[name]);
    if (name[0] === '$') { const d = dynamicVar(name); if (d !== undefined) return d; }
    return m;
  });
}

function enabledPairs(list) {
  return (list || []).filter((p) => p && p.enabled !== false && String(p.key || '').trim() !== '');
}

const MIME = { json: 'application/json', xml: 'application/xml', txt: 'text/plain', csv: 'text/csv', html: 'text/html', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', zip: 'application/zip', gz: 'application/gzip', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', mp4: 'video/mp4', mp3: 'audio/mpeg' };
const mimeOf = (name) => MIME[String(name || '').split('.').pop().toLowerCase()] || 'application/octet-stream';
const baseName = (p) => String(p || '').split(/[\\/]/).pop();
// SOAP 1.2 pede application/soap+xml; SOAP 1.1 e XML comum usam text/xml.
const xmlContentType = (raw) => (/http:\/\/www\.w3\.org\/2003\/05\/soap-envelope/.test(raw) ? 'application/soap+xml; charset=utf-8' : 'text/xml; charset=utf-8');

// opts.readFile(path) → Buffer: lê arquivos de form-data/binário (o processo principal só libera arquivos escolhidos pelo usuário).
function buildRequest(req, vars = {}, opts = {}) {
  const v = (s) => interpolate(s, vars);
  let rawUrl = v((req.url || '').trim());
  if (!rawUrl) throw new Error('Informe uma URL.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl)) rawUrl = 'http://' + rawUrl;

  const url = new URL(rawUrl);
  // Os params da tabela são a fonte da verdade da query string.
  if (Array.isArray(req.params)) {
    url.search = '';
    for (const p of enabledPairs(req.params)) url.searchParams.append(v(p.key), v(p.value ?? ''));
  }

  const headers = {};
  for (const h of enabledPairs(req.headers)) headers[v(h.key)] = v(h.value ?? '');

  // Autorização já resolvida pela interface (herança de pasta/coleção acontece antes de chegar aqui).
  const auth = req.auth || { type: 'none' };
  const hasAuthHeader = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
  if (!hasAuthHeader) {
    if (auth.type === 'bearer' && auth.token) headers['Authorization'] = 'Bearer ' + v(auth.token);
    if (auth.type === 'basic') headers['Authorization'] = 'Basic ' + Buffer.from(`${v(auth.username || '')}:${v(auth.password || '')}`).toString('base64');
    if (auth.type === 'oauth2' && auth.oauth2 && auth.oauth2.accessToken) headers['Authorization'] = `${auth.oauth2.tokenType || 'Bearer'} ${auth.oauth2.accessToken}`;
  }
  if (auth.type === 'apikey' && auth.key) {
    if (auth.in === 'query') url.searchParams.append(v(auth.key), v(auth.value ?? ''));
    else headers[v(auth.key)] = v(auth.value ?? '');
  }

  const method = (req.method || 'GET').toUpperCase();
  let body, bodyDesc = null;
  const b = req.body || { type: 'none' };
  const hasHeader = (name) => Object.keys(headers).some((k) => k.toLowerCase() === name);
  if (!['GET', 'HEAD'].includes(method)) {
    if (b.type === 'json' && b.raw) {
      body = v(b.raw);
      if (!hasHeader('content-type')) headers['Content-Type'] = 'application/json';
    } else if (b.type === 'text' && b.raw) {
      body = v(b.raw);
      if (!hasHeader('content-type')) headers['Content-Type'] = 'text/plain';
    } else if (b.type === 'xml' && b.raw) {
      body = v(b.raw);
      if (!hasHeader('content-type')) headers['Content-Type'] = xmlContentType(body);
    } else if (b.type === 'form') {
      const form = new URLSearchParams();
      for (const p of enabledPairs(b.form)) form.append(v(p.key), v(p.value ?? ''));
      body = form.toString();
      if (!hasHeader('content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (b.type === 'multipart') {
      const parts = enabledPairs(b.multipart).map((p) => (p.kind === 'file'
        ? { name: v(p.key), file: p.file || null, fileName: p.fileName || baseName(p.file) }
        : { name: v(p.key), value: v(p.value ?? '') }));
      bodyDesc = { kind: 'multipart', parts };
      if (opts.readFile) {
        const boundary = '----MonoBoundary' + require('crypto').randomBytes(12).toString('hex');
        const chunks = [];
        const q = (s) => String(s).replace(/"/g, '%22').replace(/\r|\n/g, ' ');
        for (const part of parts) {
          if (part.file !== undefined) {
            if (!part.file) throw new Error(`Escolha o arquivo do campo "${part.name}" no Body.`);
            chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${q(part.name)}"; filename="${q(part.fileName)}"\r\nContent-Type: ${mimeOf(part.fileName)}\r\n\r\n`), opts.readFile(part.file), Buffer.from('\r\n'));
          } else chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${q(part.name)}"\r\n\r\n${part.value}\r\n`));
        }
        chunks.push(Buffer.from(`--${boundary}--\r\n`));
        body = Buffer.concat(chunks);
        headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
      }
    } else if (b.type === 'binary') {
      if (!b.file || !b.file.path) throw new Error('Escolha o arquivo do corpo binário no Body.');
      bodyDesc = { kind: 'binary', file: b.file.path, fileName: b.file.name || baseName(b.file.path) };
      if (opts.readFile) body = opts.readFile(b.file.path);
      if (!hasHeader('content-type')) headers['Content-Type'] = mimeOf(bodyDesc.fileName);
    }
  }
  return { method, url: url.toString(), headers, body, bodyDesc };
}

// Transporte padrão (Node fetch) — usado nos testes. No app, o processo principal injeta um
// transporte do Chromium (net.request) que respeita proxy, certificados e autenticação de proxy.
async function fetchTransport(built, { signal, followRedirects }) {
  const res = await fetch(built.url, { method: built.method, headers: built.headers, body: built.body, redirect: followRedirects ? 'follow' : 'manual', signal });
  const headers = [];
  res.headers.forEach((value, key) => headers.push({ key, value }));
  return { status: res.status, statusText: res.statusText, headers, url: res.url || built.url, buffer: Buffer.from(await res.arrayBuffer()) };
}

async function send(req, vars = {}, { timeoutMs = 30000, transport = fetchTransport, followRedirects = true, readFile } = {}) {
  let built;
  try {
    built = buildRequest(req, vars, { readFile });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = performance.now();
  try {
    const res = await transport(built, { signal: ctrl.signal, followRedirects, timeoutMs });
    const buf = res.buffer;
    const time = Math.round(performance.now() - started);
    const headers = res.headers;
    const contentType = (headers.find((x) => x.key.toLowerCase() === 'content-type') || {}).value || '';
    const isText = /json|text|xml|javascript|html|csv|yaml|x-www-form-urlencoded/i.test(contentType) || buf.length === 0;
    const shown = { ...built, body: Buffer.isBuffer(built.body) ? `(${built.body.length} bytes)` : built.body };
    return {
      ok: true,
      request: shown,
      url: res.url || built.url,
      status: res.status,
      statusText: res.statusText,
      time,
      size: buf.length,
      headers,
      contentType,
      body: isText ? buf.toString('utf8') : null,
      bodyBase64: isText ? null : buf.toString('base64'),
    };
  } catch (e) {
    const aborted = e.name === 'AbortError' || ctrl.signal.aborted;
    const msg = aborted ? `Tempo esgotado (${Math.round(timeoutMs / 1000)}s).` : (e.cause && e.cause.message) || e.message;
    return { ok: false, error: msg, request: { ...built, body: Buffer.isBuffer(built.body) ? `(${built.body.length} bytes)` : built.body }, time: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

function toCurl(req, vars = {}) {
  const b = buildRequest(req, vars);
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const parts = [`curl -X ${b.method} ${q(b.url)}`];
  for (const [k, val] of Object.entries(b.headers)) parts.push(`  -H ${q(`${k}: ${val}`)}`);
  if (b.bodyDesc && b.bodyDesc.kind === 'multipart') for (const p of b.bodyDesc.parts) parts.push(`  -F ${q(p.file !== undefined ? `${p.name}=@${p.file || 'arquivo'}` : `${p.name}=${p.value}`)}`);
  else if (b.bodyDesc && b.bodyDesc.kind === 'binary') parts.push(`  --data-binary ${q('@' + b.bodyDesc.file)}`);
  else if (b.body) parts.push(`  --data-raw ${q(b.body)}`);
  return parts.join(' \\\n');
}

module.exports = { interpolate, buildRequest, send, toCurl, fetchTransport, mimeOf, xmlContentType };
