// Mock server: rotas a partir dos exemplos, parâmetros de caminho, escolha de exemplo, CORS e 404.
'use strict';
const assert = require('assert');
const { createMock } = require('../src/mock');
const R = require('../src/shared/mockroutes');

(async () => {
  assert.strictEqual(R.pathOf('{{baseUrl}}/booking/{{id}}?x=1'), '/booking/{{id}}');
  assert.strictEqual(R.pathOf('https://api.x.com/v1/users/:id'), '/v1/users/:id');
  assert.ok(R.matchPath('/booking/{{id}}', '/booking/42') >= 0);
  assert.strictEqual(R.matchPath('/booking/{{id}}', '/booking/42/x'), -1);

  const col = { requests: [
    { id: 'r1', name: 'Listar', method: 'GET', url: '{{baseUrl}}/booking', examples: [{ name: 'lista', status: 200, contentType: 'application/json', headers: [{ key: 'X-Total', value: '2' }], body: '[1,2]' }] },
    { id: 'r2', name: 'Detalhe', method: 'GET', url: '{{baseUrl}}/booking/{{id}}', examples: [
      { name: 'não achou', status: 404, contentType: 'application/json', body: '{"erro":"nao"}' },
      { name: 'achou', status: 200, contentType: 'application/json', body: '{"id":1}' }] },
    { id: 'r3', name: 'Criar', method: 'POST', url: '{{baseUrl}}/booking', examples: [{ name: 'criado', status: 201, contentType: 'application/json', body: '{"ok":true}', isDefault: true }, { name: 'erro', status: 400, body: 'x' }] },
    { id: 'r4', name: 'Sem exemplo', method: 'GET', url: '{{baseUrl}}/nada' },
  ] };
  const routes = R.routesFromCollection(col);
  assert.strictEqual(routes.length, 3);
  const hits = [];
  const m = createMock({ onHit: (x) => hits.push(x) });
  const st = await m.start({ port: 0, routes });
  assert.ok(st.running && st.port > 0);
  const base = `http://127.0.0.1:${st.port}`;

  let r = await fetch(base + '/booking');
  assert.strictEqual(r.status, 200); assert.strictEqual(await r.text(), '[1,2]');
  assert.strictEqual(r.headers.get('x-total'), '2');
  assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
  r = await fetch(base + '/booking/77');
  assert.strictEqual(r.status, 200, 'prefere exemplo 2xx'); assert.deepStrictEqual(await r.json(), { id: 1 });
  r = await fetch(base + '/booking/77', { headers: { 'x-mono-example': 'não achou' } });
  assert.strictEqual(r.status, 404);
  r = await fetch(base + '/booking/77?__example=404');
  assert.strictEqual(r.status, 404);
  r = await fetch(base + '/booking', { method: 'POST', body: '{}' });
  assert.strictEqual(r.status, 201, 'exemplo padrão');
  r = await fetch(base + '/nada');
  assert.strictEqual(r.status, 404); assert.match((await r.json()).error, /Nenhum exemplo/);
  r = await fetch(base + '/booking', { method: 'OPTIONS', headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST' } });
  assert.strictEqual(r.status, 204); assert.strictEqual(r.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assert.ok(hits.length >= 6 && hits[0].matched.request === 'Listar');

  // atualizar rotas ao vivo e atraso
  m.update({ routes: R.routesFromCollection({ requests: [col.requests[0]] }), delay: 120 });
  const t = Date.now(); r = await fetch(base + '/booking'); assert.ok(Date.now() - t >= 110);
  assert.strictEqual((await fetch(base + '/booking/1')).status, 404);

  // porta ocupada → mensagem clara
  const m2 = createMock();
  await assert.rejects(m2.start({ port: st.port, routes }), /já está em uso/);
  await m.stop();
  assert.deepStrictEqual(m.status(), { running: false });
  console.log('ok — mock server passou');
})().catch((e) => { console.error(e); process.exit(1); });
