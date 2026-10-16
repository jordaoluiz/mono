// Rede das requisições do usuário: sessão própria do Chromium com proxy, SSL e
// autenticação de proxy configuráveis nas Configurações (globais do usuário).
'use strict';
const { net, session } = require('electron');
const certs = require('./certs');

const DEFAULTS = {
  proxy: { mode: 'system', protocol: 'http', host: '', port: '', auth: false, username: '', password: '', bypass: 'localhost, 127.0.0.1, <local>' },
  request: { timeoutMs: 30000, followRedirects: true, sslVerify: true },
  certs: [],
};
let readFile = null; // injetado pelo processo principal (só arquivos permitidos)
const setFileReader = (fn) => { readFile = fn; };

let ses = null;
let current = structuredClone(DEFAULTS);

function merged(s) {
  return {
    proxy: { ...DEFAULTS.proxy, ...(s && s.proxy) },
    request: { ...DEFAULTS.request, ...(s && s.request) },
    certs: Array.isArray(s && s.certs) ? s.certs : [],
  };
}

function getSession() {
  if (!ses) {
    ses = session.fromPartition('persist:mono-http', { cache: false });
    ses.setCertificateVerifyProc((_req, cb) => cb(current.request.sslVerify ? -3 : 0)); // -3 = verificação padrão do Chromium
  }
  return ses;
}

async function apply(settings) {
  current = merged(settings);
  const p = current.proxy;
  const s = getSession();
  let config;
  if (p.mode === 'none') config = { mode: 'direct' };
  else if (p.mode === 'custom' && p.host) {
    const scheme = p.protocol === 'socks5' ? 'socks5' : p.protocol === 'https' ? 'https' : 'http';
    const port = p.port || (scheme === 'socks5' ? 1080 : scheme === 'https' ? 443 : 8080);
    config = { mode: 'fixed_servers', proxyRules: `${scheme}://${p.host}:${port}`, proxyBypassRules: (p.bypass || '').split(/[,;\s]+/).filter(Boolean).join(',') };
  } else config = { mode: 'system' };
  await s.setProxy(config);
  await s.closeAllConnections?.();
  return { ok: true, config };
}

async function resolveProxy(url) {
  try { return { ok: true, proxy: await getSession().resolveProxy(url) }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// Transporte usado por http.send. Hosts com certificado digital (.pfx) saem pelo https do Node (certs.js);
// o resto vai pelo net.request do Chromium, que respeita o proxy da sessão e responde ao 407.
async function transport(built, opts) {
  const cert = certs.certFor(current.certs, built.url);
  if (!cert) return chromiumTransport(built, opts);
  if (!readFile) throw new Error('Leitor de arquivos indisponível.');
  const p = current.proxy;
  const proxyRules = p.mode === 'none' ? 'DIRECT' : await getSession().resolveProxy(built.url).catch(() => 'DIRECT');
  return certs.request(built, opts, {
    pfx: readFile(cert.path), passphrase: cert.passphrase || '',
    ca: cert.caPath ? certs.toPem(readFile(cert.caPath)) : '',
    sslVerify: current.request.sslVerify !== false,
    proxyRules, proxyAuth: p.auth ? { username: p.username, password: p.password } : null,
  });
}
function chromiumTransport(built, { signal, followRedirects }) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: built.method, url: built.url, session: getSession(), redirect: 'manual', useSessionCookies: false });
    let finalUrl = built.url;
    let proxyAuthTried = false;
    for (const [k, v] of Object.entries(built.headers || {})) {
      if (/^(content-length|host)$/i.test(k)) continue;
      try { req.setHeader(k, v); } catch { /* header proibido pelo Chromium */ }
    }
    req.on('redirect', (_status, _method, url) => {
      if (followRedirects) { finalUrl = url; req.followRedirect(); }
      else req.abort();
    });
    req.on('login', (authInfo, cb) => {
      const p = current.proxy;
      if (authInfo.isProxy && p.auth && p.username && !proxyAuthTried) { proxyAuthTried = true; cb(p.username, p.password || ''); }
      else cb();
    });
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => {
        const headers = [];
        for (const [key, value] of Object.entries(res.headers)) for (const v of [].concat(value)) headers.push({ key, value: String(v) });
        resolve({ status: res.statusCode, statusText: res.statusMessage || '', headers, url: finalUrl, buffer: Buffer.concat(chunks) });
      });
      res.on('error', reject);
    });
    req.on('error', (e) => reject(friendly(e)));
    req.on('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    if (signal) signal.addEventListener('abort', () => req.abort(), { once: true });
    if (built.body != null) req.write(built.body);
    req.end();
  });
}

// Traduz os erros mais comuns do Chromium para algo acionável.
function friendly(e) {
  const m = String(e && e.message || e);
  const map = [
    [/ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED/, 'Não foi possível conectar ao proxy. Confira host e porta em Configurações › Proxy.'],
    [/ERR_PROXY_AUTH|407/, 'O proxy exige autenticação. Informe usuário e senha em Configurações › Proxy.'],
    [/ERR_CERT_|ERR_SSL/, 'Certificado SSL inválido ou não confiável. Para ambientes internos, desative a verificação SSL em Configurações › Requisições.'],
    [/ERR_NAME_NOT_RESOLVED/, 'Endereço não encontrado (DNS). Confira a URL ou a variável {{baseUrl}}.'],
    [/ERR_CONNECTION_REFUSED/, 'Conexão recusada: o servidor não está ouvindo nesse endereço e porta.'],
    [/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/, 'Tempo de conexão esgotado.'],
    [/ERR_INTERNET_DISCONNECTED/, 'Sem conexão com a internet.'],
  ];
  const hit = map.find(([re]) => re.test(m));
  const err = new Error(hit ? `${hit[1]} (${m.match(/net::\w+/)?.[0] || m})` : m);
  return err;
}

const get = () => current;
// Conexão com o servidor do Mono (contas/workspaces): mesma sessão, logo o mesmo proxy.
const fetchVia = (url, opts) => getSession().fetch(url, opts);

module.exports = { apply, transport, resolveProxy, get, DEFAULTS, setFileReader, fetch: fetchVia };
