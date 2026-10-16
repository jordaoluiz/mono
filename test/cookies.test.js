'use strict';
const assert = require('assert');
const C = require('../src/shared/cookies');
const now = Date.parse('2026-10-16T12:00:00Z');
const jar = [];
assert.strictEqual(C.store(jar, 'https://api.loja.com/auth/login', [
  'sid=abc123; Path=/; HttpOnly; Secure; SameSite=Lax',
  'pref=dark; Domain=.loja.com; Path=/; Max-Age=3600',
  'tmp=1; Path=/auth',
  'evil=1; Domain=outro.com',
  'velho=1; Expires=Wed, 01 Jan 2020 00:00:00 GMT',
], now), 4);
assert.deepStrictEqual(jar.map((c) => c.name).sort(), ['pref', 'sid', 'tmp']);
assert.strictEqual(C.headerFor(jar, 'https://api.loja.com/auth/me', now), 'tmp=1; sid=abc123; pref=dark');
assert.strictEqual(C.headerFor(jar, 'https://api.loja.com/pedidos', now), 'sid=abc123; pref=dark');
assert.strictEqual(C.headerFor(jar, 'https://www.loja.com/', now), 'pref=dark', 'Domain vale para subdomínios; host-only não');
assert.strictEqual(C.headerFor(jar, 'http://api.loja.com/', now), 'pref=dark', 'Secure só em https');
assert.strictEqual(C.headerFor(jar, 'https://loja.com.br/', now), '');
assert.strictEqual(C.headerFor(jar, 'https://api.loja.com/authx', now), 'sid=abc123; pref=dark', 'path /auth não casa /authx');
assert.strictEqual(C.headerFor(jar, 'https://api.loja.com/', now + 2 * 3600e3), 'sid=abc123', 'Max-Age expira');
// substituir e remover
C.store(jar, 'https://api.loja.com/', ['sid=novo; Path=/'], now);
assert.match(C.headerFor(jar, 'https://api.loja.com/', now), /sid=novo/);
C.store(jar, 'https://api.loja.com/', ['sid=; Path=/; Max-Age=0'], now);
assert.ok(!/sid=/.test(C.headerFor(jar, 'https://api.loja.com/', now)));
assert.deepStrictEqual(C.setCookiesOf([{ key: 'Set-Cookie', value: 'a=1' }, { key: 'content-type', value: 'x' }, { key: 'set-cookie', value: 'b=2' }]), ['a=1', 'b=2']);
console.log('ok — cookies passaram');
