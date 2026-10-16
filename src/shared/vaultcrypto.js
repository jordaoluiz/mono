// Criptografia do cofre de segredos (WebCrypto: roda igual no app e nos testes em Node).
//  · cada pessoa tem um par ECDH P-256; a chave privada fica no computador (cifrada pelo Windows) e, para entrar
//    em outro computador, um backup cifrado com a senha (PBKDF2 + AES-GCM) fica no servidor;
//  · cada workspace tem uma chave AES-256 ("chave do cofre"), embrulhada para cada membro com ECDH efêmero;
//  · cada segredo vai cifrado com AES-GCM. O servidor nunca vê a senha, a chave privada nem os valores.
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.MonoVaultCrypto = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const subtle = () => globalThis.crypto.subtle;
  const rnd = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
  const enc = new TextEncoder(), dec = new TextDecoder();
  function b64(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(str) {
    const s = atob(String(str || ''));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
  const PBKDF2_ITER = 310000;

  async function generateUserKeys() {
    const kp = await subtle().generateKey(ECDH, true, ['deriveKey']);
    const spki = await subtle().exportKey('spki', kp.publicKey);
    const jwk = await subtle().exportKey('jwk', kp.privateKey);
    return { publicKey: b64(spki), privateKey: JSON.stringify(jwk) };
  }
  const importPrivate = (jwkStr) => subtle().importKey('jwk', JSON.parse(jwkStr), ECDH, false, ['deriveKey']);
  const importPublic = (spkiB64) => subtle().importKey('spki', unb64(spkiB64), ECDH, false, []);
  async function fingerprint(spkiB64) {
    const h = new Uint8Array(await subtle().digest('SHA-256', unb64(spkiB64)));
    return [...h.slice(0, 12)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  // Confere se a chave privada corresponde à pública publicada (derivação de teste com um par efêmero).
  async function publicOf(jwkStr) {
    const jwk = JSON.parse(jwkStr);
    const pub = await subtle().importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true }, ECDH, true, []);
    return b64(await subtle().exportKey('spki', pub));
  }

  async function passwordKey(password, salt) {
    const base = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function backupPrivate(jwkStr, password) {
    const salt = rnd(16), iv = rnd(12);
    const key = await passwordKey(password, salt);
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('mono-key-backup-v1') }, key, enc.encode(jwkStr));
    return { v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
  }
  async function restorePrivate(backup, password) {
    const key = await passwordKey(password, unb64(backup.salt));
    try {
      const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(backup.iv), additionalData: enc.encode('mono-key-backup-v1') }, key, unb64(backup.ct));
      return dec.decode(pt);
    } catch { throw new Error('Senha não abre o backup da chave do cofre.'); }
  }

  function newVaultKey() {
    const kid = b64(rnd(9)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return { kid, raw: b64(rnd(32)) };
  }
  // Embrulha a chave do cofre para um membro: ECDH(efêmera, pública do membro) → AES-GCM.
  async function wrapKey(rawB64, kid, memberPublicB64) {
    const eph = await subtle().generateKey(ECDH, true, ['deriveKey']);
    const pub = await importPublic(memberPublicB64);
    const k = await subtle().deriveKey({ name: 'ECDH', public: pub }, eph.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const iv = rnd(12);
    const fp = await fingerprint(memberPublicB64);
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`mono-vault:${kid}:${fp}`) }, k, unb64(rawB64));
    return { epk: b64(await subtle().exportKey('spki', eph.publicKey)), iv: b64(iv), ct: b64(ct), fp, kid };
  }
  async function unwrapKey(blob, privateJwkStr) {
    const priv = await importPrivate(privateJwkStr);
    const k = await subtle().deriveKey({ name: 'ECDH', public: await importPublic(blob.epk) }, priv, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    try {
      const raw = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(blob.iv), additionalData: enc.encode(`mono-vault:${blob.kid}:${blob.fp}`) }, k, unb64(blob.ct));
      return b64(raw);
    } catch { throw new Error('Esta chave do cofre não foi embrulhada para a sua chave atual.'); }
  }
  const importVaultKey = (rawB64) => subtle().importKey('raw', unb64(rawB64), 'AES-GCM', false, ['encrypt', 'decrypt']);
  async function sealValue(key, kid, text) {
    const iv = rnd(12);
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('mono-secret:' + kid) }, key, enc.encode(String(text)));
    return { kid, iv: b64(iv), ct: b64(ct) };
  }
  async function openValue(key, sealed) {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv), additionalData: enc.encode('mono-secret:' + sealed.kid) }, key, unb64(sealed.ct));
    return dec.decode(pt);
  }
  // Impressão local (não criptográfica) para saber se um valor mudou desde a última cifragem.
  function quickFp(s) {
    let h = 0x811c9dc5;
    for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36) + ':' + String(s).length;
  }

  return { generateUserKeys, publicOf, fingerprint, backupPrivate, restorePrivate, newVaultKey, wrapKey, unwrapKey, importVaultKey, sealValue, openValue, quickFp, b64, unb64 };
});
