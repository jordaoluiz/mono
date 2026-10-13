// Testes de importação de documentação, visão geral e exportação: node test/docs.test.js
'use strict';
const assert = require('assert');
const D = require('../src/shared/apidocs');
const O = require('../src/shared/overview');
const P = require('../src/shared/postman');
const Y = require('../src/shared/yaml');

let n = 0;
const uid = (p) => `${p}_${++n}`;

// ---------- apiDoc (restful-booker) ----------
const data = require('./fixtures/apidoc_data.json');
const project = require('./fixtures/apidoc_project.json');
assert.strictEqual(D.detectFormat(data), 'apidoc');
assert.strictEqual(D.detectFormat({ api: data }), 'apidoc');
const js = D.parseText('define({ "api": ' + JSON.stringify(data) + ' });');
assert.strictEqual(D.detectFormat(js.value), 'apidoc', 'api_data.js (define) também é aceito');

const m = D.fromApiDoc(data, project, 'https://restful-booker.herokuapp.com/apidoc/api_data.json');
assert.strictEqual(m.baseUrl, 'https://restful-booker.herokuapp.com');
assert.strictEqual(m.endpoints.length, 8);
const ep = (name) => m.endpoints.find((e) => e.name === name);
assert.strictEqual(ep('Create Token').url, '{{baseUrl}}/auth');
assert.deepStrictEqual(JSON.parse(ep('Create Token').body.raw), { username: 'admin', password: 'password123' });
assert.strictEqual(ep('Get Booking').url, '{{baseUrl}}/booking/1', 'caminho vem do exemplo curl');
assert.strictEqual(JSON.parse(ep('Create Booking').body.raw).bookingdates.checkin, '2018-01-01');
assert.strictEqual(ep('Update Booking').authHint.kind, 'cookie-token');
assert.ok(!ep('Update Booking').headers.some((h) => /cookie|authorization/i.test(h.key)), 'cookie vira autenticação, não header solto');
assert.ok(m.authKinds.includes('cookie-token') && m.authKinds.includes('basic'));

const { collection: col, vars } = D.buildCollection(m, uid);
assert.deepStrictEqual(col.folders.map((f) => f.name), ['Auth', 'Booking', 'Ping']);
assert.deepStrictEqual(vars.map((v) => v.key), ['baseUrl', 'token']);
const req = (name) => col.requests.find((r) => r.name === name);
assert.deepStrictEqual(req('Delete Booking').auth, { type: 'apikey', key: 'Cookie', value: 'token={{token}}', in: 'header' });
assert.strictEqual(req('Get Booking').auth.type, 'inherit');
assert.ok(req('Create Token').tests.includes("pm.environment.set('token', body.token)"));
assert.strictEqual(req('Create Booking').folderId, col.folders.find((f) => f.name === 'Booking').id);

// ---------- Visão geral ----------
const ov = O.buildOverview(m);
assert.ok(/Restful-booker é uma API REST com 8 endpoint/.test(ov.purpose), ov.purpose);
assert.ok(ov.purpose.includes('POST /auth'));
assert.ok(ov.capabilities.includes('Auth: obter o token de acesso'), ov.capabilities.join(' | '));
assert.ok(ov.capabilities.some((c) => c.startsWith('Booking: listar, consultar, criar')));
assert.strictEqual(ov.counts.protected, 3);
assert.deepStrictEqual(ov.flow.map((f) => f.label), ['API no ar?', 'obter token', 'criar', 'listar', 'consultar', 'atualizar', 'remover']);
assert.ok(ov.flow.find((f) => f.label === 'atualizar').needsAuth);
const svgA = O.architectureSvg(ov), svgS = O.sequenceSvg(ov);
assert.ok(svgA.startsWith('<svg') && svgA.endsWith('</svg>') && svgA.includes('/booking') && svgA.includes('restful-booker.herokuapp.com'));
assert.ok(svgS.includes('obter token') && svgS.includes('token → {{token}}'));
assert.strictEqual((svgA.match(/<text/g) || []).length, (svgA.match(/<\/text>/g) || []).length, 'SVG bem formado');
const md = O.toMarkdown(ov);
assert.ok(md.includes('## Como usar') && md.includes('| DELETE | `/booking/1` | Delete Booking | sim |'));
assert.ok(O.toHtml(ov).includes('<svg'));

// ---------- Descoberta em páginas HTML ----------
const swaggerUi = `<html><body><div id="swagger-ui"></div><script src="./swagger-initializer.js"></script>
<script>window.ui = SwaggerUIBundle({ url: "/swagger/v1/swagger.json", dom_id: '#swagger-ui' })</script></body></html>`;
const c1 = D.candidatesFromHtml(swaggerUi, 'https://api.kit.dev/docs/index.html').map((c) => c.url);
assert.ok(c1.includes('https://api.kit.dev/swagger/v1/swagger.json'), c1.join(' '));
assert.ok(c1.includes('https://api.kit.dev/docs/swagger-initializer.js'));
const c2 = D.candidatesFromHtml('<redoc spec-url="openapi.yaml"></redoc>', 'https://x.dev/ref/').map((c) => c.url);
assert.deepStrictEqual(c2, ['https://x.dev/ref/openapi.yaml']);
const c3 = D.candidatesFromHtml('<html><body>Loading...<script src="assets/main.bundle.js"></script></body></html>', 'https://restful-booker.herokuapp.com/apidoc/index.html').map((c) => c.url);
assert.strictEqual(c3[0], 'https://restful-booker.herokuapp.com/apidoc/api_data.json', 'apiDoc: procura api_data.json ao lado da página');
assert.strictEqual(D.apidocProjectUrl(c3[0]), 'https://restful-booker.herokuapp.com/apidoc/api_project.json');
assert.ok(D.wellKnown('https://x.dev/docs/').some((c) => c.url === 'https://x.dev/v3/api-docs'));

// ---------- OpenAPI em YAML ----------
const yaml = `openapi: 3.0.3
info:
  title: Pedidos
  version: "2.0"
  description: Gestão de pedidos da loja.
servers:
  - url: https://api.loja.com/v2
security:
  - bearerAuth: []
paths:
  /auth/login:
    post:
      tags: [Auth]
      summary: Login
      security: []
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                email: {type: string, example: a@b.com}
                senha: {type: string, example: "123"}
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  access_token: {type: string}
  /pedidos:
    get:
      tags: [Pedidos]
      summary: Listar pedidos
      responses:
        '200': {description: ok}
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
`;
const py = D.parseText(yaml);
assert.ok(py.yaml && D.detectFormat(py.value) === 'openapi');
const mo = D.fromOpenApi(py.value, 'https://api.loja.com/docs/openapi.yaml', true);
assert.strictEqual(mo.format, 'OpenAPI 3.0.3 (YAML)');
assert.deepStrictEqual(mo.collectionAuth, { type: 'bearer', token: '{{token}}' });
const login = mo.endpoints.find((e) => e.name === 'Login');
assert.deepStrictEqual(login.auth, { type: 'none' }, 'security: [] = público');
assert.ok(login.returnsToken && login.tokenField === 'access_token');
const bo = D.buildCollection(mo, uid);
assert.strictEqual(bo.collection.auth.type, 'bearer');
assert.ok(bo.collection.spec && bo.collection.requests.every((r) => r.contract));
assert.ok(bo.collection.requests.find((r) => r.name === 'Login').tests.includes("pm.environment.set('token', body.access_token)"));
assert.strictEqual(Y.parse('a: "x: y"\nb: |\n  linha\n').a, 'x: y');

// ---------- Postman: importar e exportar ----------
const postman = { info: { name: 'Kit', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
  event: [{ listen: 'prerequest', script: { exec: ["pm.request.headers.upsert({ key: 'X-Col', value: '1' });"] } }],
  variable: [{ key: 'baseUrl', value: 'https://hom.kit.dev' }],
  item: [{ name: 'Usuários', event: [{ listen: 'test', script: { exec: ['pm.test("pasta", () => {});'] } }], item: [{ name: 'Admin', item: [{ name: 'Criar admin', event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => pm.response.to.have.status(201));', 'pm.environment.set("id", pm.response.json().id);'] } }, { listen: 'prerequest', script: { exec: 'pm.variables.set("x", 1);' } }], request: { method: 'POST', header: [{ key: 'X-Id', value: '1' }], url: { raw: '{{baseUrl}}/admin?x=1', query: [{ key: 'x', value: '1' }] }, body: { mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } } } }] }] },
    { name: 'Ping', request: { method: 'GET', url: '{{baseUrl}}/ping', auth: { type: 'noauth' } } }] };
assert.strictEqual(D.detectFormat(postman), 'postman');
const mp = P.fromPostman(postman, 'arquivo.json');
assert.strictEqual(mp.baseUrl, 'https://hom.kit.dev');
assert.deepStrictEqual(mp.endpoints[0].folder, ['Usuários', 'Admin']);
const bp = D.buildCollection(mp, uid);
assert.deepStrictEqual(bp.collection.folders.map((f) => f.name), ['Usuários', 'Admin']);
assert.strictEqual(bp.collection.folders[1].parentId, bp.collection.folders[0].id, 'pastas aninhadas preservadas');
assert.strictEqual(bp.collection.requests[1].auth.type, 'none');
assert.strictEqual(bp.collection.requests[0].tests, 'pm.test("ok", () => pm.response.to.have.status(201));\npm.environment.set("id", pm.response.json().id);', 'scripts do Postman importados');
assert.strictEqual(bp.collection.requests[0].pre, 'pm.variables.set("x", 1);');
assert.ok(bp.collection.pre.includes('X-Col') && bp.collection.folders[0].tests.includes('pasta'), 'scripts de coleção e pasta importados');
assert.deepStrictEqual(bp.collection.variables, [{ key: 'baseUrl', value: 'https://hom.kit.dev', enabled: true }], 'variáveis do Postman ficam na coleção');
assert.ok(!bp.vars.some((v) => v.key === 'baseUrl'), 'sem baseUrl duplicado no ambiente');
const back = P.toPostman(bp.collection, [{ key: 'baseUrl', value: 'https://hom.kit.dev' }, { key: 'token', value: 'segredo', secret: true }]);
assert.strictEqual(back.info.schema, 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
assert.strictEqual(back.item[0].name, 'Usuários');
assert.strictEqual(back.item[0].item[0].item[0].request.body.raw, '{"a":1}');
assert.strictEqual(back.auth.type, 'bearer');
assert.strictEqual(back.variable.find((v) => v.key === 'token').value, '', 'segredos não são exportados');
assert.deepStrictEqual(back.item[0].item[0].item[0].event.map((e) => e.listen), ['prerequest', 'test'], 'scripts exportados como eventos do Postman');
assert.ok(back.event[0].script.exec[0].includes('X-Col') && back.item[0].event[0].listen === 'test');
const round = P.fromPostman(back);
assert.strictEqual(round.endpoints[0].tests, bp.collection.requests[0].tests);
assert.strictEqual(round.endpoints.length, 2, 'export → import mantém as requisições');

// ---------- Formato nativo ----------
const ex = P.exportMono(col, vars);
assert.strictEqual(D.detectFormat(ex), 'mono');
const im = P.importMono(JSON.parse(JSON.stringify(ex)), uid);
assert.notStrictEqual(im.collection.id, col.id);
assert.strictEqual(im.collection.requests.length, col.requests.length);
const fold = im.collection.folders.find((f) => f.name === 'Booking');
assert.strictEqual(im.collection.requests.find((r) => r.name === 'Create Booking').folderId, fold.id, 'ids de pasta remapeados');

console.log('ok — importação de docs, visão geral e exportação passaram');
