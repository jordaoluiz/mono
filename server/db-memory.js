// Banco em memória com a mesma interface do db-mongo.js — para testes e para rodar sem MongoDB.
'use strict';
const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
const dup = () => Object.assign(new Error('duplicado'), { code: 'DUP' });

function createMemoryDb() {
  const users = new Map(), sessions = new Map(), workspaces = new Map(), invites = new Map();
  const changes = [], comments = new Map(), monitorRuns = [];
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
    async usersByIds(ids) { return ids.map((id) => users.get(id)).filter(Boolean).map(clone); },
    async updateUser(id, fields) { const u = users.get(id); if (u) for (const [k, v] of Object.entries(fields)) { if (v === null) delete u[k]; else u[k] = clone(v); } },
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
    async setMemberRole(id, userId, role) { const w = workspaces.get(id); const m = w && w.members.find((x) => x.userId === userId); if (m) m.role = role; },
    // histórico de alterações
    async addChange(c) { changes.push(clone(c)); },
    async listChanges(wsId, { limit = 100, before = Infinity, itemId = null } = {}) {
      return changes.filter((c) => c.wsId === wsId && c.version < before && (!itemId || c.items.some((i) => i.id === itemId)))
        .sort((a, b) => b.version - a.version).slice(0, limit).map(clone);
    },
    async changeById(id) { return clone(changes.find((c) => c.id === id) || null); },
    async changesAfter(wsId, version) { return changes.filter((c) => c.wsId === wsId && c.version > version).map(({ id, version: v, items, by }) => clone({ id, version: v, items, by })); },
    async markUndone(id, undoneBy) { const c = changes.find((x) => x.id === id); if (c) c.undoneBy = undoneBy; },
    async pruneChanges(wsId, keep) {
      const mine = changes.filter((c) => c.wsId === wsId).sort((a, b) => b.version - a.version).slice(keep);
      for (const c of mine) changes.splice(changes.indexOf(c), 1);
    },
    async deleteChangesOfWorkspace(wsId) { for (let i = changes.length - 1; i >= 0; i--) if (changes[i].wsId === wsId) changes.splice(i, 1); },
    // comentários
    async addComment(c) { comments.set(c.id, clone(c)); },
    async listComments(wsId) { return [...comments.values()].filter((c) => c.wsId === wsId).sort((a, b) => a.at.localeCompare(b.at)).map(clone); },
    async commentById(id) { return clone(comments.get(id) || null); },
    async updateComment(id, fields) { const c = comments.get(id); if (c) Object.assign(c, clone(fields)); },
    async deleteComment(id) { comments.delete(id); },
    async deleteCommentsOfWorkspace(wsId) { for (const [k, c] of comments) if (c.wsId === wsId) comments.delete(k); },
    // resultados de monitores
    async addMonitorRun(r) { monitorRuns.push(clone(r)); },
    async listMonitorRuns(wsId, limit = 200) { return monitorRuns.filter((r) => r.wsId === wsId).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit).map(clone); },
    async pruneMonitorRuns(wsId, monitorId, keep) {
      const mine = monitorRuns.filter((r) => r.wsId === wsId && r.monitorId === monitorId).sort((a, b) => b.at.localeCompare(a.at)).slice(keep);
      for (const r of mine) monitorRuns.splice(monitorRuns.indexOf(r), 1);
    },
    async deleteMonitorRunsOfWorkspace(wsId) { for (let i = monitorRuns.length - 1; i >= 0; i--) if (monitorRuns[i].wsId === wsId) monitorRuns.splice(i, 1); },
  };
}

module.exports = { createMemoryDb };
