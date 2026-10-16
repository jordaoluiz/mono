// Pote de cookies (RFC 6265, o essencial): guarda o Set-Cookie das respostas e monta o header Cookie das próximas.
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.MonoCookies = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const isIp = (h) => /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':');
  const defaultPath = (pathname) => { const p = pathname || '/'; if (!p.startsWith('/') || p === '/') return '/'; const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
  const domainMatch = (host, domain) => host === domain || (host.endsWith('.' + domain) && !isIp(host));
  const pathMatch = (reqPath, cookiePath) => reqPath === cookiePath || (reqPath.startsWith(cookiePath) && (cookiePath.endsWith('/') || reqPath[cookiePath.length] === '/'));

  function parse(header, url, now = Date.now()) {
    let u; try { u = new URL(url); } catch { return null; }
    const parts = String(header || '').split(';');
    const first = parts.shift() || '';
    const eq = first.indexOf('=');
    if (eq < 1) return null;
    const c = { name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1'), domain: u.hostname.toLowerCase(), hostOnly: true, path: defaultPath(u.pathname), expires: null, secure: false, httpOnly: false, sameSite: '', created: now };
    for (const p of parts) {
      const i = p.indexOf('=');
      const k = (i === -1 ? p : p.slice(0, i)).trim().toLowerCase();
      const v = i === -1 ? '' : p.slice(i + 1).trim();
      if (k === 'domain' && v) {
        const d = v.replace(/^\./, '').toLowerCase();
        if (!domainMatch(c.domain, d)) return null; // servidor não pode criar cookie de outro domínio
        c.domain = d; c.hostOnly = false;
      } else if (k === 'path' && v.startsWith('/')) c.path = v;
      else if (k === 'max-age' && /^-?\d+$/.test(v)) c.expires = now + Number(v) * 1000;
      else if (k === 'expires' && c.expires == null) { const t = Date.parse(v); if (!Number.isNaN(t)) c.expires = t; }
      else if (k === 'secure') c.secure = true;
      else if (k === 'httponly') c.httpOnly = true;
      else if (k === 'samesite') c.sameSite = v;
    }
    return c;
  }
  // Guarda os Set-Cookie de uma resposta no pote (substitui nome+domínio+caminho; expirado remove).
  function store(jar, url, setCookies, now = Date.now()) {
    let n = 0;
    for (const sc of setCookies || []) {
      const c = parse(sc, url, now);
      if (!c) continue;
      const i = jar.findIndex((x) => x.name === c.name && x.domain === c.domain && x.path === c.path);
      if (c.expires != null && c.expires <= now) { if (i >= 0) jar.splice(i, 1); n++; continue; }
      if (i >= 0) { c.created = jar[i].created; jar[i] = c; } else jar.push(c);
      n++;
    }
    return n;
  }
  const purge = (jar, now = Date.now()) => { for (let i = jar.length - 1; i >= 0; i--) if (jar[i].expires != null && jar[i].expires <= now) jar.splice(i, 1); };
  // Valor do header Cookie para uma URL ('' se nenhum).
  function headerFor(jar, url, now = Date.now()) {
    let u; try { u = new URL(url); } catch { return ''; }
    const host = u.hostname.toLowerCase(), path = u.pathname || '/';
    return jar.filter((c) => (c.expires == null || c.expires > now) && (c.hostOnly ? host === c.domain : domainMatch(host, c.domain)) && pathMatch(path, c.path) && (!c.secure || u.protocol === 'https:' || u.protocol === 'wss:' || host === 'localhost'))
      .sort((a, b) => b.path.length - a.path.length || a.created - b.created)
      .map((c) => `${c.name}=${c.value}`).join('; ');
  }
  const setCookiesOf = (headers) => (headers || []).filter((x) => /^set-cookie$/i.test(x.key)).map((x) => x.value);
  return { parse, store, purge, headerFor, setCookiesOf, domainMatch };
});
