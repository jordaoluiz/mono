// Testes do módulo HTTP contra um servidor local: node test/http.test.js
'use strict';
const assert = require('assert');
const httpServer = require('http');
const { send, buildRequest, toCurl, interpolate } = require('../src/http');
const { createStore } = require('../src/store');
const fs = require('fs'); const os = require('os'); const path = require('path');

(async () => {
  const server = httpServer.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url.startsWith('/slow')) return setTimeout(() => res.end('late'), 2000);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.strictEqual(interpolate('{{a}}/{{ b }}/{{c}}', { a: 1, b: 'x' }), '1/x/{{c}}');

  const r1 = await send({
    method: 'POST', url: '{{base}}/eco?ignorado=1',
    params: [{ key: 'q', value: 'olá mundo', enabled: true }, { key: 'off', value: '1', enabled: false }],
    headers: [{ key: 'X-Teste', value: '{{tok}}', enabled: true }],
    body: { type: 'json', raw: '{"id":{{id}}}' },
    auth: { type: 'bearer', token: '{{tok}}' },
  }, { base, tok: 'abc', id: 7 });
  assert.ok(r1.ok, r1.error);
  const e1 = JSON.parse(r1.body);
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(e1.method, 'POST');
  assert.strictEqual(e1.url, '/eco?q=ol%C3%A1+mundo');
  assert.strictEqual(e1.headers['x-teste'], 'abc');
  assert.strictEqual(e1.headers.authorization, 'Bearer abc');
  assert.strictEqual(e1.headers['content-type'], 'application/json');
  assert.strictEqual(e1.body, '{"id":7}');
  assert.ok(r1.time >= 0 && r1.size > 0 && r1.headers.length > 0);

  const r2 = await send({ method: 'PUT', url: base + '/f', body: { type: 'form', form: [{ key: 'a', value: '1 2', enabled: true }] }, auth: { type: 'basic', username: 'u', password: 'p' } });
  const e2 = JSON.parse(r2.body);
  assert.strictEqual(e2.body, 'a=1+2');
  assert.strictEqual(e2.headers.authorization, 'Basic ' + Buffer.from('u:p').toString('base64'));

  const r3 = await send({ method: 'GET', url: base + '/slow' }, {}, { timeoutMs: 300 });
  assert.ok(!r3.ok && /Tempo esgotado/.test(r3.error));

  const r4 = await send({ method: 'GET', url: 'http://127.0.0.1:1/' });
  assert.ok(!r4.ok && r4.error);

  assert.strictEqual(buildRequest({ url: 'localhost:3000/x' }).url, 'http://localhost:3000/x');

  // API Key (header e query), OAuth2 e header manual vencendo a autorização
  const k1 = buildRequest({ url: 'https://a.dev/x', params: [], auth: { type: 'apikey', key: 'x-api-key', value: '{{k}}', in: 'header' } }, { k: 'abc' });
  assert.strictEqual(k1.headers['x-api-key'], 'abc');
  const k2 = buildRequest({ url: 'https://a.dev/x', params: [{ key: 'p', value: '1' }], auth: { type: 'apikey', key: 'api_key', value: 'z', in: 'query' } });
  assert.strictEqual(k2.url, 'https://a.dev/x?p=1&api_key=z');
  const o1 = buildRequest({ url: 'https://a.dev', auth: { type: 'oauth2', oauth2: { accessToken: 'tok', tokenType: 'Bearer' } } });
  assert.strictEqual(o1.headers.Authorization, 'Bearer tok');
  const o2 = buildRequest({ url: 'https://a.dev', headers: [{ key: 'authorization', value: 'Custom x' }], auth: { type: 'bearer', token: 't' } });
  assert.ok(!('Authorization' in o2.headers) && o2.headers.authorization === 'Custom x', 'header manual tem prioridade');
  assert.ok(!('Authorization' in buildRequest({ url: 'https://a.dev', auth: { type: 'inherit' } }).headers), 'inherit não resolvido = sem auth');

  // Transporte injetável (o app usa o do Chromium para proxy)
  let seen;
  const fakeTransport = async (b) => { seen = b; return { status: 201, statusText: 'Created', headers: [{ key: 'content-type', value: 'application/json' }], url: b.url, buffer: Buffer.from('{"ok":true}') }; };
  const rt = await send({ method: 'POST', url: 'https://z.dev/a', body: { type: 'json', raw: '{}' } }, {}, { transport: fakeTransport });
  assert.ok(rt.ok && rt.status === 201 && rt.body === '{"ok":true}' && seen.method === 'POST');
  const c = toCurl({ method: 'POST', url: 'https://x.dev/a', headers: [{ key: 'A', value: "it's" }], body: { type: 'text', raw: 'oi' } });
  assert.ok(c.includes(`-H 'A: it'\\''s'`) && c.includes("--data-raw 'oi'"));

  // Store: segredos vão criptografados para o disco e voltam em claro.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-'));
  const fake = { available: () => true, encrypt: (s) => Buffer.from('X' + s).toString('base64'), decrypt: (b) => Buffer.from(b, 'base64').toString().slice(1) };
  const st = createStore(dir, fake);
  st.save({ environments: [{ id: 'e', name: 'E', vars: [{ key: 'token', value: 's3cr3t', secret: true }, { key: 'base', value: 'pub' }] }] });
  const disk = fs.readFileSync(st.file, 'utf8');
  assert.ok(!disk.includes('s3cr3t') && disk.includes('pub'));
  assert.strictEqual(st.load().environments[0].vars[0].value, 's3cr3t');
  st.save({ environments: [], settings: { proxy: { mode: 'custom', host: 'proxy.pwc', password: 'P@ss' } } });
  assert.ok(!fs.readFileSync(st.file, 'utf8').includes('P@ss'), 'senha do proxy não vai em claro para o disco');
  assert.strictEqual(st.load().settings.proxy.password, 'P@ss');

  server.close();
  console.log('ok — todos os testes passaram');
})().catch((e) => { console.error(e); process.exit(1); });
