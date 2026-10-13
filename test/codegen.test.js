// Gerar código: node test/codegen.test.js
'use strict';
const assert = require('assert');
const C = require('../src/shared/codegen');
const req = { method: 'POST', url: 'https://api.x.com/v1/pedidos', params: [{ key: 'q', value: 'a b', enabled: true }], headers: [{ key: 'Accept', value: 'application/json', enabled: true }],
  body: { type: 'json', raw: '{"id":1,"ok":true,"nome":null}' }, auth: { type: 'bearer', token: 'T0K' } };
const cs = C.generate('csharp', req, { types: { code: 'using System.Text.Json.Serialization;\n\npublic record Pedido(\n    [property: JsonPropertyName("id")] int Id\n);\n', root: 'Pedido' } });
assert.ok(cs.startsWith('using System.Net.Http.Headers;'));
assert.ok(cs.includes('new HttpRequestMessage(HttpMethod.Post, "https://api.x.com/v1/pedidos?q=a%20b")'));
assert.ok(cs.includes('request.Headers.TryAddWithoutValidation("Authorization", "Bearer T0K");'));
assert.ok(cs.includes('Encoding.UTF8, "application/json");') && cs.includes('    """\n    {\n      "id": 1,'));
assert.ok(cs.includes('JsonSerializer.Deserialize<Pedido>(json)') && cs.includes('using System.Text.Json.Serialization;') && cs.trim().endsWith(');'));
assert.ok(cs.indexOf('public record Pedido') > cs.indexOf('SendAsync'), 'records depois das instruções (exigência do C#)');

const soap = { method: 'POST', url: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx', headers: [], body: { type: 'xml', raw: '<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"/>' }, auth: { type: 'none' } };
const cert = { path: 'C:\\certs\\empresa.pfx', name: 'empresa.pfx', passphrase: '1234' };
const cs2 = C.generate('csharp', soap, { cert });
assert.ok(cs2.includes('X509CertificateLoader.LoadPkcs12FromFile(@"C:\\certs\\empresa.pfx", "1234")'));
assert.ok(cs2.includes('Encoding.UTF8, "application/soap+xml");'), 'media type sem charset no StringContent');
assert.ok(C.generate('curl', soap, { cert }).includes("--cert-type P12 --cert 'C:\\certs\\empresa.pfx:1234'"));
assert.ok(C.generate('python', soap, { cert }).includes('pkcs12_filename="C:\\\\certs\\\\empresa.pfx"'));

const mp = { method: 'POST', url: 'https://x/up', headers: [{ key: 'Content-Type', value: 'multipart/form-data', enabled: true }], body: { type: 'multipart', multipart: [{ key: 'desc', value: 'nota', enabled: true }, { key: 'arquivo', kind: 'file', file: '/tmp/nota.pdf', fileName: 'nota.pdf', enabled: true }] }, auth: { type: 'basic', username: 'u', password: 'p' } };
const f = C.generate('fetch', mp);
assert.ok(f.includes("form.append(\"arquivo\", await fs.openAsBlob(\"/tmp/nota.pdf\"), \"nota.pdf\");") && !/Content-Type/.test(f), 'multipart sem Content-Type manual (boundary)');
assert.ok(f.includes('"Authorization": "Basic dTpw"'));
const py = C.generate('python', mp);
assert.ok(py.includes('("arquivo", ("nota.pdf", open("/tmp/nota.pdf", "rb"), "application/pdf"))'));
const pa = JSON.parse(C.generate('powerautomate', mp));
assert.strictEqual(pa.operationDefinition.type, 'Http');
assert.deepStrictEqual(pa.operationDefinition.inputs.authentication, { type: 'Basic', username: 'u', password: 'p' });
assert.strictEqual(pa.operationDefinition.inputs.body['$content-type'], 'multipart/form-data');
const pa2 = JSON.parse(C.generate('powerautomate', req));
assert.deepStrictEqual(pa2.operationDefinition.inputs.body, { id: 1, ok: true, nome: null });
const ax = C.generate('axios', { method: 'GET', url: 'https://x/a', headers: [], body: { type: 'none' }, auth: { type: 'apikey', key: 'x-key', value: 'K', in: 'query' } });
assert.ok(ax.includes('url: "https://x/a?x-key=K"'));
assert.ok(C.hostMatches('*.fazenda.sp.gov.br', 'https://nfe.fazenda.sp.gov.br/x'));
console.log('ok — geração de código passou');
