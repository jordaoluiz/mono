// MongoDB (Atlas). A URI vem só da variável de ambiente MONGODB_URI do servidor — nunca do app.
'use strict';
const { MongoClient } = require('mongodb');

const dupOf = (e) => (e && e.code === 11000 ? Object.assign(new Error('duplicado'), { code: 'DUP' }) : e);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fromDoc = (d) => { if (!d) return null; const { _id, ...rest } = d; return { id: _id, ...rest }; };
const toDoc = (o) => { const { id, ...rest } = o; return { _id: id, ...rest }; };
// O conteúdo do workspace vai como texto JSON: coleções importadas podem ter chaves como "$ref" e "a.b",
// que o MongoDB restringe em nomes de campo. Nada precisa ser consultado lá dentro.
const packWs = (w) => { const { data, ...rest } = w; return { ...rest, dataJson: JSON.stringify(data || {}) }; };
const unpackChange = (d) => { if (!d) return null; const { opsJson, inverseJson, ...rest } = fromDoc(d); return { ...rest, ops: opsJson ? JSON.parse(opsJson) : [], inverse: inverseJson ? JSON.parse(inverseJson) : [] }; };
const unpackWs = (d) => { if (!d) return null; const { dataJson, ...rest } = d; return { ...rest, data: dataJson ? JSON.parse(dataJson) : {} }; };

function createMongoDb(uri, dbName = 'mono') {
  const client = new MongoClient(uri, { appName: 'mono-server', maxPoolSize: 20 });
  let users, sessions, workspaces, invites, changes, comments, monitorRuns;
  return {
    kind: 'MongoDB',
    async init() {
      await client.connect();
      const db = client.db(dbName);
      users = db.collection('users');
      sessions = db.collection('sessions');
      workspaces = db.collection('workspaces');
      invites = db.collection('invites');
      changes = db.collection('changes');
      comments = db.collection('comments');
      monitorRuns = db.collection('monitorRuns');
      await Promise.all([
        changes.createIndex({ wsId: 1, version: -1 }),
        changes.createIndex({ wsId: 1, 'items.id': 1 }),
        comments.createIndex({ wsId: 1, at: 1 }),
        monitorRuns.createIndex({ wsId: 1, at: -1 }),
        monitorRuns.createIndex({ wsId: 1, monitorId: 1, at: -1 }),
        users.createIndex({ username: 1 }, { unique: true }),
        sessions.createIndex({ tokenHash: 1 }, { unique: true }),
        sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        sessions.createIndex({ userId: 1 }),
        workspaces.createIndex({ 'members.userId': 1 }),
        invites.createIndex({ toUserId: 1, status: 1 }),
        invites.createIndex({ wsId: 1, toUserId: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } }),
      ]);
    },
    async close() { await client.close(); },
    // usuários
    async createUser(u) { try { await users.insertOne(toDoc({ ...u, createdAt: new Date(u.createdAt) })); } catch (e) { throw dupOf(e); } },
    async userByName(username) { return fromDoc(await users.findOne({ username })); },
    async userById(id) { return fromDoc(await users.findOne({ _id: id })); },
    async usersByIds(ids) { return (await users.find({ _id: { $in: ids } }, { projection: { passHash: 0 } }).toArray()).map(fromDoc); },
    async updateUser(id, fields) {
      const set = {}, unset = {};
      for (const [k, v] of Object.entries(fields)) { if (v === null) unset[k] = ''; else set[k] = v; }
      await users.updateOne({ _id: id }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    },
    async searchUsers(prefix, limit) {
      const list = await users.find({ username: { $regex: '^' + escRe(prefix) } }, { projection: { username: 1, name: 1 } })
        .sort({ username: 1 }).limit(limit).toArray();
      return list.map((u) => ({ id: u._id, username: u.username, name: u.name || '' }));
    },
    // sessões (o índice TTL apaga as vencidas)
    async createSession(s) { await sessions.insertOne({ ...s, createdAt: new Date(s.createdAt), expiresAt: new Date(s.expiresAt) }); },
    async sessionByHash(h) { return sessions.findOne({ tokenHash: h, expiresAt: { $gt: new Date() } }, { projection: { _id: 0 } }); },
    async deleteSession(h) { await sessions.deleteOne({ tokenHash: h }); },
    async listSessions(userId) { return sessions.find({ userId, expiresAt: { $gt: new Date() } }, { projection: { _id: 0 } }).sort({ lastUsedAt: -1 }).limit(100).toArray(); },
    async deleteSessionById(userId, id) { const s = await sessions.findOneAndDelete({ userId, id }); const doc = s && (s.value !== undefined ? s.value : s); return doc ? doc.tokenHash : null; },
    async deleteSessionsOfUser(userId, exceptHash = null) {
      const q = { userId, ...(exceptHash ? { tokenHash: { $ne: exceptHash } } : {}) };
      const list = await sessions.find(q, { projection: { tokenHash: 1 } }).toArray();
      await sessions.deleteMany(q);
      return list.map((s) => s.tokenHash);
    },
    async touchSession(h, at) { await sessions.updateOne({ tokenHash: h }, { $set: { lastUsedAt: at } }); },
    // workspaces
    async createWorkspace(w) { await workspaces.insertOne(toDoc(packWs(w))); },
    async getWorkspace(id) { return unpackWs(fromDoc(await workspaces.findOne({ _id: id }))); },
    async listWorkspacesFor(userId) {
      return (await workspaces.find({ 'members.userId': userId }, { projection: { dataJson: 0 } }).toArray()).map(fromDoc);
    },
    async updateWorkspaceData(id, expectVersion, data, version) {
      const r = await workspaces.updateOne({ _id: id, version: expectVersion }, { $set: { dataJson: JSON.stringify(data), version, updatedAt: new Date().toISOString() } });
      return r.modifiedCount === 1;
    },
    async updateWorkspaceMeta(id, fields) { await workspaces.updateOne({ _id: id }, { $set: fields }); },
    async addMember(id, member) {
      const r = await workspaces.updateOne({ _id: id, 'members.userId': { $ne: member.userId } }, { $push: { members: member } });
      return r.modifiedCount === 1;
    },
    async removeMember(id, userId) { await workspaces.updateOne({ _id: id }, { $pull: { members: { userId } } }); },
    async deleteWorkspace(id) { await workspaces.deleteOne({ _id: id }); },
    // convites
    async createInvite(inv) { try { await invites.insertOne(toDoc(inv)); } catch (e) { throw dupOf(e); } },
    async invitesFor(userId) { return (await invites.find({ toUserId: userId, status: 'pending' }).sort({ createdAt: -1 }).toArray()).map(fromDoc); },
    async invitesOfWorkspace(wsId) { return (await invites.find({ wsId, status: 'pending' }).toArray()).map(fromDoc); },
    async inviteById(id) { return fromDoc(await invites.findOne({ _id: id })); },
    async setInviteStatus(id, status) { await invites.updateOne({ _id: id }, { $set: { status, answeredAt: new Date().toISOString() } }); },
    async deleteInvitesOfWorkspace(wsId) { await invites.deleteMany({ wsId }); },
    async setMemberRole(id, userId, role) { await workspaces.updateOne({ _id: id, 'members.userId': userId }, { $set: { 'members.$.role': role } }); },
    // histórico (operações guardadas como texto, pelo mesmo motivo do conteúdo do workspace)
    async addChange(c) { const { ops, inverse, ...rest } = c; await changes.insertOne(toDoc({ ...rest, opsJson: JSON.stringify(ops), inverseJson: JSON.stringify(inverse) })); },
    async listChanges(wsId, { limit = 100, before = Infinity, itemId = null } = {}) {
      const q = { wsId, ...(Number.isFinite(before) ? { version: { $lt: before } } : {}), ...(itemId ? { 'items.id': itemId } : {}) };
      return (await changes.find(q).sort({ version: -1 }).limit(limit).toArray()).map(unpackChange);
    },
    async changeById(id) { return unpackChange(await changes.findOne({ _id: id })); },
    async changesAfter(wsId, version) {
      return (await changes.find({ wsId, version: { $gt: version } }, { projection: { opsJson: 0, inverseJson: 0 } }).toArray()).map(fromDoc);
    },
    async markUndone(id, undoneBy) { await changes.updateOne({ _id: id }, { $set: { undoneBy } }); },
    async pruneChanges(wsId, keep) {
      const old = await changes.find({ wsId }, { projection: { version: 1 } }).sort({ version: -1 }).skip(keep).limit(1).toArray();
      if (old.length) await changes.deleteMany({ wsId, version: { $lte: old[0].version } });
    },
    async deleteChangesOfWorkspace(wsId) { await changes.deleteMany({ wsId }); },
    // comentários
    async addComment(c) { await comments.insertOne(toDoc(c)); },
    async listComments(wsId) { return (await comments.find({ wsId }).sort({ at: 1 }).limit(5000).toArray()).map(fromDoc); },
    async commentById(id) { return fromDoc(await comments.findOne({ _id: id })); },
    async updateComment(id, fields) { await comments.updateOne({ _id: id }, { $set: fields }); },
    async deleteComment(id) { await comments.deleteOne({ _id: id }); },
    async deleteCommentsOfWorkspace(wsId) { await comments.deleteMany({ wsId }); },
    // resultados de monitores
    async addMonitorRun(r) { await monitorRuns.insertOne(toDoc(r)); },
    async listMonitorRuns(wsId, limit = 200) { return (await monitorRuns.find({ wsId }).sort({ at: -1 }).limit(limit).toArray()).map(fromDoc); },
    async pruneMonitorRuns(wsId, monitorId, keep) {
      const old = await monitorRuns.find({ wsId, monitorId }, { projection: { at: 1 } }).sort({ at: -1 }).skip(keep).limit(1).toArray();
      if (old.length) await monitorRuns.deleteMany({ wsId, monitorId, at: { $lte: old[0].at } });
    },
    async deleteMonitorRunsOfWorkspace(wsId) { await monitorRuns.deleteMany({ wsId }); },
  };
}

module.exports = { createMongoDb };
