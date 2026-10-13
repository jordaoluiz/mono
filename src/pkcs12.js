// Lê a chave privada e o certificado de um arquivo .pfx/.p12 (PKCS#12) — o Node não expõe isso.
// Suporta PBES2 (PBKDF2 + AES/3DES, padrão atual) e PBE do PKCS#12 com 3DES (padrão antigo/Windows),
// inclusive codificação BER com tamanho indefinido. Certificados em bags cifradas com RC2 (legado)
// são lidos pelo próprio TLS do Node como alternativa.
'use strict';
const crypto = require('crypto');
const tls = require('tls');

// ---------- ASN.1 DER/BER ----------
function read(buf, pos = 0) {
  const start = pos;
  const b0 = buf[pos++];
  const cls = b0 >> 6, constructed = !!(b0 & 0x20);
  let tag = b0 & 0x1f;
  if (tag === 0x1f) { tag = 0; let b; do { b = buf[pos++]; tag = (tag << 7) | (b & 0x7f); } while (b & 0x80); }
  let len = buf[pos++];
  let indefinite = false;
  if (len === 0x80) indefinite = true;
  else if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = len * 256 + buf[pos++]; }
  const node = { cls, tag, constructed, start, contentStart: pos, children: null };
  if (constructed) {
    node.children = [];
    if (indefinite) {
      while (!(buf[pos] === 0 && buf[pos + 1] === 0)) { const c = read(buf, pos); node.children.push(c); pos = c.end; }
      node.contentEnd = pos; node.end = pos + 2;
    } else {
      const end = pos + len;
      while (pos < end) { const c = read(buf, pos); node.children.push(c); pos = c.end; }
      node.contentEnd = end; node.end = end;
    }
  } else {
    if (indefinite) throw new Error('ASN.1: tamanho indefinido em tipo primitivo');
    node.contentEnd = pos + len; node.end = pos + len;
  }
  node.buf = buf;
  return node;
}
const content = (n) => n.buf.subarray(n.contentStart, n.contentEnd);
// OCTET STRING pode vir "construída" (BER, partida em pedaços): junta tudo.
const octets = (n) => (n.constructed ? Buffer.concat(n.children.map(octets)) : Buffer.from(content(n)));
function oid(n) {
  const b = content(n);
  const out = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) { v = v * 128 + (b[i] & 0x7f); if (!(b[i] & 0x80)) { out.push(v); v = 0; } }
  return out.join('.');
}
const int = (n) => { let v = 0; for (const x of content(n)) v = v * 256 + x; return v; };
// [0] EXPLICIT → o filho; [0] IMPLICIT OCTET STRING → os bytes
const explicit0 = (n) => n.children[0];

const OID = {
  data: '1.2.840.113549.1.7.1', encryptedData: '1.2.840.113549.1.7.6',
  keyBag: '1.2.840.113549.1.12.10.1.1', shroudedKeyBag: '1.2.840.113549.1.12.10.1.2', certBag: '1.2.840.113549.1.12.10.1.3',
  x509: '1.2.840.113549.1.9.22.1',
  pbes2: '1.2.840.113549.1.5.13', pbkdf2: '1.2.840.113549.1.5.12',
  sha1des3: '1.2.840.113549.1.12.1.3', sha1des2: '1.2.840.113549.1.12.1.4', sha1rc2_128: '1.2.840.113549.1.12.1.5', sha1rc2_40: '1.2.840.113549.1.12.1.6',
};
const PRF = { '1.2.840.113549.2.7': 'sha1', '1.2.840.113549.2.8': 'sha224', '1.2.840.113549.2.9': 'sha256', '1.2.840.113549.2.10': 'sha384', '1.2.840.113549.2.11': 'sha512' };
const CIPHER = {
  '2.16.840.1.101.3.4.1.2': ['aes-128-cbc', 16], '2.16.840.1.101.3.4.1.22': ['aes-192-cbc', 24], '2.16.840.1.101.3.4.1.42': ['aes-256-cbc', 32],
  '1.2.840.113549.3.7': ['des-ede3-cbc', 24], '1.3.14.3.2.7': ['des-cbc', 8],
};

// KDF do PKCS#12 (RFC 7292, apêndice B), com SHA-1.
function pkcs12Kdf(password, salt, iterations, id, n) {
  const u = 20, v = 64;
  const pw = password == null ? Buffer.alloc(0) : Buffer.concat([Buffer.from(String(password), 'utf16le').swap16(), Buffer.alloc(2)]);
  const fill = (b) => { if (!b.length) return Buffer.alloc(0); const L = v * Math.ceil(b.length / v); const o = Buffer.alloc(L); for (let i = 0; i < L; i++) o[i] = b[i % b.length]; return o; };
  const D = Buffer.alloc(v, id);
  const I = Buffer.concat([fill(salt), fill(pw)]);
  const out = [];
  for (let produced = 0; produced < n; produced += u) {
    let A = crypto.createHash('sha1').update(D).update(I).digest();
    for (let r = 1; r < iterations; r++) A = crypto.createHash('sha1').update(A).digest();
    out.push(A);
    const B = fill(A);
    for (let j = 0; j < I.length; j += v) {
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) { const x = I[j + k] + B[k] + carry; I[j + k] = x & 0xff; carry = x >> 8; }
    }
  }
  return Buffer.concat(out).subarray(0, n);
}

function decrypt(algNode, data, password) {
  const alg = oid(algNode.children[0]);
  const params = algNode.children[1];
  try {
    if (alg === OID.pbes2) {
      const kdf = params.children[0], enc = params.children[1];
      if (oid(kdf.children[0]) !== OID.pbkdf2) throw new Error('KDF não suportada');
      const kp = kdf.children[1].children;
      const salt = octets(kp[0]), iter = int(kp[1]);
      let keyLen = null, prf = 'sha1';
      for (const x of kp.slice(2)) { if (x.tag === 2) keyLen = int(x); else if (x.tag === 16) prf = PRF[oid(x.children[0])] || 'sha1'; }
      const encOid = oid(enc.children[0]);
      const c = CIPHER[encOid];
      if (!c) throw new Error('cifra não suportada: ' + encOid);
      const key = crypto.pbkdf2Sync(Buffer.from(String(password ?? ''), 'utf8'), salt, iter, keyLen || c[1], prf);
      const d = crypto.createDecipheriv(c[0], key, octets(enc.children[1]));
      return Buffer.concat([d.update(data), d.final()]);
    }
    if (alg === OID.sha1des3 || alg === OID.sha1des2) {
      const salt = octets(params.children[0]), iter = int(params.children[1]);
      const key = pkcs12Kdf(password, salt, iter, 1, 24);
      const iv = pkcs12Kdf(password, salt, iter, 2, 8);
      const d = crypto.createDecipheriv('des-ede3-cbc', alg === OID.sha1des2 ? Buffer.concat([key.subarray(0, 16), key.subarray(0, 8)]) : key, iv);
      return Buffer.concat([d.update(data), d.final()]);
    }
    if (alg === OID.sha1rc2_40 || alg === OID.sha1rc2_128) {
      const salt = octets(params.children[0]), iter = int(params.children[1]);
      const kl = alg === OID.sha1rc2_40 ? 5 : 16;
      const key = pkcs12Kdf(password, salt, iter, 1, kl);
      const iv = pkcs12Kdf(password, salt, iter, 2, 8);
      // RC2 em JS: o OpenSSL 3 e o BoringSSL (Electron) não trazem mais essa cifra.
      return require('./rc2').decryptCbc(key, alg === OID.sha1rc2_40 ? 40 : 128, iv, data);
    }
  } catch (e) {
    const rc2 = alg === OID.sha1rc2_40 || alg === OID.sha1rc2_128;
    if (rc2 && /unsupported|unknown cipher|not supported|invalid cipher/i.test(e.message)) { const x = new Error('RC2'); x.code = 'RC2'; throw x; }
    if (/bad decrypt|wrong final block|bad_decrypt/i.test(e.message)) { const x = new Error('SENHA'); x.code = 'SENHA'; throw x; }
    throw e;
  }
  throw new Error('algoritmo de proteção não suportado: ' + alg);
}

// Retorna { key: KeyObject, certs: [Buffer DER], cert: Buffer DER (do titular) }
function parsePfx(pfx, password) {
  const root = read(Buffer.from(pfx));
  const authSafe = root.children[1];
  if (oid(authSafe.children[0]) !== OID.data) throw new Error('PKCS#12 com authSafe assinado não é suportado.');
  const seq = read(octets(explicit0(authSafe.children[1])));
  const keys = [], certs = [];
  let rc2Skipped = false;
  const bags = (safeContents) => {
    for (const bag of safeContents.children) {
      const id = oid(bag.children[0]);
      const val = explicit0(bag.children[1]);
      if (id === OID.shroudedKeyBag) {
        const der = decrypt(val.children[0], octets(val.children[1]), password);
        keys.push(crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }));
      } else if (id === OID.keyBag) {
        keys.push(crypto.createPrivateKey({ key: Buffer.from(val.buf.subarray(val.start, val.end)), format: 'der', type: 'pkcs8' }));
      } else if (id === OID.certBag && oid(val.children[0]) === OID.x509) {
        certs.push(octets(explicit0(val.children[1])));
      }
    }
  };
  for (const ci of seq.children) {
    const t = oid(ci.children[0]);
    if (t === OID.data) bags(read(octets(explicit0(ci.children[1]))));
    else if (t === OID.encryptedData) {
      const eci = explicit0(ci.children[1]).children[1];
      const encrypted = eci.children[2];
      try { bags(read(decrypt(eci.children[1], octets(encrypted), password))); }
      catch (e) { if (e.code === 'RC2') rc2Skipped = true; else throw e; }
    }
  }
  if (!keys.length) throw new Error('O arquivo não tem chave privada.');
  // Certificado do titular: o que casa com a chave (ou o que o TLS do Node lê do .pfx, se a bag usa RC2).
  const pub = crypto.createPublicKey(keys[0]).export({ type: 'spki', format: 'der' });
  let cert = certs.find((c) => { try { return new crypto.X509Certificate(c).publicKey.export({ type: 'spki', format: 'der' }).equals(pub); } catch { return false; } });
  if (!cert) {
    try { const ctx = tls.createSecureContext({ pfx, passphrase: password || '' }); const der = ctx.context.getCertificate && ctx.context.getCertificate(); if (der) cert = Buffer.from(der); } catch { /* sem alternativa */ }
  }
  if (!cert) throw new Error(rc2Skipped ? 'Não consegui ler o certificado (proteção RC2 antiga). Reexporte o .pfx com AES ou 3DES.' : 'Certificado do titular não encontrado no arquivo.');
  return { key: keys[0], cert, certs };
}

function load(pfx, password) {
  try { return parsePfx(pfx, password); }
  catch (e) {
    if (e.code === 'SENHA') throw new Error('Senha do certificado incorreta.');
    throw new Error('Não foi possível ler o certificado: ' + e.message);
  }
}

module.exports = { load, read, oid, pkcs12Kdf };
