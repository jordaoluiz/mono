// GraphQL: schema por introspecção, autocompletar no ponto certo da query, corpo e código gerado.
'use strict';
const assert = require('assert');
const G = require('../src/shared/graphql');
const http = require('../src/http');

const T = (kind, name, ofType) => ({ kind, name: name || null, ofType: ofType || null });
const NN = (t) => T('NON_NULL', null, t), L = (t) => T('LIST', null, t), S = (n) => T('SCALAR', n), O = (n) => T('OBJECT', n);
const intro = { data: { __schema: {
  queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, subscriptionType: null,
  types: [
    { kind: 'OBJECT', name: 'Query', fields: [
      { name: 'nota', args: [{ name: 'chave', type: NN(S('String')) }], type: O('Nota') },
      { name: 'notas', args: [{ name: 'uf', type: S('String') }, { name: 'limite', type: S('Int') }], type: NN(L(NN(O('Nota')))) },
    ] },
    { kind: 'OBJECT', name: 'Mutation', fields: [{ name: 'cancelar', args: [{ name: 'chave', type: NN(S('String')) }], type: O('Evento') }] },
    { kind: 'OBJECT', name: 'Nota', fields: [
      { name: 'chave', args: [], type: NN(S('String')) }, { name: 'valor', args: [], type: S('Float') },
      { name: 'emitente', args: [], type: O('Empresa') }, { name: 'antiga', args: [], type: S('String'), isDeprecated: true },
    ] },
    { kind: 'OBJECT', name: 'Empresa', fields: [{ name: 'cnpj', args: [], type: S('String') }, { name: 'razaoSocial', args: [], type: S('String') }] },
    { kind: 'OBJECT', name: 'Evento', fields: [{ name: 'protocolo', args: [], type: S('String') }] },
    { kind: 'SCALAR', name: 'String' }, { kind: '__Type', name: '__Schema' },
  ],
} } };
const schema = G.fromIntrospection(intro);
assert.strictEqual(schema.query, 'Query');
assert.strictEqual(schema.types.Query.fields.notas.type, '[Nota!]!');
assert.strictEqual(schema.types.Query.fields.notas.base, 'Nota');
assert.ok(!schema.types.__Schema, 'tipos internos fora');
assert.throws(() => G.fromIntrospection({ data: {} }), /introspecção/);

const labels = (r) => (r ? r.items.map((i) => i.label) : []);
// raiz
assert.deepStrictEqual(labels(G.completions(schema, '{ no')), ['nota', 'notas']);
// campo aninhado
assert.deepStrictEqual(labels(G.completions(schema, 'query { notas(uf: "SP") { emitente { ')), ['cnpj', 'razaoSocial', '__typename']);
assert.ok(labels(G.completions(schema, 'query Q($c: String!) { nota(chave: $c) { va')).includes('valor'));
// argumentos
assert.deepStrictEqual(labels(G.completions(schema, '{ notas(li')), ['limite']);
assert.deepStrictEqual(labels(G.completions(schema, '{ notas(uf: "SP", ')), ['uf', 'limite']);
// mutation e alias
assert.deepStrictEqual(labels(G.completions(schema, 'mutation { c: cancelar(chave: "1") { ')), ['protocolo', '__typename']);
// strings e comentários não confundem o contexto
assert.deepStrictEqual(labels(G.completions(schema, '# { teste }\n{ nota(chave: "a { b") { emitente { cn')), ['cnpj']);
// fragmentos
assert.deepStrictEqual(labels(G.completions(schema, 'fragment F on Empresa { ra')), ['razaoSocial']);
assert.deepStrictEqual(labels(G.completions(schema, '{ nota(chave: "1") { ... on Nota { ch')), ['chave']);
// palavras-chave fora de seleção
assert.ok(labels(G.completions(schema, 'mu')).includes('mutation'));
// obsoleto marcado
assert.match(G.completions(schema, '{ nota { an').items[0].detail, /obsoleto/);

// cores
assert.match(G.highlight('query Q($id: ID!) { nota(chave: "x") { valor } } # c'), /c-kw.*query.*j-num.*\$id.*j-str/);
assert.deepStrictEqual(G.operations('query A { x } mutation B { y }').map((o) => o.name), ['A', 'B']);

// corpo enviado: JSON com query, variables e operationName
const built = http.buildRequest({ method: 'POST', url: 'https://api/graphql', headers: [], body: { type: 'graphql', graphql: { query: '{ nota(chave: "{{ch}}") { valor } }', variables: '{"uf":"{{uf}}"}', operationName: '' } } }, { ch: '35', uf: 'SP' });
assert.deepStrictEqual(JSON.parse(built.body), { query: '{ nota(chave: "35") { valor } }', variables: { uf: 'SP' } });
assert.strictEqual(built.headers['Content-Type'], 'application/json');
assert.throws(() => http.buildRequest({ method: 'POST', url: 'https://x', body: { type: 'graphql', graphql: { query: '{a}', variables: '{x' } } }, {}), /variáveis do GraphQL/);
const code = require('../src/shared/codegen').generate('curl', { method: 'POST', url: 'https://api/graphql', headers: [], body: { type: 'graphql', graphql: { query: '{ a }', variables: '' } } });
assert.match(code, /"query"/);

console.log('ok — GraphQL (schema, autocompletar, corpo) passou');
