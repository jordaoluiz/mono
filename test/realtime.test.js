// WebSocket (handshake, texto, binário, fragmentos, ping, fechamento) e SSE.
'use strict';
const assert = require('assert');
const http = require('http');
const { createRealtime } = require('../src/realtime');
const { OP, encode, Decoder, acceptKey } = require('../src/wsframe');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await wait(15); } throw new Error('tempo esgotado'); }

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/sse')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': comentário\n\n');
      res.write('event: preco\nid: 1\ndata: {"ativo":"PETR4",\ndata: "valor":38.5}\n\n');
      res.write('data: simples\n\n');
      setTimeout(() => { res.write('data: fim\n\n'); res.end(); }, 50);
      return;
    }
    if (req.url === '/nao') { res.writeHead(403); return res.end('proibido'); }
    res.end('ok');
  });
  server.on('upgrade', (req, socket) => {
    if (req.headers.authorization !== 'Bearer t0k') { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return; }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\n\r\n`);
    // fragmentado + ping logo de cara
    socket.write(Buffer.concat([Buffer.from([0x01, 2]), Buffer.from('ol', 'utf8')]));
    socket.write(Buffer.concat([Buffer.from([0x80, 6]), Buffer.from(' mundo')]));
    socket.write(encode(OP.ping, Buffer.from('p'), false));
    const dec = new Decoder();
    socket.on('data', (d) => {
      for (const f of dec.push(d)) {
        if (f.opcode === OP.text) socket.write(encode(OP.text, 'eco: ' + f.payload.toString(), false));
        if (f.opcode === OP.binary) socket.write(encode(OP.binary, Buffer.concat([f.payload, Buffer.from([255])]), false));
        if (f.opcode === OP.pong) socket.write(encode(OP.text, 'pong recebido', false));
        if (f.opcode === OP.close) { socket.write(encode(OP.close, f.payload, false)); socket.end(); }
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const events = [];
  const rt = createRealtime({ emit: (e) => events.push(e) });
  const of = (id, type) => events.filter((e) => e.id === id && e.type === type);

  // recusa (401 → erro claro)
  rt.connect({ id: 'x', kind: 'ws', built: { url: `ws://127.0.0.1:${port}/ws`, headers: {} } });
  await until(() => of('x', 'close').length);
  assert.match(of('x', 'error')[0].error, /HTTP 401/);

  // conexão com header de autorização
  rt.connect({ id: 'a', kind: 'ws', built: { url: `http://127.0.0.1:${port}/ws?x=1`, headers: { Authorization: 'Bearer t0k' } } });
  await until(() => of('a', 'open').length);
  await until(() => of('a', 'message').some((m) => m.data === 'pong recebido'));
  const first = of('a', 'message')[0];
  assert.strictEqual(first.dir, 'in'); assert.strictEqual(first.data, 'ol mundo', 'mensagem fragmentada remontada');
  rt.send({ id: 'a', data: '{"oi":1}' });
  await until(() => of('a', 'message').some((m) => m.data === 'eco: {"oi":1}'));
  assert.ok(of('a', 'message').some((m) => m.dir === 'out' && m.data === '{"oi":1}'));
  rt.send({ id: 'a', data: Buffer.from([1, 2, 3]).toString('base64'), binary: true });
  await until(() => of('a', 'message').some((m) => m.binary && m.dir === 'in'));
  assert.strictEqual(Buffer.from(of('a', 'message').find((m) => m.binary && m.dir === 'in').data, 'base64').toString('hex'), '010203ff');
  // mensagem grande (> 64 KB, tamanho de 8 bytes)
  const big = 'x'.repeat(70000);
  rt.send({ id: 'a', data: big });
  await until(() => of('a', 'message').some((m) => m.dir === 'in' && m.size === big.length + 5));
  rt.close({ id: 'a', code: 1000, reason: 'tchau' });
  const cl = await until(() => of('a', 'close')[0]);
  assert.strictEqual(cl.code, 1000);
  assert.throws(() => rt.send({ id: 'a', data: 'x' }), /Conecte/);

  // SSE
  rt.connect({ id: 's', kind: 'sse', built: { method: 'GET', url: `http://127.0.0.1:${port}/sse`, headers: {} } });
  await until(() => of('s', 'close').length);
  const msgs = of('s', 'message');
  assert.deepStrictEqual(msgs.map((m) => m.event), ['preco', 'message', 'message']);
  assert.deepStrictEqual(JSON.parse(msgs[0].data), { ativo: 'PETR4', valor: 38.5 });
  assert.strictEqual(msgs[0].eventId, '1');
  assert.match(of('s', 'close')[0].reason, /encerrou/);
  rt.connect({ id: 'n', kind: 'sse', built: { method: 'GET', url: `http://127.0.0.1:${port}/nao`, headers: {} } });
  await until(() => of('n', 'close').length);
  assert.match(of('n', 'error')[0].error, /403/);

  server.close();
  console.log('ok — WebSocket e SSE passaram');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
