// Scripts no estilo Postman (pm.*): node test/scripts.test.js
'use strict';
const assert = require('assert');
const S = require('../src/shared/sandbox');
const P = require('../src/shared/postman');

(async () => {
  const res = { ok: true, status: 201, statusText: 'Created', time: 90, size: 40, headers: [{ key: 'Content-Type', value: 'application/json' }, { key: 'Set-Cookie', value: 'sid=abc; Path=/' }], body: JSON.stringify({ token: 't1', items: [1, 2, 3], user: { name: 'Ana', age: 30 } }) };
  const post = await S.run({ event: 'test', scripts: [{ source: 'Requisição', code: `
    pm.test('status', () => pm.response.to.have.status(201));
    pm.test('2xx', () => pm.response.to.be.success);
    const j = pm.response.json();
    pm.test('cadeia', () => pm.expect(j).to.have.property('user').that.has.property('name', 'Ana'));
    pm.test('membros', () => pm.expect(j.items).to.include.members([3, 1]));
    pm.test('tamanho', () => pm.expect(j.items).to.have.length.above(2));
    pm.test('falha', () => pm.expect(j.user.age, 'idade').to.equal(31));
    pm.test('schema', () => pm.response.to.have.jsonSchema({ type: 'object', required: ['token'] }));
    pm.test('cookie', () => pm.expect(pm.cookies.get('sid')).to.eql('abc'));
    pm.environment.set('token', j.token);
    pm.globals.unset('velho');
    pm.visualizer.set('{{#each items}}[{{this}}]{{/each}}', j);
    tests['antigo'] = responseCode.code === 201;
  ` }], request: { method: 'POST', url: '{{baseUrl}}/auth', headers: [], body: { type: 'none' } }, response: res, vars: { globals: { velho: '1' }, collection: {}, environment: {} } });
  const by = Object.fromEntries(post.results.map((r) => [r.name, r]));
  for (const k of ['status', '2xx', 'cadeia', 'membros', 'tamanho', 'schema', 'cookie', 'antigo']) assert.ok(by[k] && by[k].pass, k + ': ' + (by[k] && by[k].error));
  assert.strictEqual(by.falha.pass, false);
  assert.strictEqual(by.falha.error, 'idade: esperado 30 ser igual a 31');
  assert.deepStrictEqual(post.changes.environment, { token: { value: 't1' } });
  assert.deepStrictEqual(post.changes.globals, { velho: { unset: true } });
  assert.strictEqual(post.visualizer.html, '[1][2][3]');

  const sent = [];
  const pre = await S.run({ event: 'prerequest', scripts: [
    { source: 'Coleção · API', code: "pm.collectionVariables.set('c', 'C');" },
    { source: 'Requisição', code: `
      pm.request.headers.upsert({ key: 'X-Id', value: pm.variables.replaceIn('{{$guid}}') });
      pm.request.url.query.add({ key: 'p', value: '2' });
      const r = await pm.sendRequest({ url: pm.environment.get('baseUrl') + '/login', method: 'POST', body: { mode: 'raw', raw: '{"u":1}' } });
      pm.environment.set('token', r.json().token);
      pm.variables.set('local', pm.collectionVariables.get('c'));
    ` }],
    request: { method: 'GET', url: '{{baseUrl}}/x?a=1', params: [{ key: 'a', value: '1', enabled: true }], headers: [], body: { type: 'none' } },
    vars: { globals: {}, collection: {}, environment: { baseUrl: 'http://h' } } },
    { send: async (req) => { sent.push(req); return { ok: true, status: 200, time: 1, size: 1, headers: [], body: '{"token":"zz"}' }; } });
  assert.strictEqual(pre.error, null);
  assert.strictEqual(sent[0].url, 'http://h/login');
  assert.strictEqual(sent[0].body.type, 'json');
  assert.strictEqual(pre.request.url, '{{baseUrl}}/x?a=1&p=2');
  assert.match(pre.request.headers[0].value, /^[0-9a-f-]{36}$/);
  assert.deepStrictEqual(pre.changes.environment.token, { value: 'zz' });
  assert.strictEqual(pre.local.local, 'C');

  const bad = await S.run({ event: 'prerequest', scripts: [{ source: 'Requisição', code: 'const a = 1;\na.b.c;' }], request: { url: 'x' }, vars: {} });
  assert.strictEqual(bad.error.line, 2);
  const skip = await S.run({ event: 'prerequest', scripts: [{ source: 'R', code: 'pm.execution.skipRequest()' }], request: { url: 'x' }, vars: {} });
  assert.strictEqual(skip.skipRequest, true);
  assert.strictEqual(S.replaceVars('{{a}}-{{$timestamp}}', (k) => ({ a: 'A' })[k]).split('-')[0], 'A');

  // Links do Postman
  assert.deepStrictEqual(P.parsePostmanUrl('https://www.postman.com/postman/workspace/test-examples-in-postman/example/'),
    { kind: 'workspace', team: 'postman', slug: 'test-examples-in-postman', elementType: 'example', elementUid: null });
  const c = P.parsePostmanUrl('https://www.postman.com/acme/workspace/apis/collection/1234567-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?tab=overview');
  assert.strictEqual(c.collectionUid, '1234567-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.strictEqual(P.parsePostmanUrl('https://documenter.getpostman.com/view/123/2s93XyUPF1').api, 'https://documenter.gw.postman.com/api/collections/123/2s93XyUPF1?segregateAuth=true&versionTag=latest');
  assert.strictEqual(P.parsePostmanUrl('https://api.exemplo.com/docs'), null);
  assert.deepStrictEqual(P.findCollectionRefs({ data: { elements: { collections: ['1-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'] } } }).map((x) => x.uid), ['1-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']);
  console.log('ok — scripts (pm.*) e links do Postman passaram');
})().catch((e) => { console.error(e); process.exit(1); });
