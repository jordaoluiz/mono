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
const unpackWs = (d) => { if (!d) return null; const { dataJson, ...rest } = d; return { ...rest, data: dataJson ? JSON.parse(dataJson) : {} }; };

function createMongoDb(uri, dbName = 'mono') {
  const client = new MongoClient(uri, { appName: 'mono-server', maxPoolSize: 20 });
  let users, sessions, workspaces, invites;
  return {
    kind: 'MongoDB',
    async init() {
      await client.connect();
      const db = client.db(dbName);
      users = db.collection('users');
      sessions = db.collection('sessions');
      workspaces = db.collection('workspaces');
      invites = db.collection('invites');
      await Promise.all([
        users.createIndex({ username: 1 }, { unique: true }),
        sessions.createIndex({ tokenHash: 1 }, { unique: true }),
        sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
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
    async searchUsers(prefix, limit) {
      const list = await users.find({ username: { $regex: '^' + escRe(prefix) } }, { projection: { username: 1, name: 1 } })
        .sort({ username: 1 }).limit(limit).toArray();
      return list.map((u) => ({ id: u._id, username: u.username, name: u.name || '' }));
    },
    // sessões (o índice TTL apaga as vencidas)
    async createSession(s) { await sessions.insertOne({ ...s, createdAt: new Date(s.createdAt), expiresAt: new Date(s.expiresAt) }); },
    async sessionByHash(h) { return sessions.findOne({ tokenHash: h, expiresAt: { $gt: new Date() } }, { projection: { _id: 0 } }); },
    async deleteSession(h) { await sessions.deleteOne({ tokenHash: h }); },
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
  };
}

module.exports = { createMongoDb };
