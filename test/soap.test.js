// SOAP: WSDL, C14N e assinatura XML — node test/soap.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');
const X = require('../src/shared/xml');
const W = require('../src/shared/wsdl');
const O = require('../src/shared/overview');
const D = require('../src/shared/apidocs');

// ---------- XML / C14N ----------
const d = X.parse('<?xml version="1.0"?>\r\n<a xmlns="urn:1" xmlns:p="urn:p"><b p:y="2" x="1&amp;&#xA;">t &lt; &gt;<c/></b><!--x--></a>');
const b = X.find(d.root, 'b');
assert.strictEqual(X.c14n(b), '<b xmlns="urn:1" xmlns:p="urn:p" x="1&amp;&#xA;" p:y="2">t &lt; &gt;<c></c></b>');
assert.throws(() => X.parse('<a><b></a>'), /esperado <\/b>/);
const m = X.parse('<r>\n  <s> x </s>\n  <t/>\n</r>'); X.minify(m);
assert.strictEqual(X.serialize(m), '<r><s> x </s><t/></r>');

// ---------- WSDL ----------
const sefaz = fs.readFileSync(path.join(__dirname, 'fixtures/nfestatusservico4.wsdl'), 'utf8');
assert.ok(W.isWsdl(sefaz));
const ms = W.fromWsdl(sefaz, 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx?wsdl');
assert.strictEqual(ms.endpoints.length, 1, 'SOAP 1.2 escolhido no lugar do 1.1 (mesmo portType)');
const ep = ms.endpoints[0];
assert.strictEqual(ep.url, '{{baseUrl}}/ws/nfestatusservico4.asmx');
assert.strictEqual(ms.baseUrl, 'https://homologacao.nfe.fazenda.sp.gov.br');
assert.ok(ep.headers[0].value.startsWith('application/soap+xml; charset=utf-8; action="http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4/nfeStatusServicoNF"'));
const env = X.parse(ep.body.raw);
assert.strictEqual(X.nsUri(env.root), 'http://www.w3.org/2003/05/soap-envelope');
const cons = X.find(env.root, 'consStatServ');
assert.strictEqual(X.nsUri(cons), 'http://www.portalfiscal.inf.br/nfe');
assert.strictEqual(X.text(X.find(cons, 'xServ')), 'STATUS');
const ov = O.buildOverview(ms);
assert.ok(/webservice SOAP 1\.2 com 1 operação/.test(ov.purpose), ov.purpose);
assert.ok(ov.authLines[0].includes('certificado digital'));

const calc = fs.readFileSync(path.join(__dirname, 'fixtures/calculator.wsdl'), 'utf8');
const mc = W.fromWsdl(calc, 'http://www.dneonline.com/calculator.asmx?wsdl');
assert.deepStrictEqual(mc.endpoints.map((e) => e.name), ['Add', 'CriarCliente']);
const add = mc.endpoints[0];
assert.deepStrictEqual(add.headers.map((h) => h.key), ['Content-Type', 'SOAPAction']);
assert.strictEqual(add.headers[1].value, '"http://tempuri.org/Add"');
const addEnv = X.parse(add.body.raw);
const addEl = X.find(addEnv.root, 'Add');
assert.strictEqual(X.nsUri(addEl), 'http://tempuri.org/');
assert.strictEqual(X.nsUri(X.find(addEl, 'intA')), 'http://tempuri.org/', 'elementos qualificados herdam o namespace');
const cli = X.find(X.parse(mc.endpoints[1].body.raw).root, 'cliente');
assert.strictEqual(X.attr(cli, 'id'), '?');
assert.strictEqual(X.text(X.find(cli, 'Tipo')), 'Fisica', 'enumeração usa o primeiro valor');
assert.ok(mc.endpoints[1].body.raw.includes('<!--Zero ou mais repetições:-->'));
const col = D.buildCollection(mc, (() => { let n = 0; return (p) => p + ++n; })()).collection;
assert.strictEqual(col.requests[0].body.type, 'xml');
assert.strictEqual(col.requests[0].method, 'POST');

// ---------- Assinatura XMLDSig ----------
let dir;
try {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-sig-'));
  const sh = (c) => execSync(c, { cwd: dir, stdio: 'pipe' });
  sh('openssl req -x509 -newkey rsa:2048 -nodes -keyout k.pem -out c.pem -days 2 -subj "/CN=EMPRESA TESTE:12345678000199"');
  sh('openssl pkcs12 -export -out a.pfx -inkey k.pem -in c.pem -passout pass:1234');
} catch { console.log('ok — WSDL e XML passaram (openssl indisponível: assinatura não testada)'); process.exit(0); }
const S = require('../src/xmlsign');
const pfx = fs.readFileSync(path.join(dir, 'a.pfx'));
const nfe = '<enviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">\n <idLote>1</idLote>\n <NFe><infNFe Id="NFe1" versao="4.00"><ide><natOp>Venda &amp; Cia</natOp></ide></infNFe></NFe>\n</enviNFe>';
const signed = S.sign(nfe, { tag: 'infNFe', pfx, passphrase: '1234' });
assert.ok(!/\n/.test(signed), 'formatação removida (SEFAZ)');
assert.ok(/<\/infNFe><Signature xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#"><SignedInfo>/.test(signed), 'assinatura logo após o elemento, no padrão');
assert.ok(signed.includes('<Reference URI="#NFe1">') && signed.includes('rsa-sha1'));
assert.ok(S.verify(signed).ok);
// digest confere com o C14N esperado do infNFe
const expectedC14n = '<infNFe xmlns="http://www.portalfiscal.inf.br/nfe" Id="NFe1" versao="4.00"><ide><natOp>Venda &amp; Cia</natOp></ide></infNFe>';
assert.ok(signed.includes(`<DigestValue>${crypto.createHash('sha1').update(expectedC14n).digest('base64')}</DigestValue>`));
assert.ok(!S.verify(signed.replace('Venda &amp; Cia', 'Venda alterada')).ok, 'adulteração detectada');
const soap = `<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soap12:Body><nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4"><envEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><evento versao="1.00"><infEvento Id="ID1"><x>1</x></infEvento></evento></envEvento></nfeDadosMsg></soap12:Body></soap12:Envelope>`;
const s2 = S.sign(soap, { tag: 'infEvento', pfx, passphrase: '1234' });
const c14nEvento = '<infEvento xmlns="http://www.portalfiscal.inf.br/nfe" Id="ID1"><x>1</x></infEvento>';
assert.ok(s2.includes(crypto.createHash('sha1').update(c14nEvento).digest('base64')), 'namespaces do envelope SOAP não entram no digest');
assert.ok(S.verify(s2).ok);
const s3 = S.sign(S.sign('<doc xmlns="urn:x"><a>1</a></doc>', { pfx, passphrase: '1234', alg: 'sha256' }), { pfx, passphrase: '1234', alg: 'sha256' });
assert.strictEqual((s3.match(/<Signature /g) || []).length, 1, 'reassinar substitui a assinatura');
assert.ok(s3.includes('Reference URI=""') && s3.includes('rsa-sha256') && S.verify(s3).ok);
assert.throws(() => S.sign(nfe, { tag: 'infEvento', pfx, passphrase: '1234' }), /Não encontrei <infEvento>/);
assert.throws(() => S.sign(nfe, { tag: 'infNFe', pfx, passphrase: 'x' }), /Senha do certificado incorreta/);
assert.deepStrictEqual(S.candidates(nfe), [{ tag: 'infNFe', count: 1 }]);
// .pfx legado (RC2) também abre
try {
  execSync('openssl pkcs12 -export -legacy -out l.pfx -inkey k.pem -in c.pem -passout pass:1234', { cwd: dir, stdio: 'pipe' });
  assert.ok(S.verify(S.sign(nfe, { tag: 'infNFe', pfx: fs.readFileSync(path.join(dir, 'l.pfx')), passphrase: '1234' })).ok, '.pfx RC2');
} catch (e) { if (e.code === 'ERR_ASSERTION') throw e; }
fs.rmSync(dir, { recursive: true, force: true });
console.log('ok — WSDL, C14N e assinatura XML (XMLDSig) passaram');
