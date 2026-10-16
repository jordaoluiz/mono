// Banco em memória com a mesma interface do db-mongo.js — para testes e para rodar sem MongoDB.
'use strict';
const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
const dup = () => Object.assign(new Error('duplicado'), { code: 'DUP' });

function createMemoryDb() {
  const users = new Map(), sessions = new Map(), workspaces = new Map(), invites = new Map();
  return {
    kind: 'memória',
    async init() {},
    async close() {},
    // usuários
    async createUser(u) {
      for (const x of users.values()) if (x.username === u.username) throw dup();
      users.set(u.id, clone(u));
    },
    async userByName(username) { for (const x of users.values()) if (x.username === username) return clone(x); return null; },
    async userById(id) { return clone(users.get(id) || null); },
    async searchUsers(prefix, limit) {
      return [...users.values()].filter((u) => u.username.startsWith(prefix)).sort((a, b) => a.username.localeCompare(b.username))
        .slice(0, limit).map((u) => ({ id: u.id, username: u.username, name: u.name || '' }));
    },
    // sessões
    async createSession(s) { sessions.set(s.tokenHash, clone(s)); },
    async sessionByHash(h) { const s = sessions.get(h); return s && new Date(s.expiresAt) > new Date() ? clone(s) : null; },
    async deleteSession(h) { sessions.delete(h); },
    // workspaces
    async createWorkspace(w) { workspaces.set(w.id, clone(w)); },
    async getWorkspace(id) { return clone(workspaces.get(id) || null); },
    async listWorkspacesFor(userId) {
      return [...workspaces.values()].filter((w) => w.members.some((m) => m.userId === userId))
        .map(({ data, ...rest }) => clone(rest));
    },
    async updateWorkspaceData(id, expectVersion, data, version) {
      const w = workspaces.get(id);
      if (!w || w.version !== expectVersion) return false;
      Object.assign(w, { data: clone(data), version, updatedAt: new Date().toISOString() });
      return true;
    },
    async updateWorkspaceMeta(id, fields) { const w = workspaces.get(id); if (w) Object.assign(w, clone(fields)); },
    async addMember(id, member) {
      const w = workspaces.get(id);
      if (!w || w.members.some((m) => m.userId === member.userId)) return false;
      w.members.push(clone(member));
      return true;
    },
    async removeMember(id, userId) { const w = workspaces.get(id); if (w) w.members = w.members.filter((m) => m.userId !== userId); },
    async deleteWorkspace(id) { workspaces.delete(id); },
    // convites
    async createInvite(inv) {
      for (const x of invites.values()) if (x.wsId === inv.wsId && x.toUserId === inv.toUserId && x.status === 'pending') throw dup();
      invites.set(inv.id, clone(inv));
    },
    async invitesFor(userId) { return [...invites.values()].filter((i) => i.toUserId === userId && i.status === 'pending').map(clone); },
    async invitesOfWorkspace(wsId) { return [...invites.values()].filter((i) => i.wsId === wsId && i.status === 'pending').map(clone); },
    async inviteById(id) { return clone(invites.get(id) || null); },
    async setInviteStatus(id, status) { const i = invites.get(id); if (i) Object.assign(i, { status, answeredAt: new Date().toISOString() }); },
    async deleteInvitesOfWorkspace(wsId) { for (const [k, i] of invites) if (i.wsId === wsId) invites.delete(k); },
  };
}

module.exports = { createMemoryDb };
