// RC2-CBC (RFC 2268), só decifragem — usado em .pfx antigos (certificados A1 exportados pelo Windows),
// já que o OpenSSL 3 / BoringSSL podem não trazer mais essa cifra.
'use strict';
const PITABLE = Buffer.from('d978f9c419ddb5ed28e9fd794aa0d89dc67e37832b76538e624c6488448bfba2179a59f587b34f1361456d8d09817d32bd8f40eb86b77b0bf09521225c6b4e8254d66593ce60b21c7356c014a78cf1dc1275ca1f3bbee4d1423dd430a33cb6266fbf0eda4669075727f21d9bbc944303f811c7f690ef3ee706c3d52fc8661ed708e8eade8052eef784aa72ac354d6a2a961ad2715a1549744b9fd05e0418a4ecc2e0416e0f51cbcc2491af50a1f47039997c3a8523b8b47afc02365b255597312d5dfa98e38a92ae05df2910676cbac9d300e6cfe19ea82c6316013f58e289a90d38341bab33ffb0bb480c5fb9b1cd2ec5f3db47e5a59c770aa62068fe7fc1ad', 'hex');

function expand(key, bits) {
  const T = key.length, T8 = Math.ceil(bits / 8), TM = 255 % (1 << (8 + bits - 8 * T8));
  const L = Buffer.alloc(128);
  key.copy(L);
  for (let i = T; i < 128; i++) L[i] = PITABLE[(L[i - 1] + L[i - T]) & 255];
  L[128 - T8] = PITABLE[L[128 - T8] & TM];
  for (let i = 127 - T8; i >= 0; i--) L[i] = PITABLE[L[i + 1] ^ L[i + T8]];
  const K = new Uint16Array(64);
  for (let i = 0; i < 64; i++) K[i] = L[2 * i] | (L[2 * i + 1] << 8);
  return K;
}
const S = [1, 2, 3, 5];
function decryptBlock(K, b) {
  const R = [b[0] | (b[1] << 8), b[2] | (b[3] << 8), b[4] | (b[5] << 8), b[6] | (b[7] << 8)];
  let j = 63;
  const rmix = () => {
    for (let i = 3; i >= 0; i--) {
      R[i] = ((R[i] >>> S[i]) | (R[i] << (16 - S[i]))) & 0xffff;
      R[i] = (R[i] - K[j--] - (R[(i + 3) & 3] & R[(i + 2) & 3]) - (~R[(i + 3) & 3] & R[(i + 1) & 3])) & 0xffff;
    }
  };
  const rmash = () => { for (let i = 3; i >= 0; i--) R[i] = (R[i] - K[R[(i + 3) & 3] & 63]) & 0xffff; };
  for (let k = 0; k < 5; k++) rmix();
  rmash();
  for (let k = 0; k < 6; k++) rmix();
  rmash();
  for (let k = 0; k < 5; k++) rmix();
  return Buffer.from([R[0] & 255, R[0] >> 8, R[1] & 255, R[1] >> 8, R[2] & 255, R[2] >> 8, R[3] & 255, R[3] >> 8]);
}
// bits efetivos: 40 (rc2-40-cbc) ou 128.
function decryptCbc(key, bits, iv, data) {
  if (data.length % 8) throw new Error('bad decrypt');
  const K = expand(key, bits);
  const out = Buffer.alloc(data.length);
  let prev = iv;
  for (let o = 0; o < data.length; o += 8) {
    const blk = data.subarray(o, o + 8);
    const p = decryptBlock(K, blk);
    for (let i = 0; i < 8; i++) out[o + i] = p[i] ^ prev[i];
    prev = blk;
  }
  const pad = out[out.length - 1];
  if (pad < 1 || pad > 8 || !out.subarray(out.length - pad).every((x) => x === pad)) throw new Error('bad decrypt');
  return out.subarray(0, out.length - pad);
}
module.exports = { decryptCbc };
