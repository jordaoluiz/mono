// Respostas guardadas por requisição: limite, fixadas, cifragem e corpo grande.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRespLog } = require('../src/resplog');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-resp-'));
const fake = { available: () => true, encrypt: (s) => 'ENC:' + Buffer.from(s).toString('base64'), decrypt: (s) => Buffer.from(s.slice(4), 'base64').toString() };
const log = createRespLog(dir, fake);

const r1 = log.add('req_1', { envId: 'hml', envName: 'Homologação', method: 'GET', url: 'https://x/a', status: 200, time: 10, size: 5, contentType: 'application/json', headers: [{ key: 'a', value: 'b' }], body: '{"a":1}' });
assert.strictEqual(r1.list.length, 1);
assert.ok(!('body' in r1.entry) && r1.entry.hasBody, 'lista não traz o corpo');
const files = fs.readdirSync(dir);
assert.strictEqual(files.length, 1);
assert.ok(fs.readFileSync(path.join(dir, files[0]), 'utf8').startsWith('ENC:'), 'arquivo cifrado');
assert.ok(!fs.readFileSync(path.join(dir, files[0]), 'utf8').includes('"a":1'));

const full = log.get('req_1', [r1.entry.id]);
assert.strictEqual(full[0].body, '{"a":1}');
assert.deepStrictEqual(full[0].headers, [{ key: 'a', value: 'b' }]);

// fixar mantém além do limite
log.update('req_1', r1.entry.id, { pinned: true, label: 'Referência' });
for (let i = 0; i < 25; i++) log.add('req_1', { envName: 'Produção', status: 200, body: `{"i":${i}}` });
let list = log.list('req_1');
assert.strictEqual(list.length, 21);
assert.ok(list.some((e) => e.pinned && e.label === 'Referência'));
assert.strictEqual(log.get('req_1', [list[0].id])[0].body, '{"i":24}', 'mais recente primeiro');

// limpar mantém as fixadas
list = log.clear('req_1');
assert.strictEqual(list.length, 1);

// corpo grande é cortado
const big = log.add('req_2', { status: 200, body: 'x'.repeat(log.MAX_BODY + 10) });
assert.ok(big.entry.truncated);
assert.strictEqual(log.get('req_2', [big.entry.id])[0].body.length, log.MAX_BODY);

// rascunho que vira requisição salva leva as respostas
log.add('GET https://x/b', { status: 404, body: '' });
log.rename('GET https://x/b', 'req_3');
assert.strictEqual(log.list('GET https://x/b').length, 0);
assert.strictEqual(log.list('req_3')[0].status, 404);

// remover a última apaga o arquivo
log.remove('req_3', log.list('req_3')[0].id);
assert.strictEqual(log.list('req_3').length, 0);

// sem cifragem também funciona, e arquivo corrompido não derruba
const plain = createRespLog(path.join(dir, 'p'), null);
plain.add('k', { status: 1, body: 'oi' });
assert.strictEqual(plain.list('k').length, 1);
fs.writeFileSync(fs.readdirSync(path.join(dir, 'p')).map((f) => path.join(dir, 'p', f))[0], 'lixo');
assert.deepStrictEqual(plain.list('k'), []);

fs.rmSync(dir, { recursive: true, force: true });
console.log('ok — respostas guardadas: limite, fixadas, cifragem e corpo grande');
