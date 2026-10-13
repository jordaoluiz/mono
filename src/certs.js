// Certificado digital do cliente (mTLS) com arquivo .pfx/.p12 — ex.: certificado A1 para webservices da SEFAZ.
// O Chromium (net.request) só usa certificados do repositório do sistema, então as requisições para hosts
// com certificado configurado saem por aqui, pelo https do Node, com o mesmo proxy do app (túnel CONNECT).
'use strict';
const http = require('http');
const https = require('https');
const tls = require('tls');
const zlib = require('zlib');
const crypto = require('crypto');
const pkcs12 = require('./pkcs12');
const pemOf = (der) => `-----BEGIN CERTIFICATE-----\n${Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
// Converte o .pfx em chave + cadeia PEM (lê também .pfx antigos com RC2, que o OpenSSL 3 não abre).
function keyPair(pfx, passphrase) {
  const r = pkcs12.load(pfx, passphrase);
  const chain = [r.cert, ...r.certs.filter((c) => !Buffer.from(c).equals(Buffer.from(r.cert)))];
  return { key: r.key.export({ type: 'pkcs8', format: 'pem' }), cert: chain.map(pemOf).join(''), leaf: r.cert };
}

// "*.sefaz.rs.gov.br", "nfe.fazenda.sp.gov.br", "homologacao.nfe.fazenda.sp.gov.br:443"
function hostMatches(pattern, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const p = String(pattern || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!p) return false;
  const [ph, pport] = p.split(':');
  const host = u.hostname.toLowerCase();
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (pport && pport !== port) return false;
  if (ph.startsWith('*.')) return host === ph.slice(2) || host.endsWith(ph.slice(1));
  return host === ph;
}
function certFor(certs, url) {
  if (!/^https:/i.test(url)) return null;
  return (certs || []).find((c) => c && c.enabled !== false && c.path && hostMatches(c.host, url)) || null;
}

// Lê nome, emissor e validade do .pfx (e valida a senha).
function inspect(pfx, passphrase) {
  try {
    const { leaf } = keyPair(pfx, passphrase || '');
    const x = new crypto.X509Certificate(leaf);
    const validTo = new Date(x.validTo);
    return { ok: true, subject: x.subject.replace(/\n/g, ', '), issuer: x.issuer.replace(/\n/g, ', '), validFrom: new Date(x.validFrom).toISOString(), validTo: validTo.toISOString(), expired: validTo < new Date() };
  } catch (e) {
    return { ok: false, error: /senha/i.test(e.message) ? 'Senha do certificado incorreta.' : e.message };
  }
}

function caList(extraPem) {
  const list = [...tls.rootCertificates];
  try { if (tls.getCACertificates) list.push(...tls.getCACertificates('system')); } catch { /* sem repositório do sistema */ }
  if (extraPem) list.push(String(extraPem));
  return list;
}
// Converte .cer em DER para PEM, se for o caso.
function toPem(buf) {
  if (!buf) return '';
  const s = buf.toString('utf8');
  if (/-----BEGIN CERTIFICATE-----/.test(s)) return s;
  return `-----BEGIN CERTIFICATE-----\n${buf.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
}

// proxy: string do Chromium ("PROXY host:port; DIRECT", "DIRECT", "SOCKS5 …") e credenciais opcionais.
function parseProxy(rules) {
  const first = String(rules || 'DIRECT').split(';')[0].trim();
  const m = first.match(/^(PROXY|HTTPS|SOCKS\d?)\s+([^:\s]+):(\d+)/i);
  if (!m) return null;
  return { kind: m[1].toUpperCase(), host: m[2], port: Number(m[3]) };
}
function tunnel(proxy, target, auth, signal) {
  return new Promise((resolve, reject) => {
    if (proxy.kind.startsWith('SOCKS')) return reject(new Error('Proxy SOCKS não é suportado em requisições com certificado digital. Use um proxy HTTP ou "Sem proxy".'));
    const headers = { Host: `${target.host}:${target.port}` };
    if (auth && auth.username) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${auth.username}:${auth.password || ''}`).toString('base64');
    const req = http.request({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: `${target.host}:${target.port}`, headers });
    req.on('connect', (res, socket) => {
      if (res.statusCode === 200) resolve(socket);
      else { socket.destroy(); reject(new Error(res.statusCode === 407 ? 'O proxy exige autenticação. Informe usuário e senha em Configurações › Proxy.' : `O proxy recusou o túnel (HTTP ${res.statusCode}).`)); }
    });
    req.on('error', (e) => reject(new Error('Não foi possível conectar ao proxy: ' + e.message)));
    if (signal) signal.addEventListener('abort', () => req.destroy(), { once: true });
    req.end();
  });
}

function friendly(e) {
  const m = String(e && e.message || e);
  const map = [
    [/unable to get local issuer|self.signed|UNABLE_TO_VERIFY|certificate chain/i, 'O certificado do servidor não é confiável para o Mono. Para SEFAZ e outros servidores ICP-Brasil, informe a cadeia (CA) no certificado em Configurações › Certificados, ou desative a verificação SSL em Configurações › Requisições.'],
    [/mac verify|bad decrypt|Senha do certificado incorreta/i, 'Senha do certificado digital incorreta (Configurações › Certificados).'],
    [/ECONNREFUSED/, 'Conexão recusada: o servidor não está ouvindo nesse endereço e porta.'],
    [/ENOTFOUND|EAI_AGAIN/, 'Endereço não encontrado (DNS). Confira a URL.'],
    [/ETIMEDOUT/, 'Tempo de conexão esgotado.'],
    [/handshake|alert|certificate required|bad certificate/i, 'O servidor recusou o certificado digital (handshake TLS). Confira se é o certificado certo e se está dentro da validade.'],
  ];
  const hit = map.find(([re]) => re.test(m));
  return new Error(hit ? `${hit[1]} (${m})` : m);
}

function decode(buf, enc) {
  try {
    if (/gzip/i.test(enc)) return zlib.gunzipSync(buf);
    if (/deflate/i.test(enc)) return zlib.inflateSync(buf);
    if (/br/i.test(enc)) return zlib.brotliDecompressSync(buf);
  } catch { /* devolve como veio */ }
  return buf;
}

// Mesmo contrato do transporte do http.js: (built, { signal, followRedirects }) → { status, statusText, headers, url, buffer }
// cfg: { pfx (Buffer), passphrase, ca (pem), sslVerify, proxyRules, proxyAuth }
async function request(built, { signal, followRedirects = true } = {}, cfgIn) {
  let pair;
  try { pair = keyPair(cfgIn.pfx, cfgIn.passphrase || ''); } catch (e) { throw friendly(e); }
  const cfg = { ...cfgIn, pair };
  let url = built.url, method = built.method, body = built.body, headers = { ...built.headers };
  for (let hop = 0; hop < 10; hop++) {
    const res = await once(url, method, headers, body, signal, cfg);
    const loc = res.headers.find((x) => x.key.toLowerCase() === 'location');
    if (followRedirects && loc && [301, 302, 303, 307, 308].includes(res.status)) {
      url = new URL(loc.value, url).toString();
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
        method = 'GET'; body = undefined;
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^content-(type|length)$/i.test(k)));
      }
      continue;
    }
    return { ...res, url };
  }
  throw new Error('Redirecionamentos demais (10).');
}
async function once(url, method, headers, body, signal, cfg) {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const port = Number(u.port || (isHttps ? 443 : 80));
  const tlsOpts = {
    servername: u.hostname, key: cfg.pair.key, cert: cfg.pair.cert,
    rejectUnauthorized: cfg.sslVerify !== false, ca: caList(cfg.ca),
  };
  const proxy = parseProxy(cfg.proxyRules);
  let socket = null;
  if (proxy && isHttps) socket = await tunnel(proxy, { host: u.hostname, port }, cfg.proxyAuth, signal);
  return new Promise((resolve, reject) => {
    const opts = {
      method, host: u.hostname, port, path: u.pathname + u.search, headers: { 'Accept-Encoding': 'gzip, deflate, br', ...headers },
      ...(isHttps ? tlsOpts : {}),
      ...(socket ? { createConnection: () => tls.connect({ ...tlsOpts, socket }) } : { agent: false }),
    };
    if (body != null) opts.headers['Content-Length'] = Buffer.byteLength(body);
    let req;
    try { req = (isHttps ? https : http).request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const hs = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) hs.push({ key: res.rawHeaders[i].toLowerCase(), value: res.rawHeaders[i + 1] });
        resolve({ status: res.statusCode, statusText: res.statusMessage || '', headers: hs, buffer: decode(Buffer.concat(chunks), res.headers['content-encoding']) });
      });
      res.on('error', (e) => reject(friendly(e)));
    }); } catch (e) { if (socket) socket.destroy(); reject(friendly(e)); return; }
    req.on('error', (e) => { if (signal && signal.aborted) { const a = new Error('aborted'); a.name = 'AbortError'; reject(a); } else reject(friendly(e)); });
    if (signal) signal.addEventListener('abort', () => req.destroy(), { once: true });
    if (body != null) req.write(body);
    req.end();
  });
}

module.exports = { hostMatches, certFor, inspect, request, toPem, parseProxy, keyPair };
