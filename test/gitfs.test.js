// Coleção como arquivos (Git): ida e volta sem perder nada, diffs estáveis, só mexe nos arquivos do Mono.
'use strict';
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const G = require('../src/shared/gitfs');
const { createGitDir } = require('../src/gitdir');

(async () => {
  const col = {
    id: 'c1', name: 'Fiscal SP', open: true, gitDir: 'C:\\repo', auth: { type: 'bearer', token: '{{token}}' }, pre: '// coleção',
    variables: [{ key: 'uf', value: 'SP' }, { key: 'senha', value: 'segredo!', secret: true }],
    folders: [{ id: 'f1', name: 'NF-e', open: true }, { id: 'f2', name: 'Eventos', parentId: 'f1' }, { id: 'f3', name: 'NF-e', parentId: null }],
    requests: [
      { id: 'r1', name: 'Status do Serviço', method: 'POST', url: '{{base}}/status', folderId: 'f1' },
      { id: 'r2', name: 'Cancelamento', method: 'POST', url: '{{base}}/evento', folderId: 'f2' },
      { id: 'r3', name: 'Status do Serviço', method: 'GET', url: '{{base}}/status2', folderId: 'f1' },
      { id: 'r4', name: 'Ping', method: 'GET', url: '{{base}}/ping', folderId: null },
      { id: 'r5', name: 'Outra', method: 'GET', url: '/x', folderId: 'f3' },
    ],
  };
  const files = G.toFiles(col);
  const paths = files.map((f) => f.path);
  assert.deepStrictEqual(paths, ['mono.collection.json', 'nf-e/status-do-servico.req.json', 'nf-e/eventos/cancelamento.req.json', 'nf-e/status-do-servico-2.req.json', 'ping.req.json', 'nf-e-2/outra.req.json']);
  const meta = JSON.parse(files[0].content);
  assert.ok(!files[0].content.includes('segredo!'), 'segredo não vai para o Git');
  assert.ok(!('open' in meta) && !('gitDir' in meta), 'estado local fora do arquivo');
  assert.ok(files.every((f) => f.content.endsWith('\n')));
  const back = G.fromFiles(files);
  assert.deepStrictEqual(back.requests.map((r) => r.id), ['r1', 'r2', 'r3', 'r4', 'r5']);
  assert.deepStrictEqual(back.folders.map((f) => f.id), ['f1', 'f2', 'f3']);
  assert.strictEqual(back.auth.token, '{{token}}');
  assert.strictEqual(G.fingerprint(col), G.fingerprint({ ...col, open: false }), 'abrir/fechar a árvore não regrava');
  assert.throws(() => G.fromFiles([{ path: 'x.req.json', content: '{}' }]), /mono\.collection\.json/);
  assert.throws(() => G.fromFiles([files[0], { path: 'a.req.json', content: '<<<<<<< HEAD' }]), /conflito de merge/);

  // pasta de verdade
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-git-'));
  fs.mkdirSync(path.join(dir, '.git')); fs.writeFileSync(path.join(dir, 'README.md'), 'meu projeto');
  const changes = [];
  const allowed = new Set([path.resolve(dir)]);
  const g = createGitDir({ isAllowed: (p) => allowed.has(p), onChange: (e) => changes.push(e) });
  assert.throws(() => g.write(os.tmpdir(), files), /Escolha a pasta/);
  let r = g.write(dir, files);
  assert.strictEqual(r.written, 6);
  assert.strictEqual(g.write(dir, files).written, 0, 'nada mudou, nada gravado');
  assert.deepStrictEqual(G.fromFiles(g.read(dir)).requests.map((x) => x.id), ['r1', 'r2', 'r3', 'r4', 'r5']);
  // renomear requisição: arquivo antigo some, outros arquivos do projeto ficam
  const col2 = JSON.parse(JSON.stringify(col)); col2.requests[3].name = 'Ping v2'; col2.requests.splice(1, 1);
  r = g.write(dir, G.toFiles(col2));
  assert.strictEqual(r.removed, 2);
  assert.ok(fs.existsSync(path.join(dir, 'README.md')) && fs.existsSync(path.join(dir, '.git')));
  assert.ok(!fs.existsSync(path.join(dir, 'nf-e', 'eventos')), 'pasta vazia removida');
  assert.throws(() => g.write(dir, [{ path: '../fora.req.json', content: '{}' }]), /fora da pasta/);
  assert.throws(() => g.write(dir, [{ path: 'virus.exe', content: 'x' }]), /não gerenciado/);
  // mudança externa (git pull) é avisada; a própria gravação não
  g.watch(dir);
  await new Promise((res) => setTimeout(res, 100));
  g.write(dir, G.toFiles(col));
  await new Promise((res) => setTimeout(res, 1000));
  const own = changes.length;
  await new Promise((res) => setTimeout(res, 800));
  fs.writeFileSync(path.join(dir, 'ping.req.json'), JSON.stringify({ id: 'r4', name: 'Ping (do colega)', method: 'GET', url: '/p' }));
  await new Promise((res) => setTimeout(res, 1200));
  assert.strictEqual(own, 0, 'gravação do Mono não dispara aviso');
  assert.ok(changes.length >= 1, 'mudança externa avisada');
  assert.strictEqual(G.fromFiles(g.read(dir)).requests.find((x) => x.id === 'r4').name, 'Ping (do colega)');
  g.closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok — coleções como arquivos (Git) passaram');
})().catch((e) => { console.error(e); process.exit(1); });
