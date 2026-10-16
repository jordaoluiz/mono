// Mock server local: responde com os exemplos salvos nas requisições de uma coleção.
// Escuta só em 127.0.0.1 (nada fica exposto na rede) e libera CORS para o front rodar no navegador.
'use strict';
const http = require('http');

const { matchPath, pickExample, norm } = require('./shared/mockroutes');

function createMock({ onHit = () => {} } = {}) {
  let server = null, routes = [], delay = 0, port = 0;

  function find(method, path) {
    let best = null, bestScore = -1;
    for (const r of routes) {
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const s = matchPath(r.path, path);
      if (s > bestScore) { best = r; bestScore = s; }
    }
    return best;
  }

  function handle(req, res) {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    const path = norm(url.pathname);
    const cors = {
      'access-control-allow-origin': req.headers.origin || '*',
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS',
      'access-control-allow-headers': req.headers['access-control-request-headers'] || '*',
      'access-control-expose-headers': '*',
    };
    const finish = (status, headers, body, matched) => {
      const send = () => {
        res.writeHead(status, { ...cors, 'x-mono-mock': '1', ...headers });
        res.end(req.method === 'HEAD' ? undefined : body);
        onHit({ at: Date.now(), method: req.method, path: url.pathname + url.search, status, matched, ms: Date.now() - started });
      };
      if (delay > 0) setTimeout(send, delay); else send();
    };
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.writeHead(204, cors); res.end(); return;
    }
    req.resume();
    const route = find(req.method, path);
    if (!route) {
      const list = routes.map((r) => `${r.method} ${r.path}`);
      return finish(404, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ error: 'Nenhum exemplo salvo para esta rota no Mono.', rota: `${req.method} ${path}`, rotasDisponiveis: list }, null, 2), null);
    }
    const ex = pickExample(route, req.headers['x-mono-example'] || url.searchParams.get('__example'));
    const headers = {};
    for (const hd of ex.headers || []) {
      const k = String(hd.key || '').toLowerCase();
      if (!k || ['content-length', 'transfer-encoding', 'connection', 'content-encoding'].includes(k)) continue;
      headers[k] = String(hd.value ?? '');
    }
    if (!headers['content-type'] && ex.contentType) headers['content-type'] = ex.contentType;
    finish(Number(ex.status) || 200, headers, ex.body == null ? '' : String(ex.body), { request: route.request, example: ex.name, reqId: route.reqId });
  }

  return {
    async start(opts = {}) {
      await this.stop();
      routes = opts.routes || []; delay = Math.max(0, Number(opts.delay) || 0);
      const wanted = opts.port === 0 ? 0 : Number(opts.port) || 4010;
      server = http.createServer(handle);
      await new Promise((resolve, reject) => {
        server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new Error(`A porta ${wanted} já está em uso. Escolha outra.`) : e));
        server.listen(wanted, '127.0.0.1', resolve);
      });
      port = server.address().port;
      return { running: true, port, url: `http://localhost:${port}`, routes: routes.length };
    },
    update(opts = {}) {
      if (opts.routes) routes = opts.routes;
      if (opts.delay !== undefined) delay = Math.max(0, Number(opts.delay) || 0);
      return this.status();
    },
    async stop() {
      if (!server) return { running: false };
      const s = server; server = null;
      await new Promise((r) => { s.close(() => r()); s.closeAllConnections?.(); });
      return { running: false };
    },
    status() { return server ? { running: true, port, url: `http://localhost:${port}`, routes: routes.length, delay } : { running: false }; },
  };
}

module.exports = { createMock };
