// Rotas do mock server a partir dos exemplos salvos (usado pela interface e pelo processo principal).
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.MonoMockRoutes = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VAR_SEG = /^(\{\{.+\}\}|:[\w-]+|\{[\w-]+\})$/; // {{id}}, :id, {id}
  const norm = (p) => '/' + String(p || '').split('?')[0].split('#')[0].split('/').filter(Boolean).join('/');

  // Caminho da requisição sem host/baseUrl: "{{baseUrl}}/booking/{{id}}" → "/booking/{{id}}".
  function pathOf(rawUrl) {
    let u = String(rawUrl || '').trim();
    u = u.replace(/^\{\{[^}]+\}\}/, ''); // {{baseUrl}} no começo
    u = u.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, ''); // esquema + host
    if (!u.startsWith('/')) u = '/' + u.replace(/^[^/]*/, ''); // host sem esquema: "api.x.com/a" → "/a"
    return norm(u);
  }

  function matchPath(pattern, path) {
    const a = pattern.split('/').filter(Boolean), b = path.split('/').filter(Boolean);
    if (a.length !== b.length) return -1;
    let score = 0;
    for (let i = 0; i < a.length; i++) {
      if (VAR_SEG.test(a[i])) continue;
      if (a[i].toLowerCase() !== decodeURIComponent(b[i]).toLowerCase()) return -1;
      score += 1;
    }
    return score; // mais segmentos fixos = rota mais específica
  }

  // rotas: [{ method, path, request, examples: [{ id, name, status, statusText, headers, body }] }]
  function routesFromCollection(col) {
    const out = [];
    for (const r of (col && col.requests) || []) {
      const examples = (r.examples || []).filter((e) => e && e.status);
      if (!examples.length) continue;
      out.push({ method: String(r.method || 'GET').toUpperCase(), path: pathOf(r.url), request: r.name, reqId: r.id, examples });
    }
    return out;
  }

  function pickExample(route, wanted) {
    const ex = route.examples;
    if (wanted) {
      const w = String(wanted).toLowerCase();
      const hit = ex.find((e) => String(e.name || '').toLowerCase() === w) || ex.find((e) => String(e.status) === w);
      if (hit) return hit;
    }
    return ex.find((e) => e.isDefault) || ex.find((e) => e.status >= 200 && e.status < 300) || ex[0];
  }

  return { pathOf, matchPath, routesFromCollection, pickExample, norm };
});
