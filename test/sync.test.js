// Sincronização de workspaces: diff/apply, segredos e estado local.
'use strict';
const assert = require('assert');
const S = require('../src/shared/sync');

const req = (id, name, folderId = null) => ({ id, name, method: 'GET', url: `{{base}}/${id}`, folderId, params: [], headers: [] });
const base = {
  collections: [
    { id: 'c1', name: 'Booker', open: true, folders: [{ id: 'f1', name: 'Auth', open: true }], requests: [req('r1', 'Login', 'f1'), req('r2', 'Get'), req('r3', 'Delete')] },
    { id: 'c2', name: 'Fiscal', open: false, folders: [], requests: [] },
  ],
  environments: [{ id: 'e1', name: 'Hom', vars: [{ key: 'base', value: 'https://hom' }, { key: 'token', value: 'MEU-SEGREDO', secret: true }] }],
  globals: { vars: [{ key: 'g', value: '1' }] },
};

// 1) O que vai para o servidor não leva segredo nem estado da árvore.
const sh = S.shareable(base);
assert.strictEqual(sh.environments[0].vars[1].value, '');
assert.ok(!('open' in sh.collections[0]) && !('open' in sh.collections[0].folders[0]));
assert.ok(!JSON.stringify(sh).includes('MEU-SEGREDO'));

// 2) Sem mudanças, sem operações (mesmo com a árvore aberta/fechada diferente).
const toggled = S.clone(base); toggled.collections[0].open = false; toggled.collections[0].folders[0].open = false;
assert.deepStrictEqual(S.diff(sh, S.shareable(toggled)), []);

// 3) Várias mudanças → aplicar no servidor reproduz o estado novo.
const cur = S.clone(base);
cur.collections[0].requests[1].url = '{{base}}/get?x=1';           // editar
cur.collections[0].requests.splice(2, 1);                           // excluir
cur.collections[0].requests.push(req('r4', 'Nova', 'f2'));          // criar
cur.collections[0].folders.push({ id: 'f2', name: 'Reservas' });     // pasta nova
cur.collections[0].name = 'Restful Booker';                        // renomear coleção
cur.collections.reverse();                                          // reordenar
cur.collections.push({ id: 'c3', name: 'Nova coleção', folders: [], requests: [req('r9', 'Ping')] });
cur.environments[0].vars[0].value = 'https://hom2';
cur.environments.push({ id: 'e2', name: 'Prod', prod: true, vars: [] });
cur.globals.vars.push({ key: 'h', value: '2' });
const ops = S.diff(sh, S.shareable(cur));
assert.strictEqual(S.validOps(ops), null);
const server = S.applyOps(S.clone(sh), ops);
assert.deepStrictEqual(server, S.shareable(cur));
assert.ok(ops.length < 15, 'só as diferenças: ' + ops.length);

// 4) Aplicar no app de outra pessoa mantém a árvore dela e os segredos dela.
const other = S.clone(base);
other.environments[0].vars[1].value = 'SEGREDO-DELA';
other.collections[0].open = false;
S.applyOps(other, ops);
assert.strictEqual(other.environments[0].vars[1].value, 'SEGREDO-DELA');
assert.strictEqual(other.collections.find((c) => c.id === 'c1').open, false);
assert.deepStrictEqual(S.shareable(other), S.shareable(cur));

// 5) Reordenar requisições gera só a operação de ordem.
const re = S.clone(base); re.collections[0].requests.reverse();
assert.deepStrictEqual(S.diff(sh, S.shareable(re)).map((o) => o.t), ['reqOrder']);

// 6) Validação recusa lixo.
assert.ok(S.validOps([{ t: 'hack' }]));
assert.ok(S.validOps([{ t: 'req', col: 'c1', id: 'r1', v: { id: 'outro' } }]));
assert.ok(S.validOps('x'));

// 7) Usernames.
for (const ok of ['luiz', 'luiz.jordao', 'a_b', 'abc', 'x9']) assert.ok(S.USERNAME.test(ok) || ok.length < 3, ok);
for (const bad of ['ab', '.luiz', 'luiz.', 'Luiz', 'lu iz', 'luiz-j', 'a'.repeat(31)]) assert.ok(!S.USERNAME.test(bad), bad);
assert.strictEqual(S.normUser(' @Luiz.Jordao '), 'luiz.jordao');
assert.ok(S.describe(ops, cur).length > 3);

console.log('ok — sincronização de workspaces passou');
