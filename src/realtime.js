// Conexões contínuas da interface: WebSocket e Server-Sent Events (SSE), no processo principal.
// WebSocket: cliente próprio (RFC 6455) sobre net/tls, com o proxy do app (túnel CONNECT) e certificado A1 quando houver.
// SSE: fetch em streaming pela sessão de rede do app.
'use strict';
const net = require('net');
const tls = require('tls');
const http = require('http');
const crypto = require('crypto');
const { OP, encode, Decoder, acceptKey } = require('./wsframe');
const { parseProxy, tunnel } = require('./certs');

const MAX_SHOWN = 2 * 1024 * 1024; // mensagens maiores chegam truncadas na interface

function createRealtime({ emit, resolveProxy = async () => 'DIRECT', proxyAuth = () => null, sslVerify = () => true, clientCert = () => null, fetchImpl = fetch }) {
  const conns = new Map();
  const ev = (id, type, extra = {}) => emit({ id, type, at: Date.now(), ...extra });
  const shown = (buf, binary) => {
    if (binary) return { binary: true, size: buf.length, data: buf.subarray(0, 4096).toString('base64') };
    const text = buf.toString('utf8');
    return { size: buf.length, data: text.length > MAX_SHOWN ? text.slice(0, MAX_SHOWN) : text, truncated: text.length > MAX_SHOWN };
  };

  async function openSocket(u, signal) {
    const secure = u.protocol === 'wss:' || u.protocol === 'https:';
    const port = Number(u.port) || (secure ? 443 : 80);
    const httpUrl = `${secure ? 'https' : 'http'}://${u.host}${u.pathname}`;
    const proxy = parseProxy(await resolveProxy(httpUrl).catch(() => 'DIRECT'));
    let raw;
    if (proxy) raw = await tunnel(proxy, { host: u.hostname, port }, proxyAuth(), signal);
    else raw = await new Promise((resolve, reject) => { const s = net.connect({ host: u.hostname, port }); s.once('connect', () => resolve(s)); s.once('error', reject); signal?.addEventListener('abort', () => s.destroy(new Error('cancelado')), { once: true }); });
    if (!secure) return raw;
    const cert = clientCert(httpUrl);
    return new Promise((resolve, reject) => {
      const s = tls.connect({ socket: raw, servername: net.isIP(u.hostname) ? undefined : u.hostname, rejectUnauthorized: sslVerify(), ALPNProtocols: ['http/1.1'], ...(cert || {}) });
      s.once('secureConnect', () => resolve(s));
      s.once('error', reject);
    });
  }

  async function connectWs(id, built) {
    const u = new URL(built.url.replace(/^http/, 'ws'));
    const ctrl = new AbortController();
    const c = { kind: 'ws', ctrl, socket: null, closed: false };
    conns.set(id, c);
    ev(id, 'connecting', { url: u.toString() });
    try {
      const sock = await openSocket(u, ctrl.signal);
      c.socket = sock;
      const key = crypto.randomBytes(16).toString('base64');
      const headers = { Host: u.host, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' };
      for (const [k, v] of Object.entries(built.headers || {})) if (!/^(host|upgrade|connection|sec-websocket-key|sec-websocket-version|content-length|content-type)$/i.test(k)) headers[k] = v;
      const req = http.request({ createConnection: () => sock, host: u.hostname, path: u.pathname + u.search, method: 'GET', headers }); // sem agent: o Node usa o createConnection (com agent: false ele abriria outra conexão na porta 80)
      await new Promise((resolve, reject) => {
        req.on('upgrade', (res, socket, head) => {
          if (res.headers['sec-websocket-accept'] !== acceptKey(key)) { socket.destroy(); return reject(new Error('O servidor respondeu ao upgrade com uma chave inválida.')); }
          c.socket = socket;
          const hs = Object.entries(res.headers).map(([k, v]) => ({ key: k, value: String(v) }));
          ev(id, 'open', { status: 101, headers: hs, protocol: res.headers['sec-websocket-protocol'] || '' });
          wire(id, c, socket, head);
          resolve();
        });
        req.on('response', (res) => {
          const chunks = [];
          res.on('data', (d) => chunks.push(d));
          res.on('end', () => reject(new Error(`O servidor não aceitou o WebSocket (HTTP ${res.statusCode}${res.statusMessage ? ' ' + res.statusMessage : ''}). ${Buffer.concat(chunks).toString('utf8').slice(0, 300)}`.trim())));
        });
        req.on('error', reject);
        req.end();
      });
    } catch (e) {
      conns.delete(id);
      ev(id, 'error', { error: friendly(e) });
      ev(id, 'close', { code: 1006, reason: '' });
    }
  }

  function wire(id, c, socket, head) {
    const dec = new Decoder();
    const onData = (chunk) => {
      let frames;
      try { frames = dec.push(chunk); } catch (e) { ev(id, 'error', { error: e.message }); socket.destroy(); return; }
      for (const f of frames) {
        if (f.opcode === OP.text) ev(id, 'message', { dir: 'in', ...shown(f.payload, false) });
        else if (f.opcode === OP.binary) ev(id, 'message', { dir: 'in', ...shown(f.payload, true) });
        else if (f.opcode === OP.ping) socket.write(encode(OP.pong, f.payload));
        else if (f.opcode === OP.close) {
          const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
          const reason = f.payload.length > 2 ? f.payload.subarray(2).toString('utf8') : '';
          if (!c.closing) { try { socket.write(encode(OP.close, f.payload.subarray(0, 2))); } catch { /* já fechado */ } }
          c.closeInfo = { code, reason };
          socket.end();
        }
      }
    };
    socket.on('data', onData);
    if (head && head.length) onData(head);
    socket.on('error', (e) => ev(id, 'error', { error: friendly(e) }));
    socket.on('close', () => {
      if (c.closed) return;
      c.closed = true; conns.delete(id);
      ev(id, 'close', c.closeInfo || { code: 1006, reason: 'Conexão encerrada sem aviso.' });
    });
  }

  async function connectSse(id, built) {
    const ctrl = new AbortController();
    const c = { kind: 'sse', ctrl, closed: false };
    conns.set(id, c);
    ev(id, 'connecting', { url: built.url });
    try {
      const headers = { accept: 'text/event-stream', 'cache-control': 'no-cache', ...built.headers };
      const res = await fetchImpl(built.url, { method: built.method === 'POST' ? 'POST' : 'GET', headers, body: built.method === 'POST' ? built.body : undefined, signal: ctrl.signal });
      const hs = []; res.headers.forEach((value, key) => hs.push({ key, value }));
      if (!res.ok) throw new Error(`O servidor respondeu ${res.status} ${res.statusText || ''}. ${(await res.text()).slice(0, 300)}`.trim());
      if (!/event-stream/i.test(res.headers.get('content-type') || '')) ev(id, 'note', { text: `Content-Type recebido: ${res.headers.get('content-type') || '(nenhum)'} — o esperado é text/event-stream.` });
      ev(id, 'open', { status: res.status, headers: hs });
      const reader = res.body.getReader();
      const decd = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decd.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          let event = '', lastId = '', retry = null; const data = [];
          for (const line of block.split('\n')) {
            if (!line || line.startsWith(':')) continue;
            const k = line.indexOf(':');
            const field = k === -1 ? line : line.slice(0, k);
            const val = k === -1 ? '' : line.slice(k + 1).replace(/^ /, '');
            if (field === 'data') data.push(val); else if (field === 'event') event = val; else if (field === 'id') lastId = val; else if (field === 'retry') retry = Number(val);
          }
          if (!data.length && !event) continue;
          const text = data.join('\n');
          ev(id, 'message', { dir: 'in', event: event || 'message', eventId: lastId, retry, size: Buffer.byteLength(text), data: text.slice(0, MAX_SHOWN) });
        }
      }
      if (!c.closed) { c.closed = true; conns.delete(id); ev(id, 'close', { code: 1000, reason: 'O servidor encerrou o fluxo.' }); }
    } catch (e) {
      if (c.closed) return;
      c.closed = true; conns.delete(id);
      if (e.name !== 'AbortError') ev(id, 'error', { error: friendly(e) });
      ev(id, 'close', { code: e.name === 'AbortError' ? 1000 : 1006, reason: e.name === 'AbortError' ? 'Desconectado.' : '' });
    }
  }

  return {
    connect({ id, kind, built }) {
      this.close({ id });
      if (kind === 'sse') connectSse(id, built); else connectWs(id, built);
      return true;
    },
    send({ id, data, binary = false }) {
      const c = conns.get(id);
      if (!c || c.kind !== 'ws' || !c.socket || c.closed) throw new Error('Conecte antes de enviar mensagens.');
      const buf = binary ? Buffer.from(String(data), 'base64') : Buffer.from(String(data), 'utf8');
      c.socket.write(encode(binary ? OP.binary : OP.text, buf));
      ev(id, 'message', { dir: 'out', ...shown(buf, binary) });
      return true;
    },
    close({ id, code = 1000, reason = '' }) {
      const c = conns.get(id);
      if (!c) return false;
      if (c.kind === 'sse') { c.closed = true; conns.delete(id); c.ctrl.abort(); ev(id, 'close', { code: 1000, reason: 'Desconectado.' }); return true; }
      c.ctrl.abort();
      if (c.socket && !c.closed) {
        c.closing = true;
        const p = Buffer.alloc(2 + Buffer.byteLength(reason)); p.writeUInt16BE(code); p.write(reason, 2);
        c.closeInfo = { code, reason: reason || 'Desconectado.' };
        try { c.socket.write(encode(OP.close, p)); } catch { /* ignore */ }
        setTimeout(() => c.socket && c.socket.destroy(), 1500).unref?.();
      }
      return true;
    },
    closeAll() { for (const id of [...conns.keys()]) this.close({ id }); },
    count: () => conns.size,
  };
}

function friendly(e) {
  const m = String((e && e.message) || e);
  if (/ECONNREFUSED/.test(m)) return 'Conexão recusada: o servidor não está ouvindo nesse endereço e porta.';
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'Endereço não encontrado (DNS). Confira a URL.';
  if (/ETIMEDOUT/.test(m)) return 'Tempo de conexão esgotado.';
  if (/self.signed|UNABLE_TO_VERIFY|unable to get local issuer|CERT_/i.test(m)) return 'Certificado SSL não confiável. Para ambientes internos, desative a verificação SSL em Configurações › Requisições.';
  return m;
}

module.exports = { createRealtime };
