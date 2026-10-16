// Servidor do Mono: contas (@username + senha), workspaces compartilhados, convites e eventos em tempo real (SSE).
// HTTP puro do Node, sem framework. O app fala só com este servidor; só ele tem acesso ao banco.
'use strict';
const http = require('http');
const crypto = require('crypto');
const { promisify } = require('util');
const Sync = require('../src/shared/sync');

const scrypt = promisify(crypto.scrypt);
const MAX_BODY = 16 * 1024 * 1024;
const MAX_DATA = 15 * 1024 * 1024;
const SESSION_DAYS = 180;
const HEARTBEAT_MS = 25000;

const rid = (p) => p + crypto.randomBytes(12).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function checkPassword(pw, stored) {
  const [alg, N, r, p, salt, key] = String(stored || '').split('$');
  if (alg !== 'scrypt') return false;
  const want = Buffer.from(key, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(want, got);
}
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name || '' });
const summary = (w) => ({ id: w.id, name: w.name, description: w.description || '', ownerId: w.ownerId, members: w.members, version: w.version, updatedAt: w.updatedAt });

function createApp({ db, log = () => {}, now = () => new Date() }) {
  // ---------- tempo real ----------
  const streams = new Map(); // userId -> Set<{ res, clientId }>
  function emit(userIds, event, payload, exceptClient = null) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const uid of new Set(userIds)) {
      for (const s of streams.get(uid) || []) if (s.clientId !== exceptClient || !exceptClient) s.res.write(msg);
    }
  }
  const memberIds = (w) => w.members.map((m) => m.userId);
  const heartbeat = setInterval(() => { for (const set of streams.values()) for (const s of set) s.res.write(': ping\n\n'); }, HEARTBEAT_MS);
  heartbeat.unref?.();

  // ---------- limite de tentativas (login/cadastro) ----------
  const tries = new Map();
  function limit(ip, max = 20, windowMs = 10 * 60 * 1000) {
    const t = Date.now();
    const list = (tries.get(ip) || []).filter((x) => t - x < windowMs);
    list.push(t); tries.set(ip, list);
    if (list.length > max) fail(429, 'Muitas tentativas. Espere alguns minutos e tente de novo.');
  }

  // ---------- gravação serializada por workspace ----------
  const queues = new Map();
  function serial(key, fn) {
    const prev = queues.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    queues.set(key, run.finally(() => { if (queues.get(key) === run) queues.delete(key); }));
    return run;
  }

  async function newSession(user) {
    const token = 'mono_' + crypto.randomBytes(32).toString('base64url');
    const created = now();
    await db.createSession({ tokenHash: sha(token), userId: user.id, createdAt: created.toISOString(), expiresAt: new Date(created.getTime() + SESSION_DAYS * 864e5).toISOString() });
    return { token, user: publicUser(user) };
  }
  async function auth(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!m) fail(401, 'Entre na sua conta do Mono.');
    const s = await db.sessionByHash(sha(m[1]));
    if (!s) fail(401, 'Sessão expirada. Entre de novo.');
    const u = await db.userById(s.userId);
    if (!u) fail(401, 'Conta não encontrada.');
    return { user: u, tokenHash: sha(m[1]) };
  }
  async function memberWs(id, user) {
    const w = await db.getWorkspace(id);
    if (!w || !w.members.some((m) => m.userId === user.id)) fail(404, 'Workspace não encontrado ou você não faz mais parte dele.');
    return w;
  }
  const cleanName = (s, max) => String(s || '').trim().slice(0, max);

  // ---------- rotas ----------
  const routes = [];
  const route = (method, pattern, handler, { open = false } = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, open });
  };

  route('GET', '/health', async () => ({ ok: true, db: db.kind }), { open: true });

  route('POST', '/v1/register', async ({ body, ip }) => {
    limit(ip);
    const username = Sync.normUser(body.username);
    if (!Sync.USERNAME.test(username)) fail(400, 'O @ precisa ter de 3 a 30 caracteres: letras minúsculas, números, ponto ou _ (sem começar ou terminar com ponto ou _).');
    const password = String(body.password || '');
    if (password.length < 8) fail(400, 'A senha precisa ter pelo menos 8 caracteres.');
    if (password.length > 200) fail(400, 'Senha longa demais.');
    if (await db.userByName(username)) fail(409, `O @${username} já está em uso. Escolha outro.`);
    const user = { id: rid('usr_'), username, name: cleanName(body.name, 60), passHash: await hashPassword(password), createdAt: now().toISOString() };
    try { await db.createUser(user); }
    catch (e) { if (e.code === 'DUP') fail(409, `O @${username} já está em uso. Escolha outro.`); throw e; }
    log(`cadastro @${username}`);
    return newSession(user);
  }, { open: true });

  route('POST', '/v1/login', async ({ body, ip }) => {
    limit(ip);
    const username = Sync.normUser(body.username);
    const u = Sync.USERNAME.test(username) ? await db.userByName(username) : null;
    const ok = await checkPassword(String(body.password || ''), u ? u.passHash : DUMMY_HASH);
    if (!u || !ok) fail(401, '@ ou senha incorretos.');
    return newSession(u);
  }, { open: true });

  route('POST', '/v1/logout', async ({ me }) => { await db.deleteSession(me.tokenHash); return { ok: true }; });
  route('GET', '/v1/me', async ({ me }) => ({ user: publicUser(me.user) }));

  route('GET', '/v1/users', async ({ query, me }) => {
    const q = Sync.normUser(query.get('q'));
    if (q.length < 2 || !/^[a-z0-9._]+$/.test(q)) return { users: [] };
    return { users: (await db.searchUsers(q, 8)).filter((u) => u.id !== me.user.id) };
  });

  route('GET', '/v1/workspaces', async ({ me }) => ({ workspaces: (await db.listWorkspacesFor(me.user.id)).map(summary) }));

  route('POST', '/v1/workspaces', async ({ body, me }) => {
    const name = cleanName(body.name, 60);
    if (!name) fail(400, 'Dê um nome ao workspace.');
    const data = Sync.shareable(body.data || {});
    if (JSON.stringify(data).length > MAX_DATA) fail(413, 'Workspace grande demais para compartilhar (limite de 15 MB).');
    const t = now().toISOString();
    const w = { id: rid('sws_'), name, description: cleanName(body.description, 140), ownerId: me.user.id,
      members: [{ userId: me.user.id, username: me.user.username, name: me.user.name || '', role: 'owner', joinedAt: t }],
      version: 1, data, createdAt: t, updatedAt: t };
    await db.createWorkspace(w);
    log(`workspace ${w.id} criado por @${me.user.username}`);
    return { workspace: { ...summary(w), data } };
  });

  route('GET', '/v1/workspaces/:id', async ({ params, me }) => {
    const w = await memberWs(params.id, me.user);
    return { workspace: { ...summary(w), data: w.data, invites: (await db.invitesOfWorkspace(w.id)).map((i) => ({ id: i.id, username: i.toUsername })) } };
  });

  route('PATCH', '/v1/workspaces/:id', async ({ params, body, me }) => {
    const w = await memberWs(params.id, me.user);
    const fields = {};
    if (body.name !== undefined) { fields.name = cleanName(body.name, 60); if (!fields.name) fail(400, 'Dê um nome ao workspace.'); }
    if (body.description !== undefined) fields.description = cleanName(body.description, 140);
    await db.updateWorkspaceMeta(w.id, fields);
    emit(memberIds(w), 'workspace', { ws: w.id, ...fields, by: me.user.username });
    return { ok: true };
  });

  route('DELETE', '/v1/workspaces/:id', async ({ params, me }) => {
    const w = await memberWs(params.id, me.user);
    if (w.ownerId !== me.user.id) fail(403, 'Só quem criou o workspace pode excluí-lo para todos. Você pode sair dele.');
    await db.deleteWorkspace(w.id);
    await db.deleteInvitesOfWorkspace(w.id);
    emit(memberIds(w), 'removed', { ws: w.id, reason: 'deleted', by: me.user.username });
    return { ok: true };
  });

  route('POST', '/v1/workspaces/:id/ops', async ({ params, body, me }) => {
    const err = Sync.validOps(body.ops);
    if (err) fail(400, err);
    if (!body.ops.length) { const w = await memberWs(params.id, me.user); return { version: w.version }; }
    return serial(params.id, async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const w = await memberWs(params.id, me.user);
        const data = Sync.applyOps(w.data || {}, body.ops);
        if (JSON.stringify(data).length > MAX_DATA) fail(413, 'Workspace passou do limite de 15 MB.');
        const version = w.version + 1;
        if (await db.updateWorkspaceData(w.id, w.version, data, version)) {
          emit(memberIds(w), 'ops', { ws: w.id, version, ops: body.ops, by: me.user.username }, String(body.clientId || ''));
          return { version };
        }
      }
      fail(409, 'O workspace mudou ao mesmo tempo. Tente de novo.');
    });
  });

  route('POST', '/v1/workspaces/:id/invites', async ({ params, body, me }) => {
    const w = await memberWs(params.id, me.user);
    const username = Sync.normUser(body.username);
    const to = Sync.USERNAME.test(username) ? await db.userByName(username) : null;
    if (!to) fail(404, `Não existe ninguém com o @${username || '?'} no Mono.`);
    if (w.members.some((m) => m.userId === to.id)) fail(409, `@${username} já faz parte deste workspace.`);
    const inv = { id: rid('inv_'), wsId: w.id, wsName: w.name, wsDescription: w.description || '', from: { userId: me.user.id, username: me.user.username, name: me.user.name || '' },
      toUserId: to.id, toUsername: to.username, status: 'pending', createdAt: now().toISOString() };
    try { await db.createInvite(inv); }
    catch (e) { if (e.code === 'DUP') fail(409, `@${username} já tem um convite pendente para este workspace.`); throw e; }
    const pub = { id: inv.id, ws: w.id, wsName: w.name, wsDescription: inv.wsDescription, from: inv.from, createdAt: inv.createdAt };
    emit([to.id], 'invite', pub);
    emit(memberIds(w), 'invited', { ws: w.id, username: to.username, by: me.user.username });
    return { invite: { id: inv.id, username: to.username } };
  });

  route('DELETE', '/v1/workspaces/:id/members/:userId', async ({ params, me }) => {
    const w = await memberWs(params.id, me.user);
    const target = w.members.find((m) => m.userId === params.userId);
    if (!target) fail(404, 'Essa pessoa não faz parte do workspace.');
    const self = target.userId === me.user.id;
    if (!self && w.ownerId !== me.user.id) fail(403, 'Só quem criou o workspace pode remover pessoas.');
    if (self && w.ownerId === me.user.id) fail(400, 'Você criou este workspace: para sair, exclua-o para todos.');
    await db.removeMember(w.id, target.userId);
    const members = w.members.filter((m) => m.userId !== target.userId);
    emit([target.userId], 'removed', { ws: w.id, reason: self ? 'left' : 'kicked', by: me.user.username });
    emit(members.map((m) => m.userId), 'members', { ws: w.id, members, left: target.username, by: me.user.username });
    return { ok: true };
  });

  route('GET', '/v1/invites', async ({ me }) => ({
    invites: (await db.invitesFor(me.user.id)).map((i) => ({ id: i.id, ws: i.wsId, wsName: i.wsName, wsDescription: i.wsDescription || '', from: i.from, createdAt: i.createdAt })),
  }));

  route('POST', '/v1/invites/:id/:answer', async ({ params, me }) => {
    if (!['accept', 'decline'].includes(params.answer)) fail(404, 'Rota não encontrada.');
    const inv = await db.inviteById(params.id);
    if (!inv || inv.toUserId !== me.user.id || inv.status !== 'pending') fail(404, 'Convite não encontrado ou já respondido.');
    const w = await db.getWorkspace(inv.wsId);
    if (!w) { await db.setInviteStatus(inv.id, 'expired'); fail(410, 'Esse workspace foi excluído.'); }
    if (params.answer === 'decline') {
      await db.setInviteStatus(inv.id, 'declined');
      emit(memberIds(w), 'declined', { ws: w.id, username: me.user.username });
      return { ok: true };
    }
    const member = { userId: me.user.id, username: me.user.username, name: me.user.name || '', role: 'editor', joinedAt: now().toISOString() };
    await db.addMember(w.id, member);
    await db.setInviteStatus(inv.id, 'accepted');
    const fresh = await db.getWorkspace(w.id);
    emit(memberIds(fresh), 'members', { ws: w.id, members: fresh.members, joined: me.user.username, by: me.user.username });
    log(`@${me.user.username} entrou em ${w.id}`);
    return { workspace: { ...summary(fresh), data: fresh.data } };
  });

  // Eventos em tempo real (Server-Sent Events): funciona através de proxy corporativo como uma requisição comum.
  route('GET', '/v1/events', async ({ req, res, me, query }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    const entry = { res, clientId: String(query.get('clientId') || '') };
    const set = streams.get(me.user.id) || new Set();
    set.add(entry); streams.set(me.user.id, set);
    res.write(`event: hello\ndata: ${JSON.stringify({ user: publicUser(me.user) })}\n\n`);
    req.on('close', () => { set.delete(entry); if (!set.size) streams.delete(me.user.id); });
    return undefined; // resposta fica aberta
  });

  // ---------- servidor ----------
  async function readBody(req) {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > MAX_BODY) fail(413, 'Requisição grande demais.'); chunks.push(c); }
    if (!chunks.length) return {};
    try { const b = JSON.parse(Buffer.concat(chunks).toString('utf8')); return b && typeof b === 'object' ? b : {}; }
    catch { fail(400, 'JSON inválido.'); }
  }
  const send = (res, status, obj) => {
    if (res.headersSent) return;
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    try {
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) fail(404, 'Rota não encontrada.');
      const m = r.re.exec(url.pathname);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const me = r.open ? null : await auth(req);
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
      const out = await r.handler({ req, res, params, body, me, query: url.searchParams, ip });
      if (out !== undefined) send(res, 200, out);
    } catch (e) {
      if (e instanceof HttpError) send(res, e.status, { error: e.message });
      else { log('erro: ' + (e && e.stack || e)); send(res, 500, { error: 'Erro no servidor do Mono.' }); }
    }
  });
  server.on('close', () => clearInterval(heartbeat));
  server.closeStreams = () => { for (const set of streams.values()) for (const s of set) s.res.end(); streams.clear(); };
  return server;
}

module.exports = { createApp, hashPassword, checkPassword };
