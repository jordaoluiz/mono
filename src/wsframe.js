// Quadros WebSocket (RFC 6455): montar e ler. O cliente sempre mascara o que envia.
'use strict';
const crypto = require('crypto');

const OP = { cont: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

function encode(opcode, payload = Buffer.alloc(0), mask = true) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  const head = [0x80 | opcode];
  let ext = Buffer.alloc(0);
  if (len < 126) head.push((mask ? 0x80 : 0) | len);
  else if (len < 65536) { head.push((mask ? 0x80 : 0) | 126); ext = Buffer.alloc(2); ext.writeUInt16BE(len); }
  else { head.push((mask ? 0x80 : 0) | 127); ext = Buffer.alloc(8); ext.writeBigUInt64BE(BigInt(len)); }
  if (!mask) return Buffer.concat([Buffer.from(head), ext, data]);
  const key = crypto.randomBytes(4);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = data[i] ^ key[i & 3];
  return Buffer.concat([Buffer.from(head), ext, key, out]);
}

// Junta pedaços de TCP e devolve mensagens completas (inclusive fragmentadas).
class Decoder {
  constructor(maxMessage = 32 * 1024 * 1024) { this.buf = Buffer.alloc(0); this.frag = null; this.max = maxMessage; }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = !!(b0 & 0x80), opcode = b0 & 0x0f, masked = !!(b1 & 0x80);
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) break; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) break; const big = this.buf.readBigUInt64BE(2); if (big > BigInt(this.max)) throw new Error('Mensagem maior que o limite.'); len = Number(big); off = 10; }
      const keyOff = off; if (masked) off += 4;
      if (this.buf.length < off + len) break;
      let payload = this.buf.subarray(off, off + len);
      if (masked) { const key = this.buf.subarray(keyOff, keyOff + 4); const p = Buffer.alloc(len); for (let i = 0; i < len; i++) p[i] = payload[i] ^ key[i & 3]; payload = p; }
      else payload = Buffer.from(payload);
      this.buf = this.buf.subarray(off + len);
      if (opcode >= 0x8) { out.push({ opcode, payload }); continue; } // controle nunca é fragmentado
      if (opcode !== OP.cont) this.frag = { opcode, parts: [payload], size: payload.length };
      else if (this.frag) { this.frag.parts.push(payload); this.frag.size += payload.length; }
      else continue;
      if (this.frag.size > this.max) throw new Error('Mensagem maior que o limite.');
      if (fin) { out.push({ opcode: this.frag.opcode, payload: Buffer.concat(this.frag.parts) }); this.frag = null; }
    }
    return out;
  }
}

const acceptKey = (key) => crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');

module.exports = { OP, encode, Decoder, acceptKey };
