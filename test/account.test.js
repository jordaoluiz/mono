// Conta: códigos de recuperação, trocar senha, recuperar acesso e sessões.
'use strict';
const assert = require('assert');
const { createApp } = require('../server/app');
const { createMemoryDb } = require('../server/db-memory');
const { createCloud } = require('../src/cloud');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await wait(20); } throw new Error('tempo esgotado'); }

(async () => {
  const db = createMemoryDb(); await db.init();
  const server = createApp({ db });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const dev = (name) => {
    const events = [], states = [];
    const c = createCloud({ fetchImpl: fetch, device: name, emit: (t, p) => (t === 'event' ? events : states).push(p) });
    return { c, events, states, token: null, call(m, p, b) { return c.call({ url, token: this.token, method: m, path: p, body: b }); } };
  };
  const pc = dev('NOTEBOOK · Windows · Mono 0.1.4'), casa = dev('CASA · Windows · Mono 0.1.4');

  // cadastro devolve 10 códigos, uma vez
  let r = await pc.call('POST', '/v1/register', { username: 'luiz', password: 'senha-forte-1' });
  assert.ok(r.ok, r.error); pc.token = r.data.token;
  const codes = r.data.recoveryCodes;
  assert.strictEqual(codes.length, 10); assert.match(codes[0], /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.strictEqual(new Set(codes).size, 10);
  assert.ok(!JSON.stringify(await db.userByName('luiz')).includes(codes[0]), 'só o hash fica no banco');
  assert.strictEqual((await pc.call('GET', '/v1/me')).data.recoveryLeft, 10);

  // segunda sessão + lista de sessões com aparelho
  r = await casa.call('POST', '/v1/login', { username: 'luiz', password: 'senha-forte-1' }); casa.token = r.data.token;
  let ss = (await pc.call('GET', '/v1/me/sessions')).data.sessions;
  assert.deepStrictEqual(ss.map((s) => [s.device.split(' ')[0], s.current]), [['NOTEBOOK', true], ['CASA', false]]);
  assert.ok(!JSON.stringify(ss).includes('tokenHash'));

  // encerrar a sessão da CASA derruba o tempo real dela na hora
  casa.c.connect({ url, token: casa.token, clientId: 'casa' });
  await until(() => casa.events.some((e) => e.event === 'hello'));
  r = await pc.call('DELETE', `/v1/me/sessions/${ss[1].id}`);
  assert.ok(r.ok, r.error);
  await until(() => casa.states.some((s) => s.state === 'unauthorized'));
  assert.strictEqual((await casa.call('GET', '/v1/me')).status, 401);
  casa.c.disconnect();

  // trocar senha: exige a atual, encerra as outras sessões
  r = await casa.call('POST', '/v1/login', { username: 'luiz', password: 'senha-forte-1' }); casa.token = r.data.token;
  assert.strictEqual((await pc.call('POST', '/v1/me/password', { current: 'errada', next: 'nova-senha-2' })).status, 401);
  assert.strictEqual((await pc.call('POST', '/v1/me/password', { current: 'senha-forte-1', next: '123' })).status, 400);
  r = await pc.call('POST', '/v1/me/password', { current: 'senha-forte-1', next: 'nova-senha-2' });
  assert.ok(r.ok, r.error); assert.strictEqual(r.data.signedOut, 1);
  assert.strictEqual((await casa.call('GET', '/v1/me')).status, 401);
  assert.ok((await pc.call('GET', '/v1/me')).ok, 'a sessão atual continua');
  assert.strictEqual((await casa.call('POST', '/v1/login', { username: 'luiz', password: 'senha-forte-1' })).status, 401);

  // esqueci a senha: código de recuperação, uso único, encerra tudo
  const anon = dev('NOVO');
  assert.strictEqual((await anon.call('POST', '/v1/recover', { username: 'luiz', code: 'AAAA-BBBB-CCCC', password: 'outra-senha-3' })).status, 401);
  r = await anon.call('POST', '/v1/recover', { username: '@Luiz', code: codes[3].toLowerCase().replace(/-/g, ' '), password: 'outra-senha-3' });
  assert.ok(r.ok, r.error); assert.strictEqual(r.data.recoveryLeft, 9); anon.token = r.data.token;
  assert.strictEqual((await pc.call('GET', '/v1/me')).status, 401, 'outras sessões caem');
  assert.strictEqual((await anon.call('POST', '/v1/recover', { username: 'luiz', code: codes[3], password: 'x-senha-44' })).status, 401, 'código não vale duas vezes');
  assert.ok((await anon.call('POST', '/v1/login', { username: 'luiz', password: 'outra-senha-3' })).ok);

  // gerar novos códigos invalida os antigos
  assert.strictEqual((await anon.call('POST', '/v1/me/recovery-codes', { password: 'errada' })).status, 401);
  r = await anon.call('POST', '/v1/me/recovery-codes', { password: 'outra-senha-3' });
  assert.strictEqual(r.data.recoveryCodes.length, 10);
  assert.strictEqual((await dev('x').call('POST', '/v1/recover', { username: 'luiz', code: codes[5], password: 'mais-uma-55' })).status, 401);

  // sair de todos os outros
  const a2 = dev('A2'); a2.token = (await a2.call('POST', '/v1/login', { username: 'luiz', password: 'outra-senha-3' })).data.token;
  r = await anon.call('DELETE', '/v1/me/sessions');
  assert.ok(r.data.signedOut >= 2);
  assert.strictEqual((await a2.call('GET', '/v1/me')).status, 401);
  assert.strictEqual((await anon.call('GET', '/v1/me/sessions')).data.sessions.length, 1);

  server.closeStreams(); server.close();
  console.log('ok — conta (senha, recuperação e sessões) passou');
})().catch((e) => { console.error(e); process.exit(1); });
