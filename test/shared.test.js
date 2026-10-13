// Testes dos módulos puros: node test/shared.test.js
'use strict';
const assert = require('assert');
const Shape = require('../src/shared/shape');
const Typegen = require('../src/shared/typegen');
const OA = require('../src/shared/openapi');

// ---------- Forma e diffs ----------
const v1 = { id: 1, nome: 'Ana', ativo: true, saldo: 10.5, tags: ['a'], endereco: { cidade: 'BH' }, itens: [{ sku: 'x', qtd: 1 }, { sku: 'y', qtd: 2, obs: null }] };
const v2 = { id: '1', nome: 'Ana', saldo: null, tags: ['a', 'b'], endereco: { cidade: 'BH', uf: 'MG' }, itens: [{ sku: 'x', qtd: 1.5 }] };

const s1 = Shape.inferShape(v1);
assert.strictEqual(s1.props.itens.s.items.props.obs.optional, true, 'campo ausente em parte do array vira opcional');
assert.strictEqual(s1.props.itens.s.items.props.obs.s.t, 'null');

const changes = Shape.diffShape(s1, Shape.inferShape(v2));
const byPath = Object.fromEntries(changes.map((c) => [c.path, c.kind]));
assert.strictEqual(byPath['$.id'], 'type', 'id number -> string');
assert.strictEqual(byPath['$.ativo'], 'removed');
assert.strictEqual(byPath['$.endereco.uf'], 'added');
assert.ok(!('$.itens[].qtd' in byPath), 'integer -> number não é quebra');
assert.ok(!('$.saldo' in byPath) || byPath['$.saldo'] !== 'type', 'virar null não é troca de tipo');

const d = Shape.diffJson(v1, v2);
const dk = Object.fromEntries(d.map((x) => [x.path, x.kind]));
assert.strictEqual(dk['$.id'], 'type');
assert.strictEqual(dk['$.ativo'], 'removed');
assert.strictEqual(dk['$.endereco.uf'], 'added');
assert.strictEqual(dk['$.tags'], 'length');
assert.strictEqual(dk['$.itens[0].qtd'], 'changed');
assert.deepStrictEqual(Shape.diffJson({ a: [1, 2] }, { a: [1, 2] }), []);
assert.strictEqual(Shape.diffLines('a\nb', 'a\nc')[0].path, 'linha 2');

// ---------- Geração de tipos ----------
const sample = { id: 42, nome: 'Luiz', criado_em: '2026-10-12T10:00:00Z', uid: '7c9e6679-7425-40de-944b-e07fc1f90ae7', saldo: 1290.5, big: 9007199254740, ativo: true,
  endereco: { cidade: 'Belo Horizonte', uf: 'MG' }, pedidos: [{ codigo: 'A1', total: 10 }, { codigo: 'A2', total: 12.5, cupom: null }], 'x-meta': null, dados: [] };
const ts = Typegen.toTypeScript(sample, 'Usuário');
assert.ok(ts.includes('export interface Usuario {'), ts);
assert.ok(ts.includes('export interface Endereco {'));
assert.ok(ts.includes('export interface Pedido {'));
assert.ok(ts.includes('pedidos: Pedido[];'));
assert.ok(ts.includes('cupom?: null;'));
assert.ok(ts.includes('"x-meta": null;'));
const zod = Typegen.toZod(sample, 'Usuario');
assert.ok(zod.indexOf('EnderecoSchema = z.object') < zod.indexOf('UsuarioSchema = z.object'), 'filhos antes do pai no Zod');
assert.ok(zod.includes('criado_em: z.string().datetime({ offset: true }),'));
assert.ok(zod.includes('uid: z.string().uuid(),'));
assert.ok(zod.includes('id: z.number().int(),'));
const cs = Typegen.toCSharp(sample, 'Usuario');
assert.ok(cs.includes('public record Usuario('), cs);
assert.ok(cs.includes('[property: JsonPropertyName("criado_em")] DateTimeOffset CriadoEm'));
assert.ok(cs.includes('Guid Uid'));
assert.ok(cs.includes('long Big'));
assert.ok(cs.includes('List<Pedido> Pedidos'));
assert.ok(cs.includes('double Total'), 'int + double no array vira double');
assert.ok(cs.includes('object? Cupom'));
assert.ok(cs.includes('using System.Text.Json;'), 'JsonElement exige using');
assert.ok(Typegen.toTypeScript([{ a: 1 }], 'Lista').includes('export type Lista = ListaItem[];') || Typegen.toTypeScript([{ a: 1 }], 'Lista').includes('export type Lista ='));

// ---------- OpenAPI 3 ----------
const spec3 = {
  openapi: '3.0.3', info: { title: 'Kit Demissional', version: '1.2' },
  servers: [{ url: '/api' }],
  paths: {
    '/usuarios/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', example: 7 } }],
      get: { summary: 'Buscar usuário', tags: ['Usuarios'], parameters: [{ name: 'expand', in: 'query', schema: { type: 'string' } }],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Usuario' } } } }, 404: { $ref: '#/components/responses/NotFound' } } },
      delete: { operationId: 'removerUsuario', responses: { 204: { description: 'sem corpo' } } },
    },
    '/usuarios': {
      post: { summary: 'Criar', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/NovoUsuario' } } } }, responses: { 201: { description: 'criado' } } },
    },
  },
  components: {
    schemas: {
      Base: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      Usuario: { allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', required: ['nome', 'status'], properties: {
        nome: { type: 'string' }, status: { type: 'string', enum: ['ativo', 'inativo'] }, email: { type: 'string', nullable: true },
        perfis: { type: 'array', items: { $ref: '#/components/schemas/Perfil' } } } }] },
      Perfil: { type: 'object', properties: { codigo: { type: 'string' } } },
      NovoUsuario: { type: 'object', properties: { nome: { type: 'string', example: 'Ana' }, nascimento: { type: 'string', format: 'date' }, id: { type: 'integer', readOnly: true } } },
    },
    responses: { NotFound: { description: 'nf', content: { 'application/json': { schema: { type: 'object', properties: { erro: { type: 'string' } } } } } } },
  },
};
const parsed = OA.parseSpec(spec3, 'https://hom.exemplo.dev/swagger/v1/swagger.json');
assert.strictEqual(parsed.title, 'Kit Demissional');
assert.strictEqual(parsed.baseUrl, 'https://hom.exemplo.dev/api');
assert.strictEqual(parsed.requests.length, 3);
const get = parsed.requests.find((r) => r.method === 'GET');
assert.strictEqual(get.url, '{{baseUrl}}/usuarios/7');
assert.deepStrictEqual(get.params, [{ key: 'expand', value: '', enabled: false }]);
const del = parsed.requests.find((r) => r.method === 'DELETE');
assert.strictEqual(del.name, 'removerUsuario');
const post = parsed.requests.find((r) => r.method === 'POST');
assert.deepStrictEqual(JSON.parse(post.body.raw), { nome: 'Ana', nascimento: '2026-01-01' }, 'readOnly fica fora do body');

const good = OA.checkResponse(spec3, { method: 'get', path: '/usuarios/{id}' }, 200, JSON.stringify({ id: 7, nome: 'Ana', status: 'ativo', email: null, perfis: [{ codigo: 'adm' }] }));
assert.strictEqual(good.status, 'ok', JSON.stringify(good));
const bad = OA.checkResponse(spec3, { method: 'get', path: '/usuarios/{id}' }, 200, JSON.stringify({ id: '7', status: 'bloqueado', extra: 1, perfis: [{ codigo: 3 }] }));
assert.strictEqual(bad.status, 'mismatch');
const msgs = bad.issues.map((i) => `${i.path} ${i.msg}`).join('\n');
assert.ok(/\$\.nome campo obrigatório ausente/.test(msgs), msgs);
assert.ok(/\$\.id esperado integer, veio string/.test(msgs), msgs);
assert.ok(/\$\.status valor "bloqueado" fora do enum/.test(msgs), msgs);
assert.ok(/\$\.extra campo não documentado/.test(msgs), msgs);
assert.ok(/\$\.perfis\[0\]\.codigo esperado string, veio integer/.test(msgs), msgs);
assert.strictEqual(OA.checkResponse(spec3, { method: 'get', path: '/usuarios/{id}' }, 404, '{"erro":"x"}').status, 'ok', 'resposta via $ref de components/responses');
assert.strictEqual(OA.checkResponse(spec3, { method: 'get', path: '/usuarios/{id}' }, 500, '{}').status, 'undocumented');
assert.strictEqual(OA.checkResponse(spec3, { method: 'delete', path: '/usuarios/{id}' }, 204, '').status, 'ok');

// ---------- Swagger 2 ----------
const spec2 = { swagger: '2.0', info: { title: 'Legado' }, host: 'api.legado.com', basePath: '/v1', schemes: ['https'],
  paths: { '/pedidos': { post: { parameters: [{ in: 'body', name: 'b', schema: { $ref: '#/definitions/Pedido' } }],
    responses: { 200: { schema: { type: 'array', items: { $ref: '#/definitions/Pedido' } } } } } } },
  definitions: { Pedido: { type: 'object', required: ['codigo'], properties: { codigo: { type: 'string' }, total: { type: 'number', 'x-nullable': true } } } } };
const p2 = OA.parseSpec(spec2);
assert.strictEqual(p2.baseUrl, 'https://api.legado.com/v1');
assert.deepStrictEqual(JSON.parse(p2.requests[0].body.raw), { codigo: 'string', total: 0 });
assert.strictEqual(OA.checkResponse(spec2, { method: 'post', path: '/pedidos' }, 200, '[{"codigo":"A","total":null}]').status, 'ok');
assert.strictEqual(OA.checkResponse(spec2, { method: 'post', path: '/pedidos' }, 200, '[{"total":1}]').status, 'mismatch');
assert.throws(() => OA.parseSpec({ hello: 1 }), /OpenAPI/);

// Ciclo de $ref não pode travar
const cyc = { openapi: '3.0.0', paths: { '/n': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/No' } } } } } } } },
  components: { schemas: { No: { type: 'object', properties: { filho: { $ref: '#/components/schemas/No' } } } } } };
assert.strictEqual(OA.checkResponse(cyc, { method: 'get', path: '/n' }, 200, '{"filho":{"filho":{}}}').status, 'ok');
OA.parseSpec(cyc);

console.log('ok — módulos compartilhados passaram');
module.exports = { sample, ts, zod, cs };

// ---------- Formatação HTML/XML ----------
const Format = require('../src/shared/format');
const html = '<!doctype html><html itemscope="" lang="pt-BR"><head><meta content="text/html; charset=UTF-8" http-equiv="Content-Type"><title>Google</title><style>body{margin:0;color:#fff}.a,.b{display:flex}</style><script nonce="x">(function(){var a="<b>";if(a>1){}})();</script></head><body><div class="main"><p>Olá <b>mundo</b></p><br><img src="a.png" alt="x>y"><input type="text"></div><!-- fim --></body></html>';
const fh = Format.formatMarkup(html).split('\n');
assert.strictEqual(fh[0], '<!doctype html>');
assert.strictEqual(fh[1], '<html itemscope="" lang="pt-BR">');
assert.strictEqual(fh[2], '    <head>');
assert.ok(fh.includes('        <title>Google</title>'), fh.join('\n'));
assert.ok(fh.includes('                margin: 0;') && fh.includes('            .a, .b {'), 'CSS formatado dentro de <style>');
assert.ok(fh.includes('            (function(){var a="<b>";if(a>1){}})();'), 'script preservado e indentado');
assert.ok(fh.includes('            <img src="a.png" alt="x>y">'), 'atributo com > não quebra a tag');
assert.ok(fh.includes('                <b>mundo</b>'), fh.join('\n'));
assert.strictEqual(fh[fh.length - 1], '</html>');
const fx = Format.formatMarkup('<?xml version="1.0"?><a><b x="1"/><c>texto</c><d><e/></d></a>', { xml: true }).split('\n');
assert.deepStrictEqual(fx, ['<?xml version="1.0"?>', '<a>', '    <b x="1"/>', '    <c>texto</c>', '    <d>', '        <e/>', '    </d>', '</a>']);
assert.strictEqual(Format.detect('text/html; charset=utf-8', ''), 'html');
assert.strictEqual(Format.detect('', '{"a":1}'), 'json');
assert.strictEqual(Format.detect('application/xml', '<a/>'), 'xml');
console.log('ok — formatação passou');

// Conteúdo vale mais que o Content-Type quando é inequívoco
assert.strictEqual(Format.detect('application/json', '<!doctype html><html><body>erro</body></html>'), 'html');
assert.strictEqual(Format.detect('text/plain', '{"a":1}'), 'json');
assert.strictEqual(Format.detect('application/json', '<div>erro</div>'), 'html');
assert.strictEqual(Format.detect('text/html', '<?xml version="1.0"?><a/>'), 'xml');
assert.strictEqual(Format.sniff('texto'), null);
console.log('ok — detecção de linguagem passou');
