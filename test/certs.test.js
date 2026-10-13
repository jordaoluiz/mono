// Certificado digital (mTLS com .pfx): node test/certs.test.js
// Sobe um servidor HTTPS local que exige certificado do cliente e um proxy CONNECT.
'use strict';
const assert = require('assert');
const https = require('https');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');
const certs = require('../src/certs');
const H = require('../src/http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-pki-'));
const sh = (c) => execSync(c, { cwd: dir, stdio: 'pipe' });
try {
  sh('openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 2 -subj "/CN=Teste CA"');
  sh('openssl req -newkey rsa:2048 -nodes -keyout srv.key -out srv.csr -subj "/CN=localhost"');
  fs.writeFileSync(path.join(dir, 'san.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1');
  sh('openssl x509 -req -in srv.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out srv.crt -days 2 -extfile san.ext');
  sh('openssl req -newkey rsa:2048 -nodes -keyout cli.key -out cli.csr -subj "/CN=EMPRESA TESTE LTDA:12345678000199"');
  sh('openssl x509 -req -in cli.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out cli.crt -days 2');
  sh('openssl pkcs12 -export -out cli.pfx -inkey cli.key -in cli.crt -passout pass:1234');
} catch (e) { console.log('openssl indisponível — testes de certificado pulados'); process.exit(0); }
const rd = (f) => fs.readFileSync(path.join(dir, f));

(async () => {
  assert.ok(certs.hostMatches('*.fazenda.sp.gov.br', 'https://homologacao.nfe.fazenda.sp.gov.br/ws/x.asmx'));
  assert.ok(certs.hostMatches('nfe.fazenda.sp.gov.br', 'https://nfe.fazenda.sp.gov.br/ws'));
  assert.ok(!certs.hostMatches('nfe.fazenda.sp.gov.br', 'https://outro.gov.br/'));
  assert.ok(!certs.hostMatches('localhost:9999', 'https://localhost:443/'));
  assert.strictEqual(certs.certFor([{ host: 'localhost', path: 'x' }], 'http://localhost/'), null, 'só https');

  const info = certs.inspect(rd('cli.pfx'), '1234');
  assert.ok(info.ok && /EMPRESA TESTE LTDA/.test(info.subject) && info.validTo, JSON.stringify(info));
  assert.strictEqual(certs.inspect(rd('cli.pfx'), 'errada').error, 'Senha do certificado incorreta.');

  const srv = https.createServer({ key: rd('srv.key'), cert: rd('srv.crt'), ca: rd('ca.crt'), requestCert: true, rejectUnauthorized: true }, (req, res) => {
    const peer = req.socket.getPeerCertificate();
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      if (req.url === '/redir') { res.writeHead(302, { Location: '/ok' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/soap+xml' }); res.end(`<ok cn="${peer.subject.CN}" ct="${req.headers['content-type']}" len="${body.length}"/>`);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  let tunnels = 0;
  const proxy = http.createServer();
  proxy.on('connect', (req, sock) => { tunnels++; const [h, p] = req.url.split(':'); const up = net.connect(p, h, () => { sock.write('HTTP/1.1 200 OK\r\n\r\n'); up.pipe(sock); sock.pipe(up); }); up.on('error', () => sock.destroy()); });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

  const soap = '<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body/></soap12:Envelope>';
  const built = H.buildRequest({ method: 'POST', url: `https://localhost:${port}/redir`, body: { type: 'xml', raw: soap } });
  const cfg = { pfx: rd('cli.pfx'), passphrase: '1234', ca: certs.toPem(rd('ca.crt')), sslVerify: true, proxyRules: 'DIRECT' };
  const r1 = await certs.request({ ...built, url: `https://localhost:${port}/ok` }, {}, cfg);
  assert.strictEqual(r1.status, 200);
  assert.match(r1.buffer.toString(), /cn="EMPRESA TESTE LTDA:12345678000199" ct="application\/soap\+xml; charset=utf-8"/);

  const r2 = await certs.request(built, { followRedirects: true }, { ...cfg, proxyRules: `PROXY 127.0.0.1:${proxy.address().port}; DIRECT` });
  assert.strictEqual(r2.status, 200, 'segue redirecionamento pelo túnel do proxy');
  assert.ok(r2.url.endsWith('/ok') && tunnels >= 1);

  await assert.rejects(certs.request({ ...built, url: `https://localhost:${port}/ok` }, {}, { ...cfg, ca: '' }), /não é confiável/);
  const r3 = await certs.request({ ...built, url: `https://localhost:${port}/ok` }, {}, { ...cfg, ca: '', sslVerify: false });
  assert.strictEqual(r3.status, 200, 'verificação SSL desativada');
  await assert.rejects(certs.request({ ...built, url: `https://localhost:${port}/ok` }, {}, { ...cfg, passphrase: 'x' }), /Senha do certificado/);

  srv.close(); proxy.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok — certificado digital (mTLS), SOAP 1.2 e proxy passaram');
})().catch((e) => { console.error(e); process.exit(1); });
