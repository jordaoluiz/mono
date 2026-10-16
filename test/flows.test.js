// Fluxos: leitura de valores, condições, laços e execução com requisições simuladas.
'use strict';
const assert = require('assert');
const F = require('../src/shared/flows');

(async () => {
  // caminhos
  const obj = { data: { items: [{ id: 7, nome: 'A' }, { id: 9 }], 'com espaço': 1 }, token: 'abc' };
  assert.strictEqual(F.getPath(obj, 'data.items[1].id'), 9);
  assert.strictEqual(F.getPath(obj, '$.token'), 'abc');
  assert.strictEqual(F.getPath(obj, 'data.items.length'), 2);
  assert.strictEqual(F.getPath(obj, 'data.items[-1].id'), 9);
  assert.strictEqual(F.getPath(obj, 'data["com espaço"]'), 1);
  assert.strictEqual(F.getPath(obj, 'nada.aqui'), undefined);

  // XML (SEFAZ)
  const xml = '<soap:Envelope><soap:Body><retConsSitNFe versao="4.00"><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo><protNFe><infProt Id="ID1"><nProt>135240000000001</nProt><cStat>100</cStat></infProt></protNFe></retConsSitNFe></soap:Body></soap:Envelope>';
  assert.strictEqual(F.xmlValue(xml, 'cStat'), '100');
  assert.strictEqual(F.xmlValue(xml, 'protNFe/nProt'), '135240000000001');
  assert.strictEqual(F.xmlValue(xml, 'retConsSitNFe/@versao'), '4.00');
  assert.strictEqual(F.xmlValue(xml, 'infProt/@Id'), 'ID1');
  assert.strictEqual(F.xmlValue(xml, 'cStat[1]'), '100');
  assert.strictEqual(F.xmlValue(xml, 'naoExiste'), undefined);

  // extração
  const res = { ok: true, status: 201, time: 40, headers: [{ key: 'Location', value: '/pedidos/5' }], body: JSON.stringify({ id: 5, itens: [1, 2] }) };
  assert.strictEqual(F.extractOne({ from: 'json', path: 'id' }, res), 5);
  assert.deepStrictEqual(F.extractOne({ from: 'json', path: '' }, res), { id: 5, itens: [1, 2] });
  assert.strictEqual(F.extractOne({ from: 'header', path: 'location' }, res), '/pedidos/5');
  assert.strictEqual(F.extractOne({ from: 'status' }, res), 201);
  assert.strictEqual(F.extractOne({ from: 'regex', path: '"id":(\\d+)' }, res), '5');

  // modelos e condições
  const vars = { pedido: '{"itens":[{"sku":"X"}]}', n: 3, lista: [1, 2], 'res.status': 200 };
  assert.strictEqual(F.resolve('{{pedido.itens[0].sku}}', vars), 'X');
  assert.deepStrictEqual(F.resolve('{{lista}}', vars), [1, 2]);
  assert.strictEqual(F.resolve('total: {{n}} / {{lista}}', vars), 'total: 3 / [1,2]');
  assert.strictEqual(F.resolve('{{faltando}}', vars), undefined);
  assert.strictEqual(F.resolve('a {{faltando}}', vars), 'a {{faltando}}');
  assert.ok(F.compare('200', '==', 200));
  assert.ok(F.compare(10, '>', '9'), 'compara números, não texto');
  assert.ok(!F.compare('abc', '>', 5));
  assert.ok(F.compare([1, 2], 'contains', '2'));
  assert.ok(F.compare('', 'empty'));
  assert.ok(F.compare([], 'empty'));
  assert.ok(F.compare('NF-e 100', 'matches', '\\d{3}'));
  assert.ok(F.evalRules({ match: 'all', rules: [{ left: '{{res.status}}', op: '==', right: '200' }, { left: '{{n}}', op: '>=', right: '3' }] }, vars));
  assert.ok(!F.evalRules({ match: 'all', rules: [{ left: '{{res.status}}', op: '==', right: '200' }, { left: '{{n}}', op: '>', right: '3' }] }, vars));
  assert.ok(F.evalRules({ match: 'any', rules: [{ left: '{{res.status}}', op: '==', right: '500' }, { left: '{{n}}', op: '==', right: '3' }] }, vars));
  assert.deepStrictEqual(F.listOf('a, b\nc'), ['a', 'b', 'c']);
  assert.deepStrictEqual(F.listOf('[{"a":1}]'), [{ a: 1 }]);

  // execução: login → criar pedido → para cada item, consultar → condição
  const flow = F.newFlow('Pedido');
  const start = flow.nodes[0];
  const login = F.newNode('request'); login.ref = { reqId: 'login' }; login.extract = [{ var: 'token', from: 'json', path: 'access_token' }];
  const criar = F.newNode('request'); criar.ref = { reqId: 'criar' }; criar.extract = [{ var: 'pedidoId', from: 'json', path: 'id' }, { var: 'itens', from: 'json', path: 'itens' }];
  const laco = F.newNode('loop'); Object.assign(laco, { mode: 'list', list: '{{itens}}', itemVar: 'item' });
  const consultar = F.newNode('request'); consultar.ref = { reqId: 'consultar' }; consultar.extract = [{ var: 'situacao', from: 'json', path: 'situacao' }];
  const cond = F.newNode('condition'); Object.assign(cond, { rules: [{ left: '{{situacao}}', op: '==', right: 'ok' }] });
  const fim = F.newNode('set'); fim.assign = [{ key: 'resultado', value: 'pedido {{pedidoId}} ok' }];
  flow.nodes.push(login, criar, laco, consultar, cond, fim);
  F.connect(flow, start.id, 'out', login.id);
  F.connect(flow, login.id, 'ok', criar.id);
  F.connect(flow, criar.id, 'ok', laco.id);
  F.connect(flow, laco.id, 'each', consultar.id);
  F.connect(flow, laco.id, 'done', cond.id);
  F.connect(flow, cond.id, 'yes', fim.id);
  assert.deepStrictEqual(F.validate(flow).filter((p) => p.level === 'erro'), []);

  const calls = [];
  const hooks = {
    async request(node, v) {
      calls.push([node.ref.reqId, { ...v }]);
      if (node.ref.reqId === 'login') return { ok: true, status: 200, body: '{"access_token":"T1"}', headers: [] };
      if (node.ref.reqId === 'criar') { assert.strictEqual(v.token, 'T1', 'token passa para a próxima'); return { ok: true, status: 201, body: '{"id":42,"itens":["A","B","C"]}', headers: [] }; }
      return { ok: true, status: 200, body: JSON.stringify({ situacao: v.item === 'C' ? 'ok' : 'pendente' }), headers: [] };
    },
    sleep: async () => {},
  };
  let r = await F.run(flow, hooks, { inicial: 'x' });
  assert.ok(r.ok, r.error);
  assert.deepStrictEqual(calls.map((c) => c[0]), ['login', 'criar', 'consultar', 'consultar', 'consultar']);
  assert.deepStrictEqual(calls.slice(2).map((c) => c[1].item), ['A', 'B', 'C']);
  assert.deepStrictEqual(calls.slice(2).map((c) => c[1].i), [0, 1, 2]);
  assert.strictEqual(r.vars.resultado, 'pedido 42 ok');
  assert.strictEqual(r.vars.inicial, 'x');
  assert.ok(r.steps.find((s) => s.type === 'condition').result);

  // falha sem saída "falhou" interrompe o fluxo
  calls.length = 0;
  const failing = { ...hooks, async request(node, v) { if (node.ref.reqId === 'criar') return { ok: true, failed: true, testsFailed: 1, status: 422, body: '{}', headers: [] }; return hooks.request(node, v); } };
  r = await F.run(flow, failing);
  assert.ok(!r.ok); assert.strictEqual(r.nodeId, criar.id); assert.match(r.error, /teste/);
  // com saída "falhou" ligada, segue por ela
  const tratar = F.newNode('set'); tratar.assign = [{ key: 'erro', value: '{{res.status}}' }];
  flow.nodes.push(tratar); F.connect(flow, criar.id, 'fail', tratar.id);
  r = await F.run(flow, failing);
  assert.ok(r.ok, r.error); assert.strictEqual(r.vars.erro, 422);

  // enquanto: consulta até autorizar, com limite
  const poll = F.newFlow('Polling');
  const p0 = poll.nodes[0];
  const setp = F.newNode('set'); setp.assign = [{ key: 'cStat', value: '105' }];
  const w = F.newNode('loop'); Object.assign(w, { mode: 'while', rules: [{ left: '{{cStat}}', op: '!=', right: '100' }], max: 10, wait: 500 });
  const q = F.newNode('request'); q.ref = { reqId: 'q' }; q.extract = [{ var: 'cStat', from: 'xml', path: 'cStat' }];
  poll.nodes.push(setp, w, q);
  F.connect(poll, p0.id, 'out', setp.id); F.connect(poll, setp.id, 'out', w.id); F.connect(poll, w.id, 'each', q.id);
  let n = 0; const slept = [];
  r = await F.run(poll, { request: async () => ({ ok: true, status: 200, body: `<r><cStat>${++n >= 3 ? 100 : 105}</cStat></r>`, headers: [] }), sleep: async (ms) => slept.push(ms) });
  assert.ok(r.ok, r.error); assert.strictEqual(n, 3); assert.strictEqual(r.vars.cStat, '100'); assert.deepStrictEqual(slept, [500, 500]);
  n = -100;
  r = await F.run(poll, { request: async () => ({ ok: true, status: 200, body: '<r><cStat>105</cStat></r>', headers: [] }), sleep: async () => {} });
  assert.ok(r.ok); assert.match(r.steps.find((s) => s.type === 'loop').note, /limite de 10/);

  // laço sem fim de verdade (ciclo fora de um bloco Repetir) é cortado
  const cyc = F.newFlow('Ciclo'); const a = F.newNode('set'); const b = F.newNode('set');
  cyc.nodes.push(a, b); F.connect(cyc, cyc.nodes[0].id, 'out', a.id); F.connect(cyc, a.id, 'out', b.id); F.connect(cyc, b.id, 'out', a.id);
  r = await F.run(cyc, {});
  assert.ok(!r.ok); assert.match(r.error, /passos/);

  // parar
  let stop = false;
  r = await F.run(flow, { ...hooks, async request(nd, v) { stop = true; return hooks.request(nd, v); }, stopped: () => stop });
  assert.ok(r.stopped);

  // validação
  const bad = F.newFlow('x'); const rq = F.newNode('request'); bad.nodes.push(rq, F.newNode('loop'));
  const probs = F.validate(bad, { reqExists: () => false });
  assert.ok(probs.some((p) => /Escolha a requisição/.test(p.text)));
  assert.ok(probs.some((p) => /Bloco solto/.test(p.text)));
  assert.ok(probs.some((p) => /Ligue o Início/.test(p.text)));
  F.removeNode(flow, laco.id);
  assert.ok(!flow.edges.some((e) => e.from === laco.id || e.to === laco.id));

  console.log('ok — fluxos: caminhos, XML, condições, laços, falhas e execução');
})().catch((e) => { console.error(e); process.exit(1); });
