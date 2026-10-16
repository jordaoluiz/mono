// Servidor do Mono + cliente do app: cadastro, @ único, convite, aceite e tempo real entre duas pessoas.
'use strict';
const assert = require('assert');
const { createApp } = require('../server/app');
const { createMemoryDb } = require('../server/db-memory');
const { createCloud } = require('../src/cloud');
const S = require('../src/shared/sync');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = fn(); if (v) return v; await wait(20); }
  throw new Error('tempo esgotado esperando evento');
}

(async () => {
  const db = createMemoryDb(); await db.init();
  const server = createApp({ db });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}`;

  const client = (name) => {
    const events = [], states = [];
    const c = createCloud({ fetchImpl: fetch, emit: (type, p) => (type === 'event' ? events : states).push(p) });
    return { name, c, events, states, token: null, call(method, path, body) { return c.call({ url, token: this.token, method, path, body }); } };
  };
  const ana = client('ana'), bia = client('bia');

  // cadastro e @ único
  let r = await ana.call('POST', '/v1/register', { username: '@Ana.Dev', password: 'senha-forte-1', name: 'Ana' });
  assert.ok(r.ok, r.error); ana.token = r.data.token;
  assert.strictEqual(r.data.user.username, 'ana.dev');
  r = await bia.call('POST', '/v1/register', { username: 'ana.dev', password: 'outra-senha-2' });
  assert.strictEqual(r.status, 409); assert.match(r.error, /já está em uso/);
  r = await bia.call('POST', '/v1/register', { username: 'b', password: 'outra-senha-2' });
  assert.strictEqual(r.status, 400);
  r = await bia.call('POST', '/v1/register', { username: 'bia', password: '123' });
  assert.match(r.error, /8 caracteres/);
  r = await bia.call('POST', '/v1/register', { username: 'bia', password: 'outra-senha-2' });
  assert.ok(r.ok); bia.token = r.data.token;
  // login
  r = await bia.call('POST', '/v1/login', { username: 'bia', password: 'errada-123' });
  assert.strictEqual(r.status, 401);
  r = await bia.call('POST', '/v1/login', { username: '@BIA', password: 'outra-senha-2' });
  assert.ok(r.ok); bia.token = r.data.token;
  assert.strictEqual((await bia.call('GET', '/v1/me')).data.user.username, 'bia');
  assert.strictEqual((await client('x').call('GET', '/v1/me')).status, 401);
  // senha não fica em claro
  assert.ok(!JSON.stringify(await db.userByName('bia')).includes('outra-senha-2'));
  // busca de @
  assert.deepStrictEqual((await ana.call('GET', '/v1/users?q=bi')).data.users.map((u) => u.username), ['bia']);

  // tempo real
  ana.c.connect({ url, token: ana.token, clientId: 'ana-1' });
  bia.c.connect({ url, token: bia.token, clientId: 'bia-1' });
  await until(() => ana.events.some((e) => e.event === 'hello') && bia.events.some((e) => e.event === 'hello'));
  assert.ok(ana.states.some((s) => s.state === 'online'));

  // Ana compartilha um workspace (o segredo dela não vai)
  const local = {
    collections: [{ id: 'c1', name: 'Booker', open: true, folders: [], requests: [{ id: 'r1', name: 'Get', method: 'GET', url: '{{base}}/x' }] }],
    environments: [{ id: 'e1', name: 'Hom', vars: [{ key: 'token', value: 'SEGREDO-ANA', secret: true }] }], globals: { vars: [] },
  };
  r = await ana.call('POST', '/v1/workspaces', { name: 'Fiscal', description: 'NF-e', data: S.shareable(local) });
  assert.ok(r.ok, r.error);
  const ws = r.data.workspace;
  assert.ok(!JSON.stringify((await db.getWorkspace(ws.id)).data).includes('SEGREDO-ANA'));
  assert.strictEqual((await bia.call('GET', `/v1/workspaces/${ws.id}`)).status, 404, 'quem não é membro não vê');

  // convite por @
  assert.strictEqual((await ana.call('POST', `/v1/workspaces/${ws.id}/invites`, { username: '@ninguem' })).status, 404);
  r = await ana.call('POST', `/v1/workspaces/${ws.id}/invites`, { username: '@bia' });
  assert.ok(r.ok, r.error);
  assert.strictEqual((await ana.call('POST', `/v1/workspaces/${ws.id}/invites`, { username: 'bia' })).status, 409, 'convite duplicado');
  const inv = await until(() => bia.events.find((e) => e.event === 'invite'));
  assert.strictEqual(inv.data.wsName, 'Fiscal'); assert.strictEqual(inv.data.from.username, 'ana.dev');
  assert.strictEqual((await bia.call('GET', '/v1/invites')).data.invites.length, 1);
  assert.strictEqual((await ana.call('POST', `/v1/invites/${inv.data.id}/accept`)).status, 404, 'só a convidada aceita');

  // Bia aceita e recebe o conteúdo
  r = await bia.call('POST', `/v1/invites/${inv.data.id}/accept`);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.data.workspace.data.collections[0].requests[0].name, 'Get');
  assert.strictEqual(r.data.workspace.members.length, 2);
  await until(() => ana.events.find((e) => e.event === 'members' && e.data.joined === 'bia'));
  assert.strictEqual((await bia.call('GET', '/v1/invites')).data.invites.length, 0);

  // Bia cria uma pasta e uma requisição → Ana recebe na hora (Bia não recebe o eco)
  const biaData = S.applyOps({}, []); Object.assign(biaData, S.clone(r.data.workspace.data));
  const before = S.shareable(biaData);
  biaData.collections[0].folders.push({ id: 'f1', name: 'Reservas' });
  biaData.collections[0].requests.push({ id: 'r2', name: 'Create', method: 'POST', url: '{{base}}/booking', folderId: 'f1' });
  const ops = S.diff(before, S.shareable(biaData));
  r = await bia.call('POST', `/v1/workspaces/${ws.id}/ops`, { ops, clientId: 'bia-1' });
  assert.ok(r.ok, r.error); assert.strictEqual(r.data.version, 2);
  const got = await until(() => ana.events.find((e) => e.event === 'ops'));
  assert.strictEqual(got.data.by, 'bia'); assert.strictEqual(got.data.version, 2);
  S.applyOps(local, got.data.ops);
  assert.deepStrictEqual(local.collections[0].requests.map((x) => x.name), ['Get', 'Create']);
  assert.strictEqual(local.environments[0].vars[0].value, 'SEGREDO-ANA', 'segredo local continua');
  assert.strictEqual(local.collections[0].open, true, 'árvore local continua');
  await wait(100);
  assert.ok(!bia.events.some((e) => e.event === 'ops'), 'sem eco para quem enviou');

  // operações inválidas são recusadas
  assert.strictEqual((await bia.call('POST', `/v1/workspaces/${ws.id}/ops`, { ops: [{ t: 'x' }] })).status, 400);

  // edições simultâneas em itens diferentes: as duas ficam
  await Promise.all([
    ana.call('POST', `/v1/workspaces/${ws.id}/ops`, { clientId: 'ana-1', ops: [{ t: 'req', col: 'c1', id: 'r1', v: { id: 'r1', name: 'Get (Ana)', method: 'GET', url: '/a' } }] }),
    bia.call('POST', `/v1/workspaces/${ws.id}/ops`, { clientId: 'bia-1', ops: [{ t: 'req', col: 'c1', id: 'r2', v: { id: 'r2', name: 'Create (Bia)', method: 'POST', url: '/b', folderId: 'f1' } }] }),
  ]);
  const srv = (await ana.call('GET', `/v1/workspaces/${ws.id}`)).data.workspace;
  assert.deepStrictEqual(srv.data.collections[0].requests.map((x) => x.name), ['Get (Ana)', 'Create (Bia)']);
  assert.strictEqual(srv.version, 4);

  // renomear avisa todos
  await bia.call('PATCH', `/v1/workspaces/${ws.id}`, { name: 'Fiscal SP' });
  await until(() => ana.events.find((e) => e.event === 'workspace' && e.data.name === 'Fiscal SP'));

  // só a dona remove/exclui; Bia pode sair
  assert.strictEqual((await bia.call('DELETE', `/v1/workspaces/${ws.id}`)).status, 403);
  r = await bia.call('DELETE', `/v1/workspaces/${ws.id}/members/${(await db.userByName('bia')).id}`);
  assert.ok(r.ok, r.error);
  await until(() => bia.events.find((e) => e.event === 'removed' && e.data.reason === 'left'));
  await until(() => ana.events.find((e) => e.event === 'members' && e.data.left === 'bia'));
  assert.strictEqual((await bia.call('GET', '/v1/workspaces')).data.workspaces.length, 0);
  assert.strictEqual((await ana.call('GET', '/v1/workspaces')).data.workspaces.length, 1);
  r = await ana.call('DELETE', `/v1/workspaces/${ws.id}`);
  assert.ok(r.ok);
  await until(() => ana.events.find((e) => e.event === 'removed' && e.data.reason === 'deleted'));

  // sessão encerrada derruba o token
  await bia.call('POST', '/v1/logout');
  assert.strictEqual((await bia.call('GET', '/v1/me')).status, 401);

  // servidor fora do ar → erro amigável
  const off = await createCloud({ fetchImpl: fetch, emit: () => {} }).call({ url: 'http://127.0.0.1:1', path: '/health' });
  assert.ok(!off.ok && /Sem conexão/.test(off.error));

  ana.c.disconnect(); bia.c.disconnect();
  server.closeStreams(); server.close();
  console.log('ok — servidor do Mono (contas, convites e tempo real) passou');
})().catch((e) => { console.error(e); process.exit(1); });
