// Servidor do Mono: histórico com desfazer, papel só leitura, comentários, presença e resultados de monitores.
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
    const events = [];
    const c = createCloud({ fetchImpl: fetch, emit: (type, p) => { if (type === 'event') events.push(p); } });
    return { name, c, events, token: null, clientId: name + '-1', call(method, path, body) { return c.call({ url, token: this.token, method, path, body }); } };
  };
  const ana = client('ana'), bia = client('bia'), caio = client('caio');
  for (const u of [ana, bia, caio]) {
    const r = await u.call('POST', '/v1/register', { username: u.name, password: 'senha-forte-1', name: u.name.toUpperCase() });
    assert.ok(r.ok, r.error); u.token = r.data.token; u.id = r.data.user.id;
    u.c.connect({ url, token: u.token, clientId: u.clientId });
  }
  await until(() => [ana, bia, caio].every((u) => u.events.some((e) => e.event === 'hello')));

  const req = (id, name, url2) => ({ id, name, method: 'GET', url: url2 });
  const data0 = { collections: [{ id: 'c1', name: 'Booker', folders: [], requests: [req('r1', 'Get', '/a'), req('r2', 'List', '/b')] }], environments: [], globals: { vars: [] } };
  const ws = (await ana.call('POST', '/v1/workspaces', { name: 'Time', data: S.shareable(data0) })).data.workspace;

  // convites: Bia edita, Caio só lê
  for (const [u, role] of [[bia, 'editor'], [caio, 'viewer']]) {
    const r = await ana.call('POST', `/v1/workspaces/${ws.id}/invites`, { username: u.name, role });
    assert.ok(r.ok, r.error);
    const inv = await until(() => u.events.find((e) => e.event === 'invite'));
    assert.strictEqual(inv.data.role, role);
    assert.ok((await u.call('POST', `/v1/invites/${inv.data.id}/accept`)).ok);
  }
  let w = (await ana.call('GET', `/v1/workspaces/${ws.id}`)).data.workspace;
  assert.deepStrictEqual(w.members.map((m) => m.role), ['owner', 'editor', 'viewer']);

  // só leitura: Caio não grava, não convida, não renomeia
  const viewOps = [{ t: 'req', col: 'c1', id: 'r1', v: req('r1', 'Hack', '/x') }];
  let r = await caio.call('POST', `/v1/workspaces/${ws.id}/ops`, { ops: viewOps, clientId: caio.clientId });
  assert.strictEqual(r.status, 403); assert.match(r.error, /só de leitura/);
  assert.strictEqual((await caio.call('POST', `/v1/workspaces/${ws.id}/invites`, { username: 'bia' })).status, 403);
  assert.strictEqual((await caio.call('PATCH', `/v1/workspaces/${ws.id}`, { name: 'x' })).status, 403);

  // histórico: Bia muda a URL de Get; Ana exclui List
  r = await bia.call('POST', `/v1/workspaces/${ws.id}/ops`, { clientId: bia.clientId, ops: [{ t: 'req', col: 'c1', id: 'r1', v: req('r1', 'Get', '/a?v=2') }] });
  assert.ok(r.ok, r.error); assert.strictEqual(r.data.change.by.username, 'bia');
  const evt = await until(() => ana.events.find((e) => e.event === 'ops' && e.data.change));
  assert.strictEqual(evt.data.change.items[0].name, 'Get');
  r = await ana.call('POST', `/v1/workspaces/${ws.id}/ops`, { clientId: ana.clientId, ops: [{ t: 'reqDel', col: 'c1', id: 'r2' }] });
  const delChange = r.data.change;
  let hist = (await caio.call('GET', `/v1/workspaces/${ws.id}/changes`)).data.changes;
  assert.deepStrictEqual(hist.map((c) => c.by.username), ['ana', 'bia']);
  assert.strictEqual(hist[0].items[0].name, 'List', 'nome do item excluído aparece no histórico');
  assert.ok(hist[1].inverse[0].v.url === '/a', 'inverso guarda o valor anterior');
  assert.strictEqual((await ana.call('GET', `/v1/workspaces/${ws.id}/changes?item=r1`)).data.changes.length, 1);

  // desfazer a exclusão: a requisição volta no lugar e todos recebem (inclusive quem desfez)
  ana.events.length = 0;
  r = await bia.call('POST', `/v1/workspaces/${ws.id}/changes/${delChange.id}/undo`, {});
  assert.ok(r.ok, r.error);
  await until(() => bia.events.find((e) => e.event === 'ops' && e.data.change && e.data.change.undoOf === delChange.id));
  w = (await ana.call('GET', `/v1/workspaces/${ws.id}`)).data.workspace;
  assert.deepStrictEqual(w.data.collections[0].requests.map((x) => x.id), ['r1', 'r2']);
  assert.strictEqual((await bia.call('POST', `/v1/workspaces/${ws.id}/changes/${delChange.id}/undo`, {})).status, 409, 'não desfaz duas vezes');
  assert.strictEqual((await caio.call('POST', `/v1/workspaces/${ws.id}/changes/${delChange.id}/undo`, {})).status, 403);

  // desfazer algo que foi alterado depois pede confirmação
  hist = (await ana.call('GET', `/v1/workspaces/${ws.id}/changes?item=r1`)).data.changes;
  const urlChange = hist[hist.length - 1];
  await ana.call('POST', `/v1/workspaces/${ws.id}/ops`, { clientId: ana.clientId, ops: [{ t: 'req', col: 'c1', id: 'r1', v: req('r1', 'Get', '/a?v=3') }] });
  r = await bia.call('POST', `/v1/workspaces/${ws.id}/changes/${urlChange.id}/undo`, {});
  assert.strictEqual(r.status, 409); assert.match(r.error, /alterados depois/);
  r = await bia.call('POST', `/v1/workspaces/${ws.id}/changes/${urlChange.id}/undo`, { force: true });
  assert.ok(r.ok, r.error);
  w = (await ana.call('GET', `/v1/workspaces/${ws.id}`)).data.workspace;
  assert.strictEqual(w.data.collections[0].requests[0].url, '/a');

  // papel: Ana promove Caio a editor
  r = await bia.call('PATCH', `/v1/workspaces/${ws.id}/members/${caio.id}`, { role: 'editor' });
  assert.strictEqual(r.status, 403);
  assert.ok((await ana.call('PATCH', `/v1/workspaces/${ws.id}/members/${caio.id}`, { role: 'editor' })).ok);
  await until(() => caio.events.find((e) => e.event === 'members' && e.data.roleChanged === 'caio'));
  assert.ok((await caio.call('POST', `/v1/workspaces/${ws.id}/ops`, { ops: viewOps, clientId: caio.clientId })).ok);

  // comentários
  r = await caio.call('POST', `/v1/workspaces/${ws.id}/comments`, { reqId: 'r1', colId: 'c1', text: 'Esse endpoint muda em novembro' });
  assert.ok(r.ok, r.error);
  const cm = r.data.comment;
  await until(() => ana.events.find((e) => e.event === 'comment' && e.data.action === 'add'));
  assert.strictEqual((await ana.call('PATCH', `/v1/workspaces/${ws.id}/comments/${cm.id}`, { text: 'outro' })).status, 403, 'só o autor edita');
  assert.ok((await ana.call('PATCH', `/v1/workspaces/${ws.id}/comments/${cm.id}`, { resolved: true })).ok);
  assert.strictEqual((await bia.call('DELETE', `/v1/workspaces/${ws.id}/comments/${cm.id}`)).status, 403);
  let cms = (await bia.call('GET', `/v1/workspaces/${ws.id}/comments`)).data.comments;
  assert.strictEqual(cms[0].resolved, true); assert.strictEqual(cms[0].resolvedBy, 'ana');
  assert.ok((await ana.call('DELETE', `/v1/workspaces/${ws.id}/comments/${cm.id}`)).ok, 'dona do workspace apaga');
  cms = (await bia.call('GET', `/v1/workspaces/${ws.id}/comments`)).data.comments;
  assert.strictEqual(cms.length, 0);

  // presença
  r = await ana.call('POST', '/v1/presence', { ws: ws.id, reqId: 'r1', clientId: ana.clientId });
  assert.deepStrictEqual(r.data.users.map((u) => u.username), ['ana']);
  await bia.call('POST', '/v1/presence', { ws: ws.id, reqId: null, clientId: bia.clientId });
  const pres = await until(() => ana.events.filter((e) => e.event === 'presence').find((e) => e.data.users.length === 2));
  assert.deepStrictEqual(pres.data.users.find((u) => u.username === 'ana').reqIds, ['r1']);
  ana.events.length = 0;
  bia.c.disconnect(); // fechar o Mono tira a pessoa da presença
  await until(() => ana.events.find((e) => e.event === 'presence' && e.data.users.length === 1));
  assert.strictEqual((await client('x').call('POST', '/v1/presence', { ws: ws.id, clientId: 'z' })).status, 401);

  // monitores
  r = await ana.call('POST', `/v1/workspaces/${ws.id}/monitor-runs`, { monitorId: 'm1', name: 'SEFAZ SP', ok: false, total: 3, failed: 1, durationMs: 1200, failures: [{ name: 'Status', error: 'cStat 108' }] });
  assert.ok(r.ok, r.error);
  const mon = await until(() => caio.events.find((e) => e.event === 'monitor'));
  assert.strictEqual(mon.data.run.failures[0].error, 'cStat 108');
  assert.strictEqual((await caio.call('GET', `/v1/workspaces/${ws.id}/monitor-runs`)).data.runs.length, 1);

  // excluir o workspace limpa histórico, comentários e monitores
  assert.ok((await ana.call('DELETE', `/v1/workspaces/${ws.id}`)).ok);
  assert.strictEqual((await db.listChanges(ws.id)).length, 0);
  assert.strictEqual((await db.listMonitorRuns(ws.id)).length, 0);

  for (const u of [ana, bia, caio]) u.c.disconnect();
  server.closeStreams(); server.close();
  console.log('ok — histórico, desfazer, só leitura, comentários, presença e monitores passaram');
})().catch((e) => { console.error(e); process.exit(1); });
