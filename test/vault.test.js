// Cofre de segredos: criptografia de ponta a ponta e regras do servidor.
'use strict';
const assert = require('assert');
const V = require('../src/shared/vaultcrypto');
const S = require('../src/shared/sync');
const { createApp } = require('../server/app');
const { createMemoryDb } = require('../server/db-memory');
const { createCloud } = require('../src/cloud');

(async () => {
  // chaves de pessoa + backup com senha
  const ana = await V.generateUserKeys(), bia = await V.generateUserKeys();
  assert.strictEqual(await V.publicOf(ana.privateKey), ana.publicKey);
  const bk = await V.backupPrivate(ana.privateKey, 'senha-da-ana');
  assert.ok(!JSON.stringify(bk).includes(JSON.parse(ana.privateKey).d), 'backup não expõe a chave');
  assert.strictEqual(await V.restorePrivate(bk, 'senha-da-ana'), ana.privateKey);
  await assert.rejects(() => V.restorePrivate(bk, 'errada'), /Senha não abre/);

  // chave do cofre embrulhada para cada membro
  const vk = V.newVaultKey();
  const forBia = await V.wrapKey(vk.raw, vk.kid, bia.publicKey);
  assert.strictEqual(forBia.fp, await V.fingerprint(bia.publicKey));
  assert.strictEqual(await V.unwrapKey(forBia, bia.privateKey), vk.raw);
  await assert.rejects(() => V.unwrapKey(forBia, ana.privateKey), /não foi embrulhada/, 'Ana não abre a chave da Bia');
  const tampered = { ...forBia, kid: 'outro' };
  await assert.rejects(() => V.unwrapKey(tampered, bia.privateKey), 'kid faz parte da autenticação');

  // segredo cifrado e aberto
  const key = await V.importVaultKey(vk.raw);
  const sealed = await V.sealValue(key, vk.kid, 'Bearer eyJ-segredo');
  assert.ok(!JSON.stringify(sealed).includes('eyJ'));
  assert.strictEqual(await V.openValue(key, sealed), 'Bearer eyJ-segredo');
  const other = await V.importVaultKey(V.newVaultKey().raw);
  await assert.rejects(() => V.openValue(other, sealed));
  assert.notStrictEqual(V.quickFp('a'), V.quickFp('b'));

  // sync: o valor some, o cifrado viaja, e quem recebe mantém o próprio valor e o controle local
  const local = { environments: [{ id: 'e', name: 'Hom', vars: [{ key: 'token', value: 'Bearer eyJ-segredo', secret: true, vault: sealed, _vct: sealed.ct, _vfp: V.quickFp('Bearer eyJ-segredo') }] }] };
  const sh = S.shareable(local);
  assert.deepStrictEqual(sh.environments[0].vars[0], { key: 'token', value: '', secret: true, vault: sealed });
  const theirs = { environments: [{ id: 'e', name: 'Hom', vars: [{ key: 'token', value: 'valor-antigo', secret: true, _vct: 'x' }] }] };
  S.applyOps(theirs, [{ t: 'env', id: 'e', v: sh.environments[0] }]);
  assert.strictEqual(theirs.environments[0].vars[0].value, 'valor-antigo');
  assert.strictEqual(theirs.environments[0].vars[0]._vct, 'x');
  assert.deepStrictEqual(theirs.environments[0].vars[0].vault, sealed, 'cifrado chega para abrir');

  // servidor: guarda só material cifrado; regras de quem pode o quê
  const db = createMemoryDb(); await db.init();
  const server = createApp({ db });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = () => { const c = createCloud({ fetchImpl: fetch, emit: () => {} }); return { token: null, call(m, p, b) { return c.call({ url, token: this.token, method: m, path: p, body: b }); } }; };
  const A = client(), B = client(), C = client();
  for (const [u, n] of [[A, 'ana'], [B, 'bia'], [C, 'caio']]) { const r = await u.call('POST', '/v1/register', { username: n, password: 'senha-forte-1' }); u.token = r.data.token; u.id = r.data.user.id; }
  assert.ok((await A.call('PATCH', '/v1/me', { publicKey: ana.publicKey, keyBackup: bk })).ok);
  assert.strictEqual((await A.call('PATCH', '/v1/me', { keyBackup: { salt: 'x', iv: '<script>', ct: 'y' } })).status, 400);
  assert.deepStrictEqual((await A.call('GET', '/v1/me')).data.keyBackup, bk, 'backup volta só para a dona');
  assert.ok((await B.call('PATCH', '/v1/me', { publicKey: bia.publicKey })).ok);
  assert.ok(!JSON.stringify((await B.call('GET', `/v1/profiles?ids=${A.id}`)).data).includes('salt'), 'perfil não expõe o backup');
  const ws = (await A.call('POST', '/v1/workspaces', { name: 'T', data: {} })).data.workspace;
  for (const u of [B, C]) {
    await A.call('POST', `/v1/workspaces/${ws.id}/invites`, { username: u === B ? 'bia' : 'caio' });
    const inv = (await u.call('GET', '/v1/invites')).data.invites[0];
    await u.call('POST', `/v1/invites/${inv.id}/accept`);
  }
  // Ana liga o cofre com a chave dela e a da Bia (Caio ainda não tem chave pública)
  const k1 = V.newVaultKey();
  let r = await A.call('PUT', `/v1/workspaces/${ws.id}/vault`, { replace: true, kid: k1.kid, keys: { [A.id]: await V.wrapKey(k1.raw, k1.kid, ana.publicKey), [B.id]: await V.wrapKey(k1.raw, k1.kid, bia.publicKey) } });
  assert.ok(r.ok, r.error);
  const vb = (await B.call('GET', `/v1/workspaces/${ws.id}/vault`)).data.vault;
  assert.strictEqual(await V.unwrapKey(vb.myKey, bia.privateKey), k1.raw);
  assert.strictEqual((await C.call('GET', `/v1/workspaces/${ws.id}/vault`)).data.vault.myKey, null);
  // Caio publica a chave; Bia (que tem a chave do cofre) embrulha para ele
  const caio = await V.generateUserKeys();
  await C.call('PATCH', '/v1/me', { publicKey: caio.publicKey });
  r = await B.call('PUT', `/v1/workspaces/${ws.id}/vault`, { keys: { [C.id]: await V.wrapKey(k1.raw, k1.kid, caio.publicKey) } });
  assert.ok(r.ok, r.error);
  assert.strictEqual(await V.unwrapKey((await C.call('GET', `/v1/workspaces/${ws.id}/vault`)).data.vault.myKey, caio.privateKey), k1.raw);
  assert.strictEqual((await B.call('PUT', `/v1/workspaces/${ws.id}/vault`, { keys: { usr_x: forBia } })).status, 400, 'só para membros');
  assert.strictEqual((await B.call('PUT', `/v1/workspaces/${ws.id}/vault`, { keys: { [C.id]: { ...forBia, kid: 'velha' } } })).status, 409);
  // remover o Caio marca para girar a chave
  await A.call('DELETE', `/v1/workspaces/${ws.id}/members/${C.id}`);
  let va = (await A.call('GET', `/v1/workspaces/${ws.id}/vault`)).data.vault;
  assert.ok(va.needsRotation); assert.ok(!va.keys[C.id]);
  const k2 = V.newVaultKey();
  assert.strictEqual((await A.call('PUT', `/v1/workspaces/${ws.id}/vault`, { replace: true, prevKid: 'errado', kid: k2.kid, keys: { [A.id]: await V.wrapKey(k2.raw, k2.kid, ana.publicKey) } })).status, 409);
  r = await A.call('PUT', `/v1/workspaces/${ws.id}/vault`, { replace: true, prevKid: k1.kid, kid: k2.kid, keys: { [A.id]: await V.wrapKey(k2.raw, k2.kid, ana.publicKey), [B.id]: await V.wrapKey(k2.raw, k2.kid, bia.publicKey) } });
  assert.ok(r.ok, r.error); assert.ok(!r.data.vault.needsRotation);
  assert.strictEqual((await B.call('PUT', `/v1/workspaces/${ws.id}/vault`, { enabled: false })).status, 403, 'só a dona desliga');
  // nada em claro no banco
  const raw = JSON.stringify(await db.getWorkspace(ws.id)) + JSON.stringify(await db.userByName('ana'));
  assert.ok(!raw.includes(k1.raw) && !raw.includes(k2.raw) && !raw.includes(JSON.parse(ana.privateKey).d));

  server.close();
  console.log('ok — cofre de segredos (ponta a ponta) passou');
})().catch((e) => { console.error(e); process.exit(1); });
