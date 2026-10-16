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
class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const fail = (status, msg, extra) => { throw new HttpError(status, msg, extra); };

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

const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name || '', color: u.color || '', avatar: u.avatar || '', publicKey: u.publicKey || '' });
// Avatar: imagem pequena (o app recorta e reduz para 128×128) guardada como data URL; ou só a cor da inicial.
const AVATAR_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_AVATAR = 90 * 1024;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
// Cofre: o servidor só guarda material cifrado (chave pública, backup da chave privada cifrado com a senha, chaves embrulhadas).
const B64_RE = /^[A-Za-z0-9+/=_-]+$/;
const okB64 = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max && B64_RE.test(s);
const okBlob = (b, fields, max = 2000) => b && typeof b === 'object' && !Array.isArray(b) && fields.every((f) => okB64(b[f], max)) && Object.keys(b).length <= fields.length + 3;
const summary = (w) => ({ id: w.id, name: w.name, description: w.description || '', ownerId: w.ownerId, members: w.members, version: w.version, updatedAt: w.updatedAt, vault: w.vault && w.vault.enabled ? { enabled: true, kid: w.vault.kid } : { enabled: false } });

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
    const run = prev.then(fn);
    const tail = run.catch(() => {}).finally(() => { if (queues.get(key) === tail) queues.delete(key); });
    queues.set(key, tail);
    return run;
  }

  const deviceOf = (req) => String(req.headers['x-mono-device'] || 'Mono').replace(/[\u0000-\u001f]/g, '').slice(0, 120);
  async function newSession(user, req, ip) {
    const token = 'mono_' + crypto.randomBytes(32).toString('base64url');
    const created = now().toISOString();
    await db.createSession({ id: rid('ses_'), tokenHash: sha(token), userId: user.id, device: deviceOf(req), ip: String(ip || '').slice(0, 64), createdAt: created, lastUsedAt: created, expiresAt: new Date(now().getTime() + SESSION_DAYS * 864e5).toISOString() });
    return { token, user: publicUser(user) };
  }
  async function auth(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!m) fail(401, 'Entre na sua conta do Mono.');
    const hash = sha(m[1]);
    const s = await db.sessionByHash(hash);
    if (!s) fail(401, 'Sessão expirada. Entre de novo.');
    const u = await db.userById(s.userId);
    if (!u) fail(401, 'Conta não encontrada.');
    if (!s.lastUsedAt || now() - new Date(s.lastUsedAt) > 10 * 60000) db.touchSession(hash, now().toISOString()).catch(() => {});
    return { user: u, tokenHash: hash, session: s };
  }
  // Derruba na hora as conexões em tempo real das sessões encerradas (o app recebe 401 e sai da conta).
  function kickSessions(userId, hashes) {
    const set = streams.get(userId);
    if (!set) return;
    for (const s of [...set]) if (hashes.includes(s.tokenHash)) { s.res.write('event: logout\ndata: {}\n\n'); s.res.end(); set.delete(s); }
  }
  // Códigos de recuperação: 10 códigos de uso único (só o hash fica no banco).
  const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  function newRecoveryCodes() {
    const codes = Array.from({ length: 10 }, () => {
      const b = crypto.randomBytes(12);
      const s = [...b].map((x) => CODE_ABC[x % CODE_ABC.length]).join('');
      return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
    });
    return { codes, stored: codes.map((c) => ({ h: sha('mono-rec:' + normCode(c)), usedAt: null })) };
  }
  const recoveryLeft = (u) => (u.recovery || []).filter((r) => !r.usedAt).length;
  async function memberWs(id, user) {
    const w = await db.getWorkspace(id);
    if (!w || !w.members.some((m) => m.userId === user.id)) fail(404, 'Workspace não encontrado ou você não faz mais parte dele.');
    return w;
  }
  const cleanName = (s, max) => String(s || '').trim().slice(0, max);
  const roleOf = (w, user) => (w.members.find((m) => m.userId === user.id) || {}).role;
  const canEdit = (w, user) => roleOf(w, user) !== 'viewer';
  const mustEdit = (w, user) => { if (!canEdit(w, user)) fail(403, 'Você tem acesso só de leitura neste workspace.'); };
  const byOf = (u) => ({ userId: u.id, username: u.username, name: u.name || '' });
  const CHANGES_KEEP = 500;

  // Grava um lote de operações, registra no histórico (com o inverso, para desfazer) e avisa os membros.
  async function applyBatch(wsId, ops, user, { clientId = '', undoOf = null } = {}) {
    return serial(wsId, async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const w = await memberWs(wsId, user);
        mustEdit(w, user);
        const before = Sync.shareable(w.data || {});
        const inverse = Sync.inverseOps(before, ops);
        const items = Sync.itemsOf(ops, before);
        const data = Sync.applyOps(w.data || {}, ops);
        if (JSON.stringify(data).length > MAX_DATA) fail(413, 'Workspace passou do limite de 15 MB.');
        const version = w.version + 1;
        if (await db.updateWorkspaceData(w.id, w.version, data, version)) {
          const change = { id: rid('chg_'), wsId: w.id, version, by: byOf(user), at: now().toISOString(), summary: Sync.describe(ops, before), items, ...(undoOf ? { undoOf } : {}) };
          await db.addChange({ ...change, ops, inverse });
          if (version % 25 === 0) db.pruneChanges(w.id, CHANGES_KEEP).catch(() => {});
          emit(memberIds(w), 'ops', { ws: w.id, version, ops, by: user.username, change }, undoOf ? '' : clientId);
          return { version, change };
        }
      }
      fail(409, 'O workspace mudou ao mesmo tempo. Tente de novo.');
    });
  }

  // ---------- presença (quem está no workspace e com qual requisição aberta) ----------
  const presence = new Map();   // wsId -> Map<clientId, { userId, username, name, reqId, at }>
  const wsMembers = new Map();  // wsId -> [userId] (para avisar sem ir ao banco)
  const clientWs = new Map();   // clientId -> wsId
  function presenceOf(wsId) {
    const byUser = new Map();
    for (const p of (presence.get(wsId) || new Map()).values()) {
      const u = byUser.get(p.userId) || { userId: p.userId, username: p.username, name: p.name, reqIds: [] };
      if (p.reqId && !u.reqIds.includes(p.reqId)) u.reqIds.push(p.reqId);
      byUser.set(p.userId, u);
    }
    return [...byUser.values()];
  }
  const broadcastPresence = (wsId) => emit(wsMembers.get(wsId) || [], 'presence', { ws: wsId, users: presenceOf(wsId) });
  function leavePresence(clientId) {
    const wsId = clientWs.get(clientId);
    if (!wsId) return;
    clientWs.delete(clientId);
    const m = presence.get(wsId);
    if (m) { m.delete(clientId); if (!m.size) presence.delete(wsId); }
    broadcastPresence(wsId);
  }

  // ---------- rotas ----------
  const routes = [];
  const route = (method, pattern, handler, { open = false } = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, open });
  };

  route('GET', '/health', async () => ({ ok: true, db: db.kind }), { open: true });

  route('POST', '/v1/register', async ({ req, body, ip }) => {
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
    const rec = newRecoveryCodes();
    await db.updateUser(user.id, { recovery: rec.stored });
    return { ...(await newSession(user, req, ip)), recoveryCodes: rec.codes };
  }, { open: true });

  route('POST', '/v1/login', async ({ req, body, ip }) => {
    limit(ip);
    const username = Sync.normUser(body.username);
    const u = Sync.USERNAME.test(username) ? await db.userByName(username) : null;
    const ok = await checkPassword(String(body.password || ''), u ? u.passHash : DUMMY_HASH);
    if (!u || !ok) fail(401, '@ ou senha incorretos.');
    return newSession(u, req, ip);
  }, { open: true });

  route('POST', '/v1/logout', async ({ me }) => { await db.deleteSession(me.tokenHash); return { ok: true }; });
  route('GET', '/v1/me', async ({ me }) => ({ user: publicUser(me.user), recoveryLeft: recoveryLeft(me.user), keyBackup: me.user.keyBackup || null }));

  // Trocar senha: confere a atual e encerra as outras sessões.
  route('POST', '/v1/me/password', async ({ body, me, ip }) => {
    limit('pw:' + ip);
    if (!(await checkPassword(String(body.current || ''), me.user.passHash))) fail(401, 'Senha atual incorreta.');
    const next = String(body.next || '');
    if (next.length < 8) fail(400, 'A nova senha precisa ter pelo menos 8 caracteres.');
    if (next.length > 200) fail(400, 'Senha longa demais.');
    const fields = { passHash: await hashPassword(next) };
    if (body.keyBackup !== undefined) { if (body.keyBackup && !okBlob(body.keyBackup, ['salt', 'iv', 'ct'])) fail(400, 'Backup de chave inválido.'); fields.keyBackup = body.keyBackup || null; }
    await db.updateUser(me.user.id, fields);
    const gone = await db.deleteSessionsOfUser(me.user.id, me.tokenHash);
    kickSessions(me.user.id, gone);
    return { ok: true, signedOut: gone.length };
  });
  // Novos códigos de recuperação (os antigos deixam de valer).
  route('POST', '/v1/me/recovery-codes', async ({ body, me, ip }) => {
    limit('pw:' + ip);
    if (!(await checkPassword(String(body.password || ''), me.user.passHash))) fail(401, 'Senha incorreta.');
    const rec = newRecoveryCodes();
    await db.updateUser(me.user.id, { recovery: rec.stored });
    return { recoveryCodes: rec.codes };
  });
  // Esqueci a senha: @ + um código de recuperação + nova senha. Encerra todas as sessões.
  route('POST', '/v1/recover', async ({ req, body, ip }) => {
    limit('rec:' + ip, 10);
    const username = Sync.normUser(body.username);
    const u = Sync.USERNAME.test(username) ? await db.userByName(username) : null;
    const h = sha('mono-rec:' + normCode(body.code));
    const rec = u ? (u.recovery || []) : [];
    const hit = rec.find((r) => !r.usedAt && crypto.timingSafeEqual(Buffer.from(r.h), Buffer.from(h)));
    if (!u || !hit) fail(401, '@ ou código de recuperação incorretos (cada código vale uma vez).');
    const next = String(body.password || '');
    if (next.length < 8) fail(400, 'A nova senha precisa ter pelo menos 8 caracteres.');
    hit.usedAt = now().toISOString();
    await db.updateUser(u.id, { recovery: rec, passHash: await hashPassword(next), keyBackup: null });
    const gone = await db.deleteSessionsOfUser(u.id);
    kickSessions(u.id, gone);
    log(`@${username} recuperou o acesso`);
    const fresh = await db.userById(u.id);
    return { ...(await newSession(fresh, req, ip)), recoveryLeft: recoveryLeft(fresh) };
  }, { open: true });
  // Onde estou logado.
  route('GET', '/v1/me/sessions', async ({ me }) => ({
    sessions: (await db.listSessions(me.user.id)).map((s) => ({ id: s.id, device: s.device || 'Mono', ip: s.ip || '', createdAt: s.createdAt, lastUsedAt: s.lastUsedAt || s.createdAt, current: s.tokenHash === me.tokenHash }))
      .sort((a, b) => (b.current - a.current) || String(b.lastUsedAt).localeCompare(String(a.lastUsedAt))),
  }));
  route('DELETE', '/v1/me/sessions/:sid', async ({ params, me }) => {
    const h = await db.deleteSessionById(me.user.id, params.sid);
    if (!h) fail(404, 'Sessão não encontrada.');
    kickSessions(me.user.id, [h]);
    return { ok: true };
  });
  route('DELETE', '/v1/me/sessions', async ({ me }) => {
    const gone = await db.deleteSessionsOfUser(me.user.id, me.tokenHash);
    kickSessions(me.user.id, gone);
    return { ok: true, signedOut: gone.length };
  });

  // Perfil: nome, cor e foto. Quem divide workspace com a pessoa recebe a mudança na hora.
  route('PATCH', '/v1/me', async ({ body, me }) => {
    const fields = {};
    if (body.name !== undefined) fields.name = cleanName(body.name, 60);
    if (body.color !== undefined) { if (body.color && !COLOR_RE.test(body.color)) fail(400, 'Cor inválida.'); fields.color = body.color || null; }
    if (body.publicKey !== undefined) { if (body.publicKey && !okB64(body.publicKey, 400)) fail(400, 'Chave pública inválida.'); fields.publicKey = body.publicKey || null; }
    if (body.keyBackup !== undefined) { if (body.keyBackup && !okBlob(body.keyBackup, ['salt', 'iv', 'ct'])) fail(400, 'Backup de chave inválido.'); fields.keyBackup = body.keyBackup || null; }
    if (body.avatar !== undefined) {
      if (body.avatar && (!AVATAR_RE.test(body.avatar) || body.avatar.length > MAX_AVATAR)) fail(400, 'Imagem inválida ou grande demais (até 90 KB, PNG, JPEG ou WebP).');
      fields.avatar = body.avatar || null;
    }
    await db.updateUser(me.user.id, fields);
    const user = publicUser(await db.userById(me.user.id));
    const peers = new Set([me.user.id]);
    for (const w of await db.listWorkspacesFor(me.user.id)) for (const m of w.members) peers.add(m.userId);
    emit([...peers], 'profile', { user });
    return { user };
  });
  // Perfis (cor e foto) de quem aparece no app: membros, autores de comentários e do histórico.
  route('GET', '/v1/profiles', async ({ query }) => {
    const ids = String(query.get('ids') || '').split(',').map((s) => s.trim()).filter((s) => s && s.length <= 80).slice(0, 100);
    return { users: (await db.usersByIds(ids)).map(publicUser) };
  });

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
    return { workspace: { ...summary(w), data: w.data, invites: (await db.invitesOfWorkspace(w.id)).map((i) => ({ id: i.id, username: i.toUsername, role: i.role || 'editor' })) } };
  });

  route('PATCH', '/v1/workspaces/:id', async ({ params, body, me }) => {
    const w = await memberWs(params.id, me.user);
    mustEdit(w, me.user);
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
    await Promise.all([db.deleteChangesOfWorkspace(w.id), db.deleteCommentsOfWorkspace(w.id), db.deleteMonitorRunsOfWorkspace(w.id)]);
    presence.delete(w.id);
    emit(memberIds(w), 'removed', { ws: w.id, reason: 'deleted', by: me.user.username });
    return { ok: true };
  });

  route('POST', '/v1/workspaces/:id/ops', async ({ params, body, me }) => {
    const err = Sync.validOps(body.ops);
    if (err) fail(400, err);
    if (!body.ops.length) { const w = await memberWs(params.id, me.user); return { version: w.version }; }
    const r = await applyBatch(params.id, body.ops, me.user, { clientId: String(body.clientId || '') });
    return { version: r.version, change: r.change };
  });

  // Histórico de alterações (mais recentes primeiro). ?item=<id> filtra por requisição/pasta/coleção.
  route('GET', '/v1/workspaces/:id/changes', async ({ params, query, me }) => {
    const w = await memberWs(params.id, me.user);
    const before = query.get('before') ? Number(query.get('before')) : Infinity;
    const limit = Math.min(Number(query.get('limit')) || 50, 100);
    const list = await db.listChanges(w.id, { limit, before, itemId: query.get('item') || null });
    return { changes: list.map((c) => {
      const big = JSON.stringify(c.ops).length + JSON.stringify(c.inverse).length > 200000;
      const { wsId, ...rest } = c;
      return big ? { ...rest, ops: null, inverse: null, large: true } : rest;
    }) };
  });

  // Desfaz uma alteração aplicando o inverso como uma alteração nova (fica no histórico também).
  route('POST', '/v1/workspaces/:id/changes/:cid/undo', async ({ params, body, me }) => {
    const w = await memberWs(params.id, me.user);
    mustEdit(w, me.user);
    const c = await db.changeById(params.cid);
    if (!c || c.wsId !== w.id) fail(404, 'Alteração não encontrada (o histórico guarda as últimas 500).');
    if (c.undoneBy) fail(409, `Essa alteração já foi desfeita por @${c.undoneBy.username}.`);
    const keys = new Set(c.items.map((i) => i.t + ':' + i.id));
    const later = (await db.changesAfter(w.id, c.version)).filter((x) => x.items.some((i) => keys.has(i.t + ':' + i.id)));
    if (later.length && !body.force) {
      fail(409, 'Esses itens foram alterados depois. Desfazer vai sobrescrever essas alterações.', { conflicts: later.map((x) => ({ id: x.id, version: x.version, by: x.by.username })) });
    }
    if (!c.inverse || !c.inverse.length) fail(400, 'Não há o que desfazer nessa alteração.');
    const r = await applyBatch(w.id, c.inverse, me.user, { undoOf: c.id });
    await db.markUndone(c.id, { username: me.user.username, at: now().toISOString(), changeId: r.change.id });
    return { version: r.version, change: r.change };
  });

  // ---------- cofre de segredos (criptografia de ponta a ponta) ----------
  const vaultMeta = (v) => (v && v.enabled ? { enabled: true, kid: v.kid, needsRotation: !!v.needsRotation, keys: Object.fromEntries(Object.entries(v.keys || {}).map(([k, b]) => [k, { fp: b.fp, kid: b.kid }])) } : { enabled: false });
  route('GET', '/v1/workspaces/:id/vault', async ({ params, me }) => {
    const w = await memberWs(params.id, me.user);
    const v = w.vault || {};
    return { vault: { ...vaultMeta(v), myKey: v.enabled ? (v.keys || {})[me.user.id] || null : null } };
  });
  // Ligar/girar (enabled + kid + keys com replace) ou só acrescentar chaves embrulhadas para membros.
  route('PUT', '/v1/workspaces/:id/vault', async ({ params, body, me }) => serial('vault:' + params.id, async () => {
    const w = await memberWs(params.id, me.user);
    const v = w.vault || { enabled: false, keys: {} };
    const memberSet = new Set(w.members.map((m) => m.userId));
    const keys = body.keys && typeof body.keys === 'object' ? body.keys : {};
    for (const [uid, b] of Object.entries(keys)) {
      if (!memberSet.has(uid)) fail(400, 'Chave para quem não é membro.');
      if (!okBlob(b, ['epk', 'iv', 'ct', 'fp', 'kid'], 1200)) fail(400, 'Chave embrulhada inválida.');
    }
    let next;
    if (body.enabled === false) {
      if (w.ownerId !== me.user.id) fail(403, 'Só quem criou o workspace desliga o cofre.');
      next = { enabled: false, keys: {} };
    } else if (body.replace) {
      mustEdit(w, me.user);
      if (v.enabled && v.kid !== body.prevKid) fail(409, 'O cofre mudou ao mesmo tempo. Tente de novo.');
      if (!okB64(body.kid, 64)) fail(400, 'Identificador da chave inválido.');
      if (!keys[me.user.id]) fail(400, 'Inclua a sua própria chave.');
      next = { enabled: true, kid: body.kid, keys, needsRotation: false, by: me.user.username, at: now().toISOString() };
    } else {
      if (!v.enabled) fail(409, 'O cofre deste workspace está desligado.');
      for (const b of Object.values(keys)) if (b.kid !== v.kid) fail(409, 'Chave de uma versão antiga do cofre.');
      next = { ...v, keys: { ...(v.keys || {}), ...keys } };
    }
    await db.updateWorkspaceMeta(w.id, { vault: next });
    emit(memberIds(w), 'vault', { ws: w.id, vault: vaultMeta(next), by: me.user.username });
    return { vault: vaultMeta(next) };
  }));

  // ---------- comentários ----------
  route('GET', '/v1/workspaces/:id/comments', async ({ params, me }) => {
    const w = await memberWs(params.id, me.user);
    return { comments: (await db.listComments(w.id)).map(({ wsId, ...c }) => c) };
  });
  route('POST', '/v1/workspaces/:id/comments', async ({ params, body, me }) => {
    const w = await memberWs(params.id, me.user);
    const text = String(body.text || '').trim().slice(0, 4000);
    if (!text) fail(400, 'Escreva o comentário.');
    if (!body.reqId || String(body.reqId).length > 120) fail(400, 'Requisição inválida.');
    const c = { id: rid('cmt_'), wsId: w.id, reqId: String(body.reqId), colId: String(body.colId || '').slice(0, 120), text, by: byOf(me.user), at: now().toISOString(), resolved: false };
    await db.addComment(c);
    const { wsId, ...pub } = c;
    emit(memberIds(w), 'comment', { ws: w.id, action: 'add', comment: pub });
    return { comment: pub };
  });
  route('PATCH', '/v1/workspaces/:id/comments/:cid', async ({ params, body, me }) => {
    const w = await memberWs(params.id, me.user);
    const c = await db.commentById(params.cid);
    if (!c || c.wsId !== w.id) fail(404, 'Comentário não encontrado.');
    const fields = {};
    if (body.text !== undefined) {
      if (c.by.userId !== me.user.id) fail(403, 'Só quem escreveu pode editar o comentário.');
      fields.text = String(body.text || '').trim().slice(0, 4000);
      if (!fields.text) fail(400, 'Escreva o comentário.');
      fields.editedAt = now().toISOString();
    }
    if (body.resolved !== undefined) { fields.resolved = !!body.resolved; fields.resolvedBy = body.resolved ? me.user.username : null; }
    await db.updateComment(c.id, fields);
    const { wsId, ...pub } = { ...c, ...fields };
    emit(memberIds(w), 'comment', { ws: w.id, action: 'update', comment: pub });
    return { comment: pub };
  });
  route('DELETE', '/v1/workspaces/:id/comments/:cid', async ({ params, me }) => {
    const w = await memberWs(params.id, me.user);
    const c = await db.commentById(params.cid);
    if (!c || c.wsId !== w.id) fail(404, 'Comentário não encontrado.');
    if (c.by.userId !== me.user.id && w.ownerId !== me.user.id) fail(403, 'Só quem escreveu (ou quem criou o workspace) pode apagar.');
    await db.deleteComment(c.id);
    emit(memberIds(w), 'comment', { ws: w.id, action: 'delete', comment: { id: c.id, reqId: c.reqId } });
    return { ok: true };
  });

  // ---------- monitores: o app de quem roda o monitor envia o resultado, o time vê ----------
  route('GET', '/v1/workspaces/:id/monitor-runs', async ({ params, me }) => {
    const w = await memberWs(params.id, me.user);
    return { runs: (await db.listMonitorRuns(w.id, 300)).map(({ wsId, ...r }) => r) };
  });
  route('POST', '/v1/workspaces/:id/monitor-runs', async ({ params, body, me }) => {
    const w = await memberWs(params.id, me.user);
    const str = (v, n) => String(v ?? '').slice(0, n);
    if (!body.monitorId) fail(400, 'Monitor inválido.');
    const run = {
      id: rid('run_'), wsId: w.id, monitorId: str(body.monitorId, 120), name: str(body.name, 120), ok: !!body.ok,
      total: Number(body.total) || 0, failed: Number(body.failed) || 0, durationMs: Number(body.durationMs) || 0,
      failures: (Array.isArray(body.failures) ? body.failures : []).slice(0, 20).map((f) => ({ name: str(f && f.name, 200), error: str(f && f.error, 400) })),
      by: byOf(me.user), at: now().toISOString(),
    };
    await db.addMonitorRun(run);
    db.pruneMonitorRuns(w.id, run.monitorId, 60).catch(() => {});
    const { wsId, ...pub } = run;
    emit(memberIds(w), 'monitor', { ws: w.id, run: pub });
    return { run: pub };
  });

  // ---------- presença ----------
  route('POST', '/v1/presence', async ({ body, me }) => {
    const clientId = String(body.clientId || '').slice(0, 80);
    if (!clientId) fail(400, 'clientId obrigatório.');
    const prevWs = clientWs.get(clientId);
    if (!body.ws) { leavePresence(clientId); return { users: [] }; }
    const w = await memberWs(String(body.ws), me.user);
    wsMembers.set(w.id, memberIds(w));
    if (prevWs && prevWs !== w.id) leavePresence(clientId);
    if (!presence.has(w.id)) presence.set(w.id, new Map());
    presence.get(w.id).set(clientId, { userId: me.user.id, username: me.user.username, name: me.user.name || '', reqId: body.reqId ? String(body.reqId).slice(0, 120) : null, at: Date.now() });
    clientWs.set(clientId, w.id);
    broadcastPresence(w.id);
    return { users: presenceOf(w.id) };
  });

  route('POST', '/v1/workspaces/:id/invites', async ({ params, body, me }) => {
    const w = await memberWs(params.id, me.user);
    mustEdit(w, me.user);
    const username = Sync.normUser(body.username);
    const to = Sync.USERNAME.test(username) ? await db.userByName(username) : null;
    if (!to) fail(404, `Não existe ninguém com o @${username || '?'} no Mono.`);
    if (w.members.some((m) => m.userId === to.id)) fail(409, `@${username} já faz parte deste workspace.`);
    const role = body.role === 'viewer' ? 'viewer' : 'editor';
    const inv = { id: rid('inv_'), wsId: w.id, wsName: w.name, wsDescription: w.description || '', from: { userId: me.user.id, username: me.user.username, name: me.user.name || '' },
      toUserId: to.id, toUsername: to.username, role, status: 'pending', createdAt: now().toISOString() };
    try { await db.createInvite(inv); }
    catch (e) { if (e.code === 'DUP') fail(409, `@${username} já tem um convite pendente para este workspace.`); throw e; }
    const pub = { id: inv.id, ws: w.id, wsName: w.name, wsDescription: inv.wsDescription, from: inv.from, role, createdAt: inv.createdAt };
    emit([to.id], 'invite', pub);
    emit(memberIds(w), 'invited', { ws: w.id, username: to.username, role, by: me.user.username });
    return { invite: { id: inv.id, username: to.username, role } };
  });

  route('PATCH', '/v1/workspaces/:id/members/:userId', async ({ params, body, me }) => {
    const w = await memberWs(params.id, me.user);
    if (w.ownerId !== me.user.id) fail(403, 'Só quem criou o workspace muda o acesso das pessoas.');
    const target = w.members.find((m) => m.userId === params.userId);
    if (!target) fail(404, 'Essa pessoa não faz parte do workspace.');
    if (target.role === 'owner') fail(400, 'Quem criou o workspace sempre pode editar.');
    const role = body.role === 'viewer' ? 'viewer' : 'editor';
    await db.setMemberRole(w.id, target.userId, role);
    const members = w.members.map((m) => (m.userId === target.userId ? { ...m, role } : m));
    emit(members.map((m) => m.userId), 'members', { ws: w.id, members, roleChanged: target.username, role, by: me.user.username });
    return { ok: true };
  });

  route('DELETE', '/v1/workspaces/:id/members/:userId', async ({ params, me }) => {
    const w = await memberWs(params.id, me.user);
    const target = w.members.find((m) => m.userId === params.userId);
    if (!target) fail(404, 'Essa pessoa não faz parte do workspace.');
    const self = target.userId === me.user.id;
    if (!self && w.ownerId !== me.user.id) fail(403, 'Só quem criou o workspace pode remover pessoas.');
    if (self && w.ownerId === me.user.id) fail(400, 'Você criou este workspace: para sair, exclua-o para todos.');
    await db.removeMember(w.id, target.userId);
    if (w.vault && w.vault.enabled) {
      const keys = { ...(w.vault.keys || {}) }; delete keys[target.userId];
      await db.updateWorkspaceMeta(w.id, { vault: { ...w.vault, keys, needsRotation: true } });
    }
    const members = w.members.filter((m) => m.userId !== target.userId);
    emit([target.userId], 'removed', { ws: w.id, reason: self ? 'left' : 'kicked', by: me.user.username });
    emit(members.map((m) => m.userId), 'members', { ws: w.id, members, left: target.username, by: me.user.username });
    return { ok: true };
  });

  route('GET', '/v1/invites', async ({ me }) => ({
    invites: (await db.invitesFor(me.user.id)).map((i) => ({ id: i.id, ws: i.wsId, wsName: i.wsName, wsDescription: i.wsDescription || '', from: i.from, role: i.role || 'editor', createdAt: i.createdAt })),
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
    const member = { userId: me.user.id, username: me.user.username, name: me.user.name || '', role: inv.role === 'viewer' ? 'viewer' : 'editor', joinedAt: now().toISOString() };
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
    const entry = { res, clientId: String(query.get('clientId') || ''), tokenHash: me.tokenHash };
    const set = streams.get(me.user.id) || new Set();
    set.add(entry); streams.set(me.user.id, set);
    res.write(`event: hello\ndata: ${JSON.stringify({ user: publicUser(me.user) })}\n\n`);
    req.on('close', () => { set.delete(entry); if (!set.size) streams.delete(me.user.id); if (entry.clientId) leavePresence(entry.clientId); });
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
      if (e instanceof HttpError) send(res, e.status, { error: e.message, ...(e.extra || {}) });
      else { log('erro: ' + (e && e.stack || e)); send(res, 500, { error: 'Erro no servidor do Mono.' }); }
    }
  });
  server.on('close', () => clearInterval(heartbeat));
  server.closeStreams = () => { for (const set of streams.values()) for (const s of set) s.res.end(); streams.clear(); };
  return server;
}

module.exports = { createApp, hashPassword, checkPassword };
