// Testes gerados a partir da resposta: o código gerado roda no sandbox e passa na própria resposta.
'use strict';
const assert = require('assert');
const T = require('../src/shared/testgen');
const sandbox = require('../src/shared/sandbox');

(async () => {
  const res = { status: 200, statusText: 'OK', time: 180, contentType: 'application/json; charset=utf-8', headers: [{ key: 'Content-Type', value: 'application/json; charset=utf-8' }],
    body: JSON.stringify({ firstname: 'Sally', totalprice: 111, depositpaid: true, bookingdates: { checkin: '2026-11-02', checkout: '2026-11-06' }, additionalneeds: null, 'tipo-pag': 'pix' }) };
  const code = T.generate(res);
  assert.match(code, /to\.have\.status\(200\)/);
  assert.match(code, /below\(1000\)/);
  assert.match(code, /json\.firstname\)\.to\.be\.a\('string'\)/);
  assert.match(code, /json\.bookingdates\.checkin/);
  assert.match(code, /json\["tipo-pag"\]/);
  assert.ok(!/additionalneeds\)\.to\.be/.test(code), 'campo nulo não trava o tipo');
  const run = (body, status = 200) => sandbox.run({ event: 'test', scripts: [{ code, source: 'gerado' }], request: { method: 'GET', url: 'https://x/booking/1', headers: [] }, response: { ...res, body, status } });
  let out = await run(res.body);
  assert.ok(!out.error, out.error && out.error.message);
  assert.ok(out.results.length >= 4 && out.results.every((r) => r.pass), JSON.stringify(out.results.filter((r) => !r.pass)));
  // se a API mudar, o teste pega
  out = await run(JSON.stringify({ firstname: 7, bookingdates: {} }), 200);
  assert.ok(out.results.some((r) => !r.pass), 'mudança de tipo falha');
  out = await run(res.body, 500);
  assert.ok(out.results.some((r) => !r.pass && /Status/.test(r.name)));
  // lista
  const list = T.generate({ status: 200, time: 50, contentType: 'application/json', body: '[{"bookingid":1},{"bookingid":2}]' });
  out = await sandbox.run({ event: 'test', scripts: [{ code: list }], request: { method: 'GET', url: 'https://x', headers: [] }, response: { status: 200, time: 50, contentType: 'application/json', headers: [{ key: 'content-type', value: 'application/json' }], body: '[{"bookingid":1},{"bookingid":2}]' } });
  assert.ok(out.results.every((r) => r.pass), JSON.stringify(out.results));
  // XML
  const xml = T.generate({ status: 200, time: 90, contentType: 'application/soap+xml', body: '<soap:Envelope><soap:Body><retConsStatServ/></soap:Body></soap:Envelope>' });
  assert.match(xml, /Envelope/);
  // IA: prompt e limpeza
  assert.match(T.aiPrompt({ method: 'GET', url: 'u' }, res), /pm\.test/);
  assert.strictEqual(T.cleanCode('```js\npm.test("a", () => {});\n```'), 'pm.test("a", () => {});\n');
  console.log('ok — testes gerados a partir da resposta passaram');
})().catch((e) => { console.error(e); process.exit(1); });
