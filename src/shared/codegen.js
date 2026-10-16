// Gera código a partir da requisição: cURL, C# (HttpClient), JavaScript (fetch/axios), Python e Power Automate.
// Entrada: requisição já "achatada" pela interface (variáveis resolvidas ou não, autorização herdada já aplicada).
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.MonoCodegen = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MIME = { json: 'application/json', xml: 'application/xml', txt: 'text/plain', csv: 'text/csv', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', zip: 'application/zip', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  const mimeOf = (n) => MIME[String(n || '').split('.').pop().toLowerCase()] || 'application/octet-stream';
  const baseName = (p) => String(p || '').split(/[\\/]/).pop();
  const b64 = (s) => (typeof Buffer !== 'undefined' ? Buffer.from(s, 'utf8').toString('base64') : btoa(unescape(encodeURIComponent(s))));
  const on = (l) => (l || []).filter((x) => x && x.enabled !== false && String(x.key || '').trim());
  const hasH = (hs, n) => hs.some((x) => x.key.toLowerCase() === n.toLowerCase());
  const getH = (hs, n) => (hs.find((x) => x.key.toLowerCase() === n.toLowerCase()) || {}).value;

  // ---------- Normalização ----------
  // req: { method, url, params, headers, body, auth } · cert: { path, name, passphrase } | null
  function prepare(req, cert) {
    const method = String(req.method || 'GET').toUpperCase();
    let url = String(req.url || '').trim();
    if (Array.isArray(req.params) && req.params.length) {
      const base = url.split('?')[0];
      const q = on(req.params).map((p) => `${encodeURIComponent(p.key).replace(/%7B/g, '{').replace(/%7D/g, '}')}=${encodeURIComponent(p.value ?? '').replace(/%7B/g, '{').replace(/%7D/g, '}')}`).join('&');
      url = base + (q ? '?' + q : '');
    }
    const headers = on(req.headers).map((x) => ({ key: x.key, value: String(x.value ?? '') }));
    const a = req.auth || { type: 'none' };
    let basic = null;
    if (!hasH(headers, 'authorization')) {
      if (a.type === 'bearer' && a.token) headers.push({ key: 'Authorization', value: 'Bearer ' + a.token });
      if (a.type === 'basic') { basic = { username: a.username || '', password: a.password || '' }; headers.push({ key: 'Authorization', value: 'Basic ' + b64(`${basic.username}:${basic.password}`) }); }
      if (a.type === 'oauth2' && a.oauth2 && a.oauth2.accessToken) headers.push({ key: 'Authorization', value: `${a.oauth2.tokenType || 'Bearer'} ${a.oauth2.accessToken}` });
    }
    if (a.type === 'apikey' && a.key) {
      if (a.in === 'query') url += (url.includes('?') ? '&' : '?') + `${encodeURIComponent(a.key)}=${encodeURIComponent(a.value || '')}`;
      else headers.push({ key: a.key, value: a.value || '' });
    }
    let b = req.body || { type: 'none' };
    if (b.type === 'graphql') {
      const g = b.graphql || {};
      let variables; try { variables = String(g.variables || '').trim() ? JSON.parse(g.variables) : undefined; } catch { variables = undefined; }
      b = { type: 'json', raw: JSON.stringify({ query: g.query || '', ...(variables ? { variables } : {}) }, null, 2) };
    }
    let body = { kind: 'none' };
    if (!['GET', 'HEAD'].includes(method)) {
      if ((b.type === 'json' || b.type === 'text' || b.type === 'xml') && b.raw) {
        const ct = getH(headers, 'content-type') || (b.type === 'json' ? 'application/json' : b.type === 'xml' ? (/2003\/05\/soap-envelope/.test(b.raw) ? 'application/soap+xml; charset=utf-8' : 'text/xml; charset=utf-8') : 'text/plain');
        let json; if (b.type === 'json') { try { json = JSON.parse(b.raw); } catch { /* texto */ } }
        body = { kind: 'raw', raw: b.raw, contentType: ct, json };
      } else if (b.type === 'form') body = { kind: 'form', fields: on(b.form).map((f) => ({ key: f.key, value: String(f.value ?? '') })), contentType: 'application/x-www-form-urlencoded' };
      else if (b.type === 'multipart') body = { kind: 'multipart', parts: on(b.multipart).map((p) => (p.kind === 'file' ? { key: p.key, file: p.file || p.fileName || 'arquivo', fileName: p.fileName || baseName(p.file) || 'arquivo' } : { key: p.key, value: String(p.value ?? '') })) };
      else if (b.type === 'binary' && b.file) body = { kind: 'binary', file: b.file.path || b.file.name || 'arquivo', fileName: b.file.name || baseName(b.file.path), contentType: getH(headers, 'content-type') || mimeOf(b.file.name || b.file.path) };
    }
    // Content-Type sai do corpo (exceto multipart, em que o cliente gera o boundary).
    const plainHeaders = headers.filter((x) => x.key.toLowerCase() !== 'content-type');
    return { method, url, headers, plainHeaders, body, basic, cert: cert && cert.path ? cert : null };
  }

  // ---------- utilidades de string ----------
  const jsStr = (s) => JSON.stringify(String(s));
  const shQ = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const csStr = (s) => JSON.stringify(String(s));
  const csVerbatim = (s) => `@"${String(s).replace(/"/g, '""')}"`;
  const pyStr = (s) => JSON.stringify(String(s));
  function csRaw(text, indent) {
    let q = 3;
    const runs = String(text).match(/"+/g) || [];
    for (const r of runs) if (r.length >= q) q = r.length + 1;
    const qs = '"'.repeat(q);
    return `${qs}\n${String(text).split('\n').map((l) => indent + l).join('\n')}\n${indent}${qs}`;
  }
  const indentJson = (v, pad) => JSON.stringify(v, null, 2).split('\n').map((l, i) => (i ? pad + l : l)).join('\n');

  // ---------- cURL ----------
  function curl(r) {
    const p = [`curl -X ${r.method} ${shQ(r.url)}`];
    for (const x of r.body.kind === 'multipart' ? r.plainHeaders : r.headers) p.push(`  -H ${shQ(`${x.key}: ${x.value}`)}`);
    if (r.body.kind === 'raw' && !hasH(r.headers, 'content-type')) p.push(`  -H ${shQ('Content-Type: ' + r.body.contentType)}`);
    if (r.body.kind === 'raw') p.push(`  --data-raw ${shQ(r.body.raw)}`);
    if (r.body.kind === 'form') for (const f of r.body.fields) p.push(`  --data-urlencode ${shQ(`${f.key}=${f.value}`)}`);
    if (r.body.kind === 'multipart') for (const f of r.body.parts) p.push(`  -F ${shQ(f.file !== undefined ? `${f.key}=@${f.file}` : `${f.key}=${f.value}`)}`);
    if (r.body.kind === 'binary') { if (!hasH(r.headers, 'content-type')) p.push(`  -H ${shQ('Content-Type: ' + r.body.contentType)}`); p.push(`  --data-binary ${shQ('@' + r.body.file)}`); }
    if (r.cert) p.push(`  --cert-type P12 --cert ${shQ(`${r.cert.path}:${r.cert.passphrase || ''}`)}`);
    return p.join(' \\\n') + '\n';
  }

  // ---------- C# (HttpClient) ----------
  const CS_METHODS = { GET: 'Get', POST: 'Post', PUT: 'Put', DELETE: 'Delete', PATCH: 'Patch', HEAD: 'Head', OPTIONS: 'Options' };
  function csharp(r, { types = null } = {}) {
    const usings = new Set(['System.Net.Http.Headers', 'System.Text']);
    const L = [];
    if (r.cert) {
      usings.add('System.Security.Cryptography.X509Certificates');
      L.push('// Certificado digital do cliente (mTLS). .NET 9+: X509CertificateLoader; versões anteriores: new X509Certificate2(caminho, senha).');
      L.push('var handler = new HttpClientHandler();');
      L.push(`handler.ClientCertificates.Add(X509CertificateLoader.LoadPkcs12FromFile(${csVerbatim(r.cert.path)}, ${csStr(r.cert.passphrase || '')}));`);
      L.push('using var client = new HttpClient(handler);');
    } else L.push('using var client = new HttpClient();');
    const m = CS_METHODS[r.method] ? `HttpMethod.${CS_METHODS[r.method]}` : `new HttpMethod(${csStr(r.method)})`;
    L.push(`using var request = new HttpRequestMessage(${m}, ${csStr(r.url)});`);
    for (const x of r.plainHeaders) L.push(`request.Headers.TryAddWithoutValidation(${csStr(x.key)}, ${csStr(x.value)});`);
    const b = r.body;
    if (b.kind === 'raw') {
      const media = b.contentType.split(';')[0].trim();
      L.push('request.Content = new StringContent(', `    ${csRaw(b.json !== undefined ? JSON.stringify(b.json, null, 2) : b.raw, '    ')},`, `    Encoding.UTF8, ${csStr(media)});`);
    } else if (b.kind === 'form') {
      L.push('request.Content = new FormUrlEncodedContent(new Dictionary<string, string>', '{');
      for (const f of b.fields) L.push(`    [${csStr(f.key)}] = ${csStr(f.value)},`);
      L.push('});');
    } else if (b.kind === 'multipart') {
      L.push('var form = new MultipartFormDataContent();');
      b.parts.forEach((p, i) => {
        if (p.file !== undefined) {
          L.push(`var file${i} = new ByteArrayContent(File.ReadAllBytes(${csVerbatim(p.file)}));`, `file${i}.Headers.ContentType = new MediaTypeHeaderValue(${csStr(mimeOf(p.fileName))});`, `form.Add(file${i}, ${csStr(p.key)}, ${csStr(p.fileName)});`);
        } else L.push(`form.Add(new StringContent(${csStr(p.value)}), ${csStr(p.key)});`);
      });
      L.push('request.Content = form;');
    } else if (b.kind === 'binary') {
      L.push(`request.Content = new ByteArrayContent(File.ReadAllBytes(${csVerbatim(b.file)}));`, `request.Content.Headers.ContentType = new MediaTypeHeaderValue(${csStr(b.contentType.split(';')[0].trim())});`);
    }
    L.push('', 'using var response = await client.SendAsync(request);');
    let tail = '';
    if (types && types.code) {
      usings.add('System.Text.Json');
      L.push('response.EnsureSuccessStatusCode();', 'var json = await response.Content.ReadAsStringAsync();', `var data = JsonSerializer.Deserialize<${types.root}>(json);`, 'Console.WriteLine(data);');
      const lines = types.code.split('\n');
      for (const l of lines) { const u = l.match(/^using\s+([\w.]+);/); if (u) usings.add(u[1]); }
      tail = '\n' + lines.filter((l) => !/^using\s/.test(l) && !/^\/\/ A resposta é uma lista/.test(l)).join('\n').replace(/^\n+/, '').replace(/\n+$/, '') + '\n';
    } else {
      L.push('Console.WriteLine((int)response.StatusCode);', 'Console.WriteLine(await response.Content.ReadAsStringAsync());');
    }
    return [...[...usings].sort().map((u) => `using ${u};`), '', ...L, tail].join('\n').replace(/\n+$/, '\n');
  }

  // ---------- JavaScript (fetch) ----------
  const jsHeaders = (hs, pad) => (hs.length ? `{\n${hs.map((x) => `${pad}  ${jsStr(x.key)}: ${jsStr(x.value)},`).join('\n')}\n${pad}}` : '{}');
  function fetchJs(r) {
    const L = [];
    const needFs = r.body.kind === 'multipart' && r.body.parts.some((p) => p.file !== undefined) || r.body.kind === 'binary' || r.cert;
    if (needFs) L.push("import fs from 'node:fs';");
    if (r.cert) L.push("import { Agent } from 'undici'; // npm i undici");
    if (L.length) L.push('');
    const b = r.body;
    let bodyExpr = null;
    let hs = r.headers;
    if (b.kind === 'raw') { bodyExpr = b.json !== undefined ? `JSON.stringify(${indentJson(b.json, '  ')})` : jsStr(b.raw); if (!hasH(hs, 'content-type')) hs = [...hs, { key: 'Content-Type', value: b.contentType }]; }
    if (b.kind === 'form') { bodyExpr = `new URLSearchParams({\n${b.fields.map((f) => `    ${jsStr(f.key)}: ${jsStr(f.value)},`).join('\n')}\n  })`; }
    if (b.kind === 'multipart') {
      hs = r.plainHeaders;
      L.push('const form = new FormData();');
      for (const p of b.parts) L.push(p.file !== undefined ? `form.append(${jsStr(p.key)}, await fs.openAsBlob(${jsStr(p.file)}), ${jsStr(p.fileName)});` : `form.append(${jsStr(p.key)}, ${jsStr(p.value)});`);
      L.push('');
      bodyExpr = 'form';
    }
    if (b.kind === 'binary') { bodyExpr = `await fs.openAsBlob(${jsStr(b.file)})`; if (!hasH(hs, 'content-type')) hs = [...hs, { key: 'Content-Type', value: b.contentType }]; }
    L.push(`const response = await fetch(${jsStr(r.url)}, {`, `  method: ${jsStr(r.method)},`, `  headers: ${jsHeaders(hs, '  ')},`);
    if (bodyExpr) L.push(`  body: ${bodyExpr},`);
    if (r.cert) L.push(`  dispatcher: new Agent({ connect: { pfx: fs.readFileSync(${jsStr(r.cert.path)}), passphrase: ${jsStr(r.cert.passphrase || '')} } }),`);
    L.push('});', '', "const data = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text();", 'console.log(response.status, data);');
    return L.join('\n') + '\n';
  }

  // ---------- JavaScript (axios) ----------
  function axiosJs(r) {
    const L = ["import axios from 'axios';"];
    const b = r.body;
    const needFs = (b.kind === 'multipart' && b.parts.some((p) => p.file !== undefined)) || b.kind === 'binary' || r.cert;
    if (needFs) L.push("import fs from 'node:fs';");
    if (r.cert) L.push("import https from 'node:https';");
    L.push('');
    let data = null, hs = r.headers;
    if (b.kind === 'raw') { data = b.json !== undefined ? indentJson(b.json, '  ') : jsStr(b.raw); if (!hasH(hs, 'content-type')) hs = [...hs, { key: 'Content-Type', value: b.contentType }]; }
    if (b.kind === 'form') data = `new URLSearchParams({\n${b.fields.map((f) => `    ${jsStr(f.key)}: ${jsStr(f.value)},`).join('\n')}\n  })`;
    if (b.kind === 'multipart') {
      hs = r.plainHeaders;
      L.push('const form = new FormData();');
      for (const p of b.parts) L.push(p.file !== undefined ? `form.append(${jsStr(p.key)}, await fs.openAsBlob(${jsStr(p.file)}), ${jsStr(p.fileName)});` : `form.append(${jsStr(p.key)}, ${jsStr(p.value)});`);
      L.push('');
      data = 'form';
    }
    if (b.kind === 'binary') { data = `fs.readFileSync(${jsStr(b.file)})`; if (!hasH(hs, 'content-type')) hs = [...hs, { key: 'Content-Type', value: b.contentType }]; }
    L.push('const response = await axios.request({', `  method: ${jsStr(r.method.toLowerCase())},`, `  url: ${jsStr(r.url)},`, `  headers: ${jsHeaders(hs, '  ')},`);
    if (data) L.push(`  data: ${data},`);
    if (r.cert) L.push(`  httpsAgent: new https.Agent({ pfx: fs.readFileSync(${jsStr(r.cert.path)}), passphrase: ${jsStr(r.cert.passphrase || '')} }),`);
    L.push('  validateStatus: () => true,', '});', '', 'console.log(response.status, response.data);');
    return L.join('\n') + '\n';
  }

  // ---------- Python (requests) ----------
  function python(r) {
    const L = [r.cert ? 'from requests_pkcs12 import request  # pip install requests-pkcs12' : 'import requests', ''];
    const b = r.body;
    L.push(`url = ${pyStr(r.url)}`);
    let hs = b.kind === 'multipart' ? r.plainHeaders : r.headers;
    if ((b.kind === 'raw' || b.kind === 'binary') && !hasH(hs, 'content-type') && !(b.kind === 'raw' && b.json !== undefined)) hs = [...hs, { key: 'Content-Type', value: b.contentType }];
    L.push(hs.length ? `headers = {\n${hs.map((x) => `    ${pyStr(x.key)}: ${pyStr(x.value)},`).join('\n')}\n}` : 'headers = {}');
    const args = ['url', 'headers=headers'];
    if (b.kind === 'raw' && b.json !== undefined) { L.push(`payload = ${JSON.stringify(b.json, null, 4).replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False').replace(/\bnull\b/g, 'None')}`); args.push('json=payload'); }
    else if (b.kind === 'raw') { L.push(`payload = ${b.raw.includes('\n') ? `"""${b.raw.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')}"""` : pyStr(b.raw)}`); args.push('data=payload.encode("utf-8")'); }
    else if (b.kind === 'form') { L.push(`payload = {\n${b.fields.map((f) => `    ${pyStr(f.key)}: ${pyStr(f.value)},`).join('\n')}\n}`); args.push('data=payload'); }
    else if (b.kind === 'multipart') {
      const texts = b.parts.filter((p) => p.file === undefined), files = b.parts.filter((p) => p.file !== undefined);
      if (texts.length) { L.push(`payload = {\n${texts.map((f) => `    ${pyStr(f.key)}: ${pyStr(f.value)},`).join('\n')}\n}`); args.push('data=payload'); }
      if (files.length) { L.push(`files = [\n${files.map((f) => `    (${pyStr(f.key)}, (${pyStr(f.fileName)}, open(${pyStr(f.file)}, "rb"), ${pyStr(mimeOf(f.fileName))})),`).join('\n')}\n]`); args.push('files=files'); }
    } else if (b.kind === 'binary') { L.push(`with open(${pyStr(b.file)}, "rb") as f:\n    payload = f.read()`); args.push('data=payload'); }
    if (r.cert) args.push(`pkcs12_filename=${pyStr(r.cert.path)}`, `pkcs12_password=${pyStr(r.cert.passphrase || '')}`);
    L.push('', `response = ${r.cert ? 'request' : 'requests.request'}(${pyStr(r.method)}, ${args.join(', ')})`, 'print(response.status_code)', 'print(response.text)');
    return L.join('\n') + '\n';
  }

  // ---------- Power Automate (ação HTTP) ----------
  function powerAutomate(r) {
    const headers = {};
    for (const x of r.body.kind === 'multipart' ? r.plainHeaders : r.headers) if (!(r.basic && x.key.toLowerCase() === 'authorization')) headers[x.key] = x.value;
    const inputs = { uri: r.url, method: r.method };
    const b = r.body;
    if (b.kind === 'raw') { if (!headers['Content-Type'] && !hasH(r.headers, 'content-type')) headers['Content-Type'] = b.contentType; inputs.body = b.json !== undefined ? b.json : b.raw; }
    if (b.kind === 'form') { headers['Content-Type'] = 'application/x-www-form-urlencoded'; inputs.body = b.fields.map((f) => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`).join('&'); }
    if (b.kind === 'multipart') inputs.body = { $content_type: 'multipart/form-data', $multipart: b.parts.map((p) => (p.file !== undefined
      ? { headers: { 'Content-Disposition': `form-data; name="${p.key}"; filename="${p.fileName}"` }, body: `@{body('Obter_conteúdo_do_arquivo')}` }
      : { headers: { 'Content-Disposition': `form-data; name="${p.key}"` }, body: p.value })) };
    if (b.kind === 'binary') { headers['Content-Type'] = b.contentType; inputs.body = `@{body('Obter_conteúdo_do_arquivo')}`; }
    if (Object.keys(headers).length) inputs.headers = headers;
    if (r.basic) inputs.authentication = { type: 'Basic', username: r.basic.username, password: r.basic.password };
    if (r.cert) inputs.authentication = { type: 'ClientCertificate', pfx: '<conteúdo do .pfx em base64>', password: r.cert.passphrase || '' };
    const def = { type: 'Http', inputs, runAfter: {} };
    const clip = { id: '', brandColor: '#709727', connectionReferences: {}, connectorDisplayName: 'HTTP', isTrigger: false, operationName: 'HTTP', operationDefinition: def };
    return JSON.stringify(clip, null, 2).replace('"$content_type"', '"$content-type"') + '\n';
  }

  const LANGS = [
    ['curl', 'cURL', 'shell'], ['csharp', 'C# · HttpClient', 'cs'], ['fetch', 'JavaScript · fetch', 'ts'], ['axios', 'JavaScript · axios', 'ts'],
    ['python', 'Python · requests', 'py'], ['powerautomate', 'Power Automate · HTTP', 'json'],
  ];
  function generate(lang, req, { cert = null, types = null } = {}) {
    const r = prepare(req, cert);
    if (lang === 'csharp') return csharp(r, { types });
    if (lang === 'fetch') return fetchJs(r);
    if (lang === 'axios') return axiosJs(r);
    if (lang === 'python') return python(r);
    if (lang === 'powerautomate') return powerAutomate(r);
    return curl(r);
  }
  function hostMatches(pattern, url) {
    let u; try { u = new URL(url); } catch { return false; }
    const p = String(pattern || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!p) return false;
    const [ph, pport] = p.split(':');
    const host = u.hostname.toLowerCase(), port = u.port || (u.protocol === 'https:' ? '443' : '80');
    if (pport && pport !== port) return false;
    return ph.startsWith('*.') ? host === ph.slice(2) || host.endsWith(ph.slice(1)) : host === ph;
  }

  return { generate, prepare, LANGS, hostMatches };
});
