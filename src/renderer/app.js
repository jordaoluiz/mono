(() => {
'use strict';
const { $, $$, uid, esc, h, icons, fmtBytes, fmtTime, highlightJson, kvTable, toast, openModal, promptModal, confirmModal, showMenu, customSelect, copyButton } = window.UI;
const api = window.mono;

const HISTORY_MAX = 150;
const SCRIPT_TIMEOUT_MS = 10000; // sem contar o tempo de rede do pm.sendRequest

let data;                 // estado persistido
let side = 'collections'; // aba da barra lateral
let reqTab = 'params';    // sub-aba da requisição
let resTab = 'body';      // sub-aba da resposta
let resRaw = false;       // corpo formatado x bruto
let scriptWhich = null;   // Scripts: 'pre' (antes da requisição) ou 'post' (após a resposta)
const runtime = {};       // por aba: { loading, response, tests } — não persiste

// ---------- Modelo ----------
const clone = (o) => JSON.parse(JSON.stringify(o));
function newRequest(over = {}) {
  return {
    id: uid('req'), name: 'Nova requisição', method: 'GET', url: '',
    params: [], headers: [], body: { type: 'none', raw: '', form: [] },
    auth: { type: 'inherit' }, pre: '', tests: '', folderId: null, ...over,
  };
}
const session = () => (data.session ||= { tabs: [], active: null });
const activeTab = () => session().tabs.find((t) => t.id === session().active);
const rt = (tab) => (runtime[tab.id] ||= {});
const extraCols = new Set(); // coleções de outro workspace em uso por um monitor
function findRef(ref) {
  if (!ref) return null;
  let col = data.collections.find((c) => c.id === ref.colId);
  if (!col) for (const list of extraCols) { col = list.find((c) => c.id === ref.colId); if (col) break; }
  const req = col?.requests.find((r) => r.id === ref.reqId);
  return req ? { col, req } : null;
}
const Shape = window.MonoShape, Typegen = window.MonoTypegen, OpenApi = window.MonoOpenApi;
// ---------- Árvore: coleções > pastas > requisições ----------
const foldersOf = (col) => (col.folders ||= []);
const childFolders = (col, pid) => foldersOf(col).filter((f) => (f.parentId || null) === (pid || null));
const childReqs = (col, fid) => col.requests.filter((r) => (r.folderId || null) === (fid || null));
const folderById = (col, id) => foldersOf(col).find((f) => f.id === id) || null;
function folderSubtree(col, fid) {
  const ids = new Set([fid]);
  let grew = true;
  while (grew) { grew = false; for (const f of foldersOf(col)) if (ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true; } }
  return ids;
}
const countInFolder = (col, fid) => { const ids = folderSubtree(col, fid); return col.requests.filter((r) => ids.has(r.folderId)).length; };
function folderPath(col, fid) {
  const out = [];
  let f = folderById(col, fid);
  while (f) { out.unshift(f); f = folderById(col, f.parentId); }
  return out;
}
// Cadeia de herança de autorização: pasta mais próxima → … → coleção.
function authChain(col, fid) {
  return [...folderPath(col, fid).reverse().map((f) => ({ obj: f, name: f.name, kind: 'folder' })), { obj: col, name: col.name, kind: 'collection' }];
}
function inheritedAuth(col, fid) {
  for (const n of authChain(col, fid)) {
    const a = n.obj.auth;
    if (a && a.type && a.type !== 'inherit') return { auth: a, fromName: n.name, holder: n.obj };
  }
  return { auth: { type: 'none' }, fromName: col.name, holder: col };
}
function resolveAuth(tab, draft) {
  const a = draft.auth || { type: 'none' };
  if (a.type !== 'inherit') return a;
  const found = findRef(tab.ref);
  if (!found) return { type: 'none' };
  return inheritedAuth(found.col, found.req.folderId).auth;
}
async function prepareAuth(tab, req, vars) {
  const holder = resolveAuth(tab, tab.draft);
  if (holder.type === 'oauth2' && (await window.MonoAuth.ensureFresh(holder, vars))) persist();
  req.auth = clone(holder.type === 'inherit' ? { type: 'none' } : holder);
}

const envById = (id) => data.environments.find((e) => e.id === id) || null;
const activeEnv = () => envById(data.activeEnvId);
function listVars(list) {
  const out = {};
  for (const v of list || []) if (v.enabled !== false && v.key) out[v.key] = v.value ?? '';
  return out;
}
const varsOf = (env) => listVars(env?.vars);
const globalsOf = () => (data.globals ||= { vars: [] });
const tabCol = (tab) => findRef(tab?.ref)?.col || null;
// Escopos como no Postman: globais < coleção < ambiente < variáveis locais do script.
const scopeVars = (env, col) => ({ globals: listVars(globalsOf().vars), collection: listVars(col?.variables), environment: varsOf(env) });
function mergedVars(env, col, local) {
  const s = scopeVars(env, col);
  return { ...s.globals, ...s.collection, ...s.environment, ...(local || {}) };
}
const envVars = () => mergedVars(activeEnv(), tabCol(activeTab()));
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const isMutating = (m) => MUTATING.has(String(m).toUpperCase()) || !['GET', 'HEAD', 'OPTIONS'].includes(String(m).toUpperCase());
const fill = (s, vars) => String(s || '').replace(/\{\{\s*(\$?[\w.-]+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : (k[0] === '$' && window.MonoSandbox?.dynamicVar(k)) || m));

// ---------- Workspaces ----------
// Cada workspace tem suas coleções, ambientes, globais, histórico e abas. O ativo fica no topo de `data`
// (o resto do app não precisa saber que workspaces existem); os outros ficam guardados em workspaces[].data.
// Configurações (proxy, certificados, IA) e o tema valem para todos.
const WS_KEYS = ['collections', 'history', 'environments', 'activeEnvId', 'globals', 'session', 'snapshots', 'lastRun', 'monitors'];
const activeWorkspace = () => data.workspaces.find((w) => w.id === data.activeWorkspaceId);
function ensureWorkspaces() {
  data.workspaces ||= [];
  if (!data.workspaces.length) data.workspaces.push({ id: uid('ws'), name: 'Meu workspace', description: '', createdAt: Date.now(), data: null });
  if (!activeWorkspace()) data.activeWorkspaceId = data.workspaces[0].id;
  activeWorkspace().data = null;
}
function normalizeWorkspace() {
  data.collections ||= []; data.history ||= []; data.environments ||= []; data.globals ||= { vars: [] }; data.monitors ||= [];
  if (data.activeEnvId && !envById(data.activeEnvId)) data.activeEnvId = data.environments[0]?.id || '';
  const s = session();
  s.tabs = s.tabs.filter((t) => t && t.draft);
  if (!s.tabs.length) s.tabs.push({ id: uid('tab'), ref: null, draft: newRequest(), dirty: false });
  if (!s.tabs.some((t) => t.id === s.active)) s.active = s.tabs[0].id;
}
const wsData = (w) => (w.id === data.activeWorkspaceId ? data : (w.data || {}));
function wsStats(w) {
  const d = wsData(w);
  const cols = d.collections || [];
  return { cols: cols.length, reqs: cols.reduce((n, c) => n + (c.requests || []).length, 0), envs: (d.environments || []).length };
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const statsText = (st) => [plural(st.cols, 'coleção', 'coleções'), plural(st.reqs, 'requisição', 'requisições'), plural(st.envs, 'ambiente', 'ambientes')].join(' · ');
function snapshotWorkspace(w) {
  const d = wsData(w), out = {};
  for (const k of WS_KEYS) if (d[k] !== undefined) out[k] = clone(d[k]);
  return out;
}
function switchWorkspace(id, { quiet = false } = {}) {
  const target = data.workspaces.find((w) => w.id === id);
  if (!target || id === data.activeWorkspaceId) return;
  const cur = activeWorkspace();
  cur.data = {};
  for (const k of WS_KEYS) { if (data[k] !== undefined) cur.data[k] = data[k]; delete data[k]; }
  const next = target.data || {};
  for (const k of WS_KEYS) if (next[k] !== undefined) data[k] = next[k];
  target.data = null;
  data.activeWorkspaceId = id;
  for (const t of session().tabs) liveCloseTab(t);
  for (const k of Object.keys(runtime)) delete runtime[k];
  $('#modal').classList.add('hidden');
  $('#sideSearch').value = '';
  normalizeWorkspace();
  persist();
  renderWorkspaceBtn(); renderEnvSelect(); renderTabs(); renderRequest(); renderResponse(); renderSidebar();
  if (target.shared && loggedIn()) { loadComments(target); loadMonitorRuns(target); }
  renderMonAlert();
  if (!quiet) toast(`Workspace: ${target.name}`);
}
function renderWorkspaceBtn() {
  const w = activeWorkspace();
  if (!w) return;
  $('#wsName').textContent = w.name;
  const people = $('#wsPeople');
  const n = w.shared ? (w.shared.members || []).length : 0;
  people.className = 'ws-people' + (w.shared ? '' : ' hidden') + ' ' + (w.shared && loggedIn() ? cloud.state : 'off');
  $('.n', people).textContent = n;
  $('#wsReadonly').classList.toggle('hidden', !(w.shared && myRole(w) === 'viewer'));
  $('#wsInvites').classList.toggle('hidden', !cloud.invites.length);
  $('#wsInvites').textContent = cloud.invites.length;
  const sync = w.shared ? (loggedIn() ? { online: 'sincronizando em tempo real', connecting: 'conectando…', offline: 'sem conexão — as mudanças vão quando voltar' }[cloud.state] || 'desconectado' : 'entre na conta para sincronizar') : '';
  $('#wsBtn').title = `Workspace: ${w.name}${w.description ? ' — ' + w.description : ''}\n${statsText(wsStats(w))}${w.shared ? `\nCompartilhado com ${plural(n, 'pessoa', 'pessoas')} · ${sync}` : ''}${cloud.invites.length ? `\n${plural(cloud.invites.length, 'convite pendente', 'convites pendentes')}` : ''}`;
}
const ICON_PEOPLE = '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M15.5 5.2a3.2 3.2 0 0 1 0 5.6M17.5 13.6A5.5 5.5 0 0 1 20.5 19"/></svg>';
function openWorkspaceMenu(anchor) {
  const cur = activeWorkspace();
  const items = [];
  items.push(loggedIn()
    ? { label: h('span', { class: 'ws-mi acct' }, avatar({ userId: me().id, username: me().username, name: me().name }, 'md'), h('span', { class: 'ws-mi-name' }, '@' + me().username), h('span', { class: 'cloud-dot ' + cloud.state })), run: () => openAccount() }
    : { label: h('span', { class: 'ws-mi acct' }, h('span', { class: 'ws-mi-av off', html: ICON_PEOPLE }), h('span', { class: 'ws-mi-name' }, 'Entrar ou criar conta')), run: () => openAccount() });
  if (cloud.invites.length) {
    items.push('-');
    for (const inv of cloud.invites) items.push({ label: h('span', { class: 'ws-mi invite' }, h('span', { class: 'ws-mi-check inv' }), h('span', { class: 'ws-mi-name' }, h('b', {}, inv.wsName), h('small', {}, ' · convite de @' + inv.from.username))), run: () => openInvite(inv) });
  }
  items.push('-');
  for (const w of data.workspaces) items.push({
    label: h('span', { class: 'ws-mi' + (w === cur ? ' on' : '') },
      h('span', { class: 'ws-mi-check', html: w === cur ? icons.check : '' }),
      h('span', { class: 'ws-mi-name' }, w.name),
      w.shared ? h('span', { class: 'ws-mi-shared', title: 'Compartilhado', html: ICON_PEOPLE }) : null),
    run: () => switchWorkspace(w.id),
  });
  items.push('-');
  items.push({ label: cur.shared ? 'Pessoas e convites…' : 'Compartilhar este workspace…', run: () => openShare(cur) });
  if (cur.shared) items.push({ label: 'Histórico de alterações…', run: () => openHistory(cur) });
  items.push({ label: 'Monitores…', run: () => openMonitors(cur) });
  items.push({ label: '+ Novo workspace', run: () => openWorkspaceForm() }, { label: 'Gerenciar workspaces…', run: openWorkspaces });
  showMenu(anchor, items);
}
// Criar (sem `w`) ou editar nome/descrição.
function openWorkspaceForm(w = null, { back = null } = {}) {
  openModal((body, close) => {
    const name = h('input', { value: w ? w.name : '', placeholder: 'Ex.: Fiscal, Cliente X, Pessoal', spellcheck: 'false', maxlength: 60 });
    const desc = h('input', { value: w ? w.description || '' : '', placeholder: 'Opcional — para que serve este workspace', spellcheck: 'false', maxlength: 140 });
    const hasEnvs = data.environments.length || globalsOf().vars.some((v) => v.key);
    const copyEnvs = h('input', { type: 'checkbox' });
    const err = h('p', { class: 'ws-err hidden' });
    const submit = () => {
      const n = name.value.trim();
      if (!n) { err.textContent = 'Dê um nome ao workspace.'; err.classList.remove('hidden'); name.focus(); return; }
      if (data.workspaces.some((x) => x !== w && x.name.toLowerCase() === n.toLowerCase())) { err.textContent = 'Já existe um workspace com esse nome.'; err.classList.remove('hidden'); name.focus(); return; }
      close();
      if (w) {
        w.name = n; w.description = desc.value.trim(); persist(); renderWorkspaceBtn();
        if (w.shared && loggedIn()) cloudCall('PATCH', `/v1/workspaces/${w.shared.id}`, { name: w.name, description: w.description }).then((r) => { if (!r.ok) toast(r.error, 4000); });
        if (back) back();
        return;
      }
      const nw = { id: uid('ws'), name: n, description: desc.value.trim(), createdAt: Date.now(), data: { collections: [], history: [], environments: [], activeEnvId: '', globals: { vars: [] } } };
      if (copyEnvs.checked) {
        nw.data.environments = clone(data.environments).map((e) => ({ ...e, id: uid('env') }));
        const idx = data.environments.findIndex((e) => e.id === data.activeEnvId);
        nw.data.activeEnvId = idx >= 0 ? nw.data.environments[idx].id : '';
        nw.data.globals = clone(globalsOf());
      }
      data.workspaces.push(nw);
      switchWorkspace(nw.id, { quiet: true });
      toast(`Workspace “${n}” criado`);
    };
    for (const el of [name, desc]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    body.append(
      h('h2', {}, w ? 'Editar workspace' : 'Novo workspace'),
      h('p', { class: 'sub' }, w ? 'Nome e descrição aparecem no seletor do topo.' : 'Um espaço separado, com coleções, ambientes, variáveis globais, histórico e abas próprios. Configurações e tema continuam valendo para todos.'),
      h('div', { class: 'field' }, h('label', {}, 'Nome'), name),
      h('div', { class: 'field' }, h('label', {}, 'Descrição'), desc),
      !w && hasEnvs ? h('label', { class: 'check-row' }, copyEnvs, h('span', {}, h('b', {}, 'Copiar ambientes e variáveis globais'), ` de “${activeWorkspace().name}”`)) : null,
      err,
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn-ghost', onclick: () => { close(); if (back) back(); } }, 'Cancelar'),
        h('button', { class: 'btn-primary', onclick: submit }, w ? 'Salvar' : 'Criar workspace')));
    setTimeout(() => name.focus(), 0);
  });
}
function duplicateWorkspace(w) {
  let n = `${w.name} (cópia)`, i = 2;
  while (data.workspaces.some((x) => x.name === n)) n = `${w.name} (cópia ${i++})`;
  const copy = snapshotWorkspace(w);
  delete copy.session; delete copy.snapshots; delete copy.lastRun;
  copy.history = [];
  data.workspaces.splice(data.workspaces.indexOf(w) + 1, 0, { id: uid('ws'), name: n, description: w.description || '', createdAt: Date.now(), data: copy });
  persist();
  toast(`“${n}” criado`);
}
async function deleteWorkspace(w) {
  if (data.workspaces.length < 2) { toast('Precisa existir pelo menos um workspace.'); return false; }
  const owner = isOwner(w);
  const others = w.shared ? (w.shared.members || []).length - 1 : 0;
  const ok = await confirmModal(w.shared && loggedIn()
    ? owner
      ? { title: `Excluir “${w.name}” para todos?`, sub: `O workspace é apagado do servidor${others ? ` e ${plural(others, 'pessoa perde', 'pessoas perdem')} o acesso (cada uma fica com uma cópia local)` : ''}. ${statsText(wsStats(w))} saem deste computador.`, ok: 'Excluir para todos' }
      : { title: `Sair e apagar “${w.name}”?`, sub: 'Você sai do workspace compartilhado e a cópia deste computador é apagada. Os colegas continuam com o deles.', ok: 'Sair e apagar' }
    : { title: `Excluir “${w.name}”?`, sub: `${statsText(wsStats(w))} e o histórico deste workspace serão apagados. Isso não pode ser desfeito.`, ok: 'Excluir workspace' });
  if (!ok) return false;
  if (w.shared && loggedIn()) {
    const r = owner ? await cloudCall('DELETE', `/v1/workspaces/${w.shared.id}`) : await cloudCall('DELETE', `/v1/workspaces/${w.shared.id}/members/${me().id}`);
    if (!r.ok && r.status !== 404) { toast(r.error, 4000); return false; }
    w.shared = null;
  }
  if (w.id === data.activeWorkspaceId) switchWorkspace(data.workspaces.find((x) => x !== w).id, { quiet: true });
  data.workspaces.splice(data.workspaces.indexOf(w), 1);
  persist(); renderWorkspaceBtn();
  toast(`Workspace “${w.name}” excluído`);
  return true;
}
function openWorkspaces() {
  openModal((body, close) => {
    const list = h('div', { class: 'ws-list' });
    const draw = () => {
      list.innerHTML = '';
      for (const w of data.workspaces) {
        const on = w.id === data.activeWorkspaceId;
        const more = h('button', { class: 'icon-btn', title: 'Mais ações', html: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.2" class="fill"/><circle cx="12" cy="12" r="1.2" class="fill"/><circle cx="19" cy="12" r="1.2" class="fill"/></svg>' });
        more.addEventListener('click', (e) => {
          e.stopPropagation();
          showMenu(more, [
            { label: w.shared ? 'Pessoas e convites…' : 'Compartilhar…', run: () => openShare(w) },
            ...(w.shared ? [{ label: 'Histórico de alterações…', run: () => openHistory(w) }] : []),
            ...(w.shared && !isOwner(w) && loggedIn() ? [{ label: 'Sair (manter cópia local)', run: () => leaveShared(w, () => openWorkspaces()) }] : []),
            { label: 'Editar nome e descrição', run: () => openWorkspaceForm(w, { back: openWorkspaces }) },
            { label: 'Duplicar', run: () => { duplicateWorkspace(w); draw(); } },
            '-',
            { label: 'Excluir…', run: async () => { await deleteWorkspace(w); openWorkspaces(); } },
          ]);
        });
        list.append(h('div', { class: 'ws-row' + (on ? ' on' : ''), ondblclick: () => { if (!on) switchWorkspace(w.id); } },
          h('div', { class: 'ws-avatar' }, (w.name.trim()[0] || '?').toUpperCase()),
          h('div', { class: 'ws-info' },
            h('div', { class: 'ws-title' }, w.name, on ? h('span', { class: 'ws-badge' }, 'Atual') : null,
              w.shared ? h('span', { class: 'ws-badge shared', title: (w.shared.members || []).map((m) => '@' + m.username).join(', '), html: `${ICON_PEOPLE} ${(w.shared.members || []).length}` }) : null),
            w.description ? h('div', { class: 'ws-desc' }, w.description) : null,
            h('div', { class: 'ws-stats' }, statsText(wsStats(w)))),
          on ? null : h('button', { class: 'btn-ghost', onclick: () => switchWorkspace(w.id) }, 'Abrir'),
          more));
      }
    };
    draw();
    body.append(
      h('div', { class: 'ws-head' },
        h('div', {}, h('h2', {}, 'Workspaces'),
          h('p', { class: 'sub' }, 'Separe projetos e clientes: cada workspace tem coleções, ambientes, variáveis globais, histórico e abas próprios.')),
        h('button', { class: 'btn-primary', onclick: () => openWorkspaceForm() }, '+ Novo workspace')),
      list,
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn-ghost', onclick: close }, 'Fechar')));
  });
}

// ---------- Conta e workspaces compartilhados ----------
// O app fala com o servidor do Mono (nunca com o banco). Cada workspace compartilhado guarda em w.shared:
// { id, version, base, ownerId, members } — `base` é a última versão confirmada pelo servidor; a diferença
// entre ela e o estado atual vira operações enviadas a cada mudança. Mudanças dos colegas chegam por eventos.
const Sync = window.MonoSync;
const MONO_CLOUD_URL = 'https://mono-server-production.up.railway.app'; // servidor oficial do Mono (Railway)
const cloud = { state: 'off', invites: [], clientId: uid('cli'), timer: null, busy: new Set(), again: new Set(), buffer: new Map(), own: new Map(), gapTimer: new Map() };
const cloudCfg = () => { const s = (data.settings ||= {}); return (s.cloud ||= { url: MONO_CLOUD_URL, token: '', user: null }); };
let cloudOverride = ''; // MONO_SERVER=http://localhost:8787 npm run dev → testa com o servidor local
const cloudUrl = () => cloudOverride || MONO_CLOUD_URL || cloudCfg().url;
const loggedIn = () => !!(cloudCfg().token && cloudCfg().user && cloudUrl());
const me = () => cloudCfg().user;
const sharedWs = () => data.workspaces.filter((w) => w.shared);
const wsByShared = (id) => data.workspaces.find((w) => w.shared && w.shared.id === id);
const isOwner = (w) => w.shared && me() && w.shared.ownerId === me().id;
async function cloudCall(method, path, body) {
  const r = await api.cloud.call({ url: cloudUrl(), token: cloudCfg().token, method, path, body });
  if (r.status === 401 && cloudCfg().token) cloudLoggedOut('Sua sessão expirou. Entre de novo para continuar sincronizando.');
  return r;
}
function cloudLoggedOut(msg) {
  const c = cloudCfg(); c.token = ''; c.user = null;
  api.cloud.disconnect(); cloud.state = 'off'; cloud.invites = [];
  persist(); renderWorkspaceBtn();
  if (msg) toast(msg, 4000);
}
function cloudStart() {
  if (!loggedIn()) return;
  api.cloud.connect({ url: cloudUrl(), token: cloudCfg().token, clientId: cloud.clientId });
}
async function refreshInvites() {
  const r = await cloudCall('GET', '/v1/invites');
  if (r.ok) { cloud.invites = r.data.invites; renderWorkspaceBtn(); }
}
// Aplica mudanças vindas de fora num workspace (ativo ou guardado) e atualiza a tela.
function applyRemote(w, ops) {
  const local = wsData(w);
  Sync.applyOps(local, ops);
  w.shared.base = Sync.applyOps(w.shared.base || Sync.shareable({}), ops);
  if (w.id !== data.activeWorkspaceId) return;
  const s = session();
  for (const t of s.tabs) {
    if (!t.ref) continue;
    const f = findRef(t.ref);
    if (!f) { t.ref = null; t.dirty = true; continue; } // apagada por um colega: vira rascunho
    if (!t.dirty && JSON.stringify(f.req) !== JSON.stringify(t.draft)) t.draft = clone(f.req);
  }
  if (data.activeEnvId && !envById(data.activeEnvId)) data.activeEnvId = data.environments[0]?.id || '';
  renderSidebar(); renderTabs(); renderEnvSelect();
  if (!activeTab()?.dirty) renderRequest();
}
function drain(w) {
  const id = w.shared.id;
  const buf = cloud.buffer.get(id) || new Map(), own = cloud.own.get(id) || new Set();
  for (;;) {
    const next = w.shared.version + 1;
    if (buf.has(next)) { applyRemote(w, buf.get(next)); buf.delete(next); w.shared.version = next; }
    else if (own.has(next)) { own.delete(next); w.shared.version = next; }
    else break;
  }
  clearTimeout(cloud.gapTimer.get(id));
  if (buf.size) cloud.gapTimer.set(id, setTimeout(() => resync(w), 2500)); // faltou um pedaço: busca tudo
  persist();
}
// Envia o que mudou desde a última versão confirmada.
async function pushOps(w) {
  if (!w.shared || !loggedIn()) return;
  if (!canEditWs(w)) { revertViewerChanges(w); return; }
  const id = w.shared.id;
  if (cloud.busy.has(id)) { cloud.again.add(id); return; }
  const ops = Sync.diff(w.shared.base || Sync.shareable({}), Sync.shareable(wsData(w)));
  if (!ops.length) return;
  cloud.busy.add(id);
  try {
    const r = await cloudCall('POST', `/v1/workspaces/${id}/ops`, { ops, clientId: cloud.clientId });
    if (!w.shared) return;
    if (r.ok) {
      w.shared.base = Sync.applyOps(w.shared.base || Sync.shareable({}), ops);
      if (r.data.change && historyModal && historyModal.w === w) historyModal.prepend(r.data.change);
      const crossed = r.data.version !== w.shared.version + 1;
      if (!cloud.own.has(id)) cloud.own.set(id, new Set());
      cloud.own.get(id).add(r.data.version);
      drain(w);
      if (crossed) setTimeout(() => resync(w), 300); // um colega gravou junto: confere com o servidor
    } else if (r.status === 404) detachShared(w, 'Este workspace não está mais compartilhado com você.');
    else if (r.status === 403) { const g = await cloudCall('GET', `/v1/workspaces/${id}`); if (g.ok && w.shared) w.shared.members = g.data.workspace.members; revertViewerChanges(w); }
    else if (r.status && r.status !== 401) toast(r.error, 4000);
  } finally {
    cloud.busy.delete(id);
    if (cloud.again.delete(id)) pushOps(w);
  }
}
function scheduleSync() {
  if (!data?.workspaces || !loggedIn()) return;
  const w = activeWorkspace();
  if (!w?.shared) return;
  clearTimeout(cloud.timer);
  cloud.timer = setTimeout(() => pushOps(w), 400);
}
// Busca a versão do servidor e junta com o que ainda não foi enviado daqui.
async function resync(w) {
  if (!w.shared || !loggedIn()) return;
  const r = await cloudCall('GET', `/v1/workspaces/${w.shared.id}`);
  if (!w.shared) return;
  if (!r.ok) { if (r.status === 404) detachShared(w, `Você não faz mais parte de “${w.name}”. Ficou uma cópia só neste computador.`); return; }
  const srv = r.data.workspace;
  const local = wsData(w);
  const pending = Sync.diff(w.shared.base || Sync.shareable({}), Sync.shareable(local));
  Sync.applyOps(local, Sync.diff(Sync.shareable(local), srv.data));
  Object.assign(w.shared, { base: srv.data, version: srv.version, ownerId: srv.ownerId, members: srv.members, invites: srv.invites || [] });
  w.name = srv.name; w.description = srv.description || '';
  cloud.buffer.delete(srv.id); cloud.own.delete(srv.id);
  if (pending.length) Sync.applyOps(local, pending);
  if (w.id === data.activeWorkspaceId) applyRemote(w, []);
  renderWorkspaceBtn(); persist();
  if (pending.length) pushOps(w);
}
function detachShared(w, msg) {
  if (!w.shared) return;
  w.shared = null;
  persist(); renderWorkspaceBtn();
  if (msg) toast(msg, 5000);
}
function onCloudEvent({ event, data: p }) {
  if (!data) return;
  if (event === 'hello') { refreshInvites(); for (const w of sharedWs()) resync(w); presenceSent = ''; presenceTick(true); const aw = activeWorkspace(); if (aw.shared) { loadComments(aw); loadMonitorRuns(aw); } return; }
  if (event === 'profile') {
    cloud.profiles.set(p.user.id, p.user);
    if (me() && p.user.id === me().id) { cloudCfg().user = { ...me(), ...p.user }; persist(); }
    repaintAvatars();
    return;
  }
  if (event === 'invite') {
    cloud.invites = [p, ...cloud.invites.filter((i) => i.id !== p.id)];
    renderWorkspaceBtn();
    toast(`@${p.from.username} convidou você para “${p.wsName}”. Abra o menu do workspace para aceitar.`, 6000);
    return;
  }
  const w = p && p.ws ? wsByShared(p.ws) : null;
  if (onCollabEvent(event, p, w)) return;
  if (event === 'monitor') { if (w) onMonitorRun(w, p.run); return; }
  if (!w) return;
  if (event === 'ops') {
    if (p.change && historyModal && historyModal.w === w) historyModal.prepend(p.change);
    if (p.version <= w.shared.version) return;
    if (!cloud.buffer.has(w.shared.id)) cloud.buffer.set(w.shared.id, new Map());
    cloud.buffer.get(w.shared.id).set(p.version, p.ops);
    drain(w);
    if (w.id === data.activeWorkspaceId) toast(`@${p.by} ${p.change ? p.change.summary : 'alterou ' + Sync.describe(p.ops)}`, 2600);
  } else if (event === 'members') {
    w.shared.members = p.members;
    if (p.joined && p.joined !== me()?.username) toast(`@${p.joined} entrou em “${w.name}”`, 3500);
    if (p.left && p.left !== me()?.username) toast(`@${p.left} saiu de “${w.name}”`, 3500);
    if (p.roleChanged === me()?.username) toast(`@${p.by} mudou seu acesso em “${w.name}” para ${p.role === 'viewer' ? 'só leitura' : 'edição'}.`, 5000);
    w.shared.invites = (w.shared.invites || []).filter((i) => i.username !== p.joined);
    persist(); renderWorkspaceBtn(); refreshShareModal(w);
  } else if (event === 'workspace') {
    if (p.name) w.name = p.name;
    if (p.description !== undefined) w.description = p.description;
    persist(); renderWorkspaceBtn();
  } else if (event === 'invited') {
    w.shared.invites = [...(w.shared.invites || []).filter((i) => i.username !== p.username), { username: p.username, role: p.role }];
    refreshShareModal(w);
  } else if (event === 'declined') {
    w.shared.invites = (w.shared.invites || []).filter((i) => i.username !== p.username);
    toast(`@${p.username} recusou o convite para “${w.name}”`, 3500);
    refreshShareModal(w);
  } else if (event === 'removed') {
    const why = { deleted: `@${p.by} excluiu “${w.name}” para todos.`, kicked: `@${p.by} removeu você de “${w.name}”.`, left: `Você saiu de “${w.name}”.` }[p.reason] || '';
    detachShared(w, `${why} Ficou uma cópia só neste computador.`);
  }
}
async function cloudInit() {
  if (!api.cloud) return;
  try { cloudOverride = (await api.cloud.defaultUrl?.()) || ''; } catch { /* sem override */ }
  api.cloud.onState((s) => { cloud.state = s.state; if (s.state === 'unauthorized') cloudLoggedOut('Sua sessão expirou. Entre de novo para continuar sincronizando.'); else renderWorkspaceBtn(); });
  api.cloud.onEvent(onCloudEvent);
  cloudStart();
}

// Tela de conta: entrar ou criar conta (@ único + senha).
function openAccount({ then = null } = {}) {
  openModal((body, close) => {
    const c = cloudCfg();
    if (loggedIn()) {
      const st = { online: 'Conectado', connecting: 'Conectando…', offline: 'Sem conexão — tentando de novo', off: 'Desconectado' }[cloud.state] || cloud.state;
      const u = me();
      const big = avatar({ userId: u.id, username: u.username, name: u.name }, 'xl');
      const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', class: 'hidden' });
      file.addEventListener('change', async () => {
        const f = file.files[0]; file.value = '';
        if (!f) return;
        try { const data = await imageToAvatar(f); if (await saveProfile({ avatar: data })) { close(); openAccount(); toast('Foto atualizada', 1800); } }
        catch (e) { toast(e.message, 3000); }
      });
      const nameIn = h('input', { value: u.name || '', placeholder: 'Seu nome (opcional)', maxlength: 60 });
      const saveName = async () => { if ((nameIn.value.trim()) !== (me().name || '') && await saveProfile({ name: nameIn.value.trim() })) toast('Nome atualizado', 1600); };
      nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveName(); });
      nameIn.addEventListener('blur', saveName);
      const cur = profileOf({ userId: u.id, username: u.username });
      const swatches = h('div', { class: 'swatches' }, AVATAR_COLORS.map((col) => h('button', {
        class: 'swatch' + ((cur.color || hashColor(u.username)) === col ? ' on' : ''), style: `background:${col}`, title: 'Usar esta cor',
        onclick: async () => { if (await saveProfile({ color: col })) { close(); openAccount(); } },
      })));
      body.append(
        h('h2', {}, 'Sua conta'),
        h('div', { class: 'acct-card' },
          h('div', { class: 'acct-av' }, big),
          h('div', { class: 'grow' }, h('div', { class: 'acct-name' }, u.name || u.username), h('div', { class: 'acct-user' }, '@' + u.username)),
          h('span', { class: 'cloud-state ' + cloud.state }, h('span', { class: 'dot' }), st)),
        h('div', { class: 'acct-edit' },
          h('div', { class: 'field' }, h('label', {}, 'Foto'),
            h('div', { class: 'row-gap' }, file,
              h('button', { class: 'btn-ghost sm', onclick: () => file.click() }, cur.avatar ? 'Trocar foto' : 'Escolher foto'),
              cur.avatar ? h('button', { class: 'btn-text sm', onclick: async () => { if (await saveProfile({ avatar: '' })) { close(); openAccount(); } } }, 'Remover foto') : null)),
          h('div', { class: 'field' }, h('label', {}, cur.avatar ? 'Cor (usada se tirar a foto)' : 'Cor da inicial'), swatches),
          h('div', { class: 'field' }, h('label', {}, 'Nome que os colegas veem'), nameIn)),
        h('p', { class: 'sub' }, plural(sharedWs().length, 'workspace compartilhado', 'workspaces compartilhados')),
        h('div', { class: 'modal-actions' },
          h('button', { class: 'btn-ghost', onclick: async () => { await cloudCall('POST', '/v1/logout'); cloudLoggedOut(); close(); toast('Você saiu da conta. Os workspaces continuam aqui, sem sincronizar.', 4000); } }, 'Sair da conta'),
          h('button', { class: 'btn-primary', onclick: close }, 'Fechar')));
      return;
    }
    let mode = 'login';
    const user = h('input', { placeholder: 'seu.usuario', spellcheck: 'false', autocomplete: 'username', maxlength: 31 });
    const pass = h('input', { type: 'password', placeholder: 'mínimo 8 caracteres', autocomplete: 'current-password' });
    const name = h('input', { placeholder: 'Como aparece para os colegas (opcional)', maxlength: 60 });
    const server = h('input', { value: cloudUrl(), placeholder: 'https://mono-server.exemplo.com', spellcheck: 'false' });
    const err = h('p', { class: 'ws-err hidden' });
    const hint = h('div', { class: 'acct-hint' });
    const nameField = h('div', { class: 'field hidden' }, h('label', {}, 'Nome'), name);
    const title = h('h2', {}), sub = h('p', { class: 'sub' });
    const go = h('button', { class: 'btn-primary' });
    const swap = h('button', { class: 'linklike' });
    const draw = () => {
      const reg = mode === 'register';
      title.textContent = reg ? 'Criar conta no Mono' : 'Entrar no Mono';
      sub.textContent = reg ? 'Escolha um @ — é por ele que os colegas vão convidar você. Cada @ é único.' : 'Entre para compartilhar workspaces e receber convites.';
      nameField.classList.toggle('hidden', !reg);
      pass.autocomplete = reg ? 'new-password' : 'current-password';
      go.textContent = reg ? 'Criar conta' : 'Entrar';
      swap.textContent = reg ? 'Já tenho conta' : 'Criar uma conta';
      err.classList.add('hidden');
      checkUser();
    };
    const checkUser = () => {
      const u = Sync.normUser(user.value);
      hint.textContent = mode === 'register' && u ? (Sync.USERNAME.test(u) ? `Seu @ será @${u}` : '3 a 30 caracteres: letras minúsculas, números, ponto ou _') : '';
      hint.classList.toggle('bad', mode === 'register' && !!u && !Sync.USERNAME.test(u));
    };
    user.addEventListener('input', checkUser);
    swap.onclick = () => { mode = mode === 'login' ? 'register' : 'login'; draw(); user.focus(); };
    const submit = async () => {
      const show = (m) => { err.textContent = m; err.classList.remove('hidden'); };
      const url = cloudOverride || MONO_CLOUD_URL || server.value.trim();
      if (!url) return show('Informe o endereço do servidor do Mono.');
      const u = Sync.normUser(user.value);
      if (!u) return show('Informe o seu @.');
      if (mode === 'register' && !Sync.USERNAME.test(u)) return show('Esse @ não vale: use 3 a 30 letras minúsculas, números, ponto ou _.');
      if (pass.value.length < (mode === 'register' ? 8 : 1)) return show(mode === 'register' ? 'A senha precisa ter pelo menos 8 caracteres.' : 'Informe a senha.');
      go.disabled = true; go.textContent = mode === 'register' ? 'Criando…' : 'Entrando…';
      const r = await api.cloud.call({ url, method: 'POST', path: mode === 'register' ? '/v1/register' : '/v1/login', body: { username: u, password: pass.value, name: name.value.trim() } });
      go.disabled = false; draw();
      if (!r.ok) return show(r.error);
      Object.assign(c, { url, token: r.data.token, user: r.data.user });
      persist(); renderWorkspaceBtn(); cloudStart();
      close();
      toast(mode === 'register' ? `Conta criada. Bem-vindo, @${r.data.user.username}!` : `Olá, @${r.data.user.username}!`, 3000);
      if (then) then();
    };
    go.onclick = submit;
    for (const el of [user, pass, name, server]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    body.append(title, sub,
      h('div', { class: 'field' }, h('label', {}, 'Usuário (@)'), h('div', { class: 'at-input' }, h('span', {}, '@'), user)), hint,
      h('div', { class: 'field' }, h('label', {}, 'Senha'), pass),
      nameField,
      MONO_CLOUD_URL ? null : h('details', { class: 'acct-server', open: !cloudUrl() }, h('summary', {}, 'Servidor'), h('div', { class: 'field' }, server)),
      err,
      h('div', { class: 'modal-actions spread' }, swap, h('div', { class: 'row-gap' }, h('button', { class: 'btn-ghost', onclick: close }, 'Cancelar'), go)));
    draw();
    setTimeout(() => user.focus(), 0);
  });
}

// Compartilha um workspace local (passa a existir no servidor) e abre a tela de pessoas.
async function shareWorkspace(w) {
  if (!loggedIn()) return openAccount({ then: () => shareWorkspace(w) });
  const data0 = Sync.shareable(wsData(w));
  const r = await cloudCall('POST', '/v1/workspaces', { name: w.name, description: w.description || '', data: data0 });
  if (!r.ok) { toast(r.error, 4000); return; }
  const sw = r.data.workspace;
  w.shared = { id: sw.id, version: sw.version, base: sw.data, ownerId: sw.ownerId, members: sw.members, invites: [] };
  persist(); renderWorkspaceBtn();
  toast(`“${w.name}” agora é compartilhado. Convide alguém pelo @.`, 3500);
  openShare(w);
}
let shareModal = null; // { w, draw }
function refreshShareModal(w) { if (shareModal && shareModal.w === w && !$('#modal').classList.contains('hidden')) shareModal.draw(); }
function openShare(w) {
  if (!w.shared) return shareWorkspace(w);
  if (!loggedIn()) return openAccount({ then: () => openShare(w) });
  openModal((body, close) => {
    const list = h('div', { class: 'ws-list' });
    const input = h('input', { placeholder: 'usuario', spellcheck: 'false', autocomplete: 'off', maxlength: 31 });
    const sugg = h('div', { class: 'at-sugg hidden' });
    const err = h('p', { class: 'ws-err hidden' });
    const inviteBtn = h('button', { class: 'btn-primary' }, 'Convidar');
    const roleSel = h('select', { title: 'O que a pessoa pode fazer' }, h('option', { value: 'editor' }, 'Pode editar'), h('option', { value: 'viewer' }, 'Só leitura'));
    queueMicrotask(() => customSelect(roleSel, { variant: 'compact' }));
    const draw = () => {
      list.innerHTML = '';
      for (const m of w.shared.members || []) {
        const self = m.userId === me()?.id;
        const actions = [];
        if (self && !isOwner(w)) actions.push(h('button', { class: 'btn-ghost sm', onclick: () => leaveShared(w, close) }, 'Sair'));
        if (!self && isOwner(w)) actions.push(h('button', { class: 'btn-ghost sm', onclick: async () => {
          if (!(await confirmModal({ title: `Remover @${m.username}?`, sub: `@${m.username} deixa de ver e de editar “${w.name}”. A cópia que já está no computador dele/dela fica só lá.`, ok: 'Remover' }))) return openShare(w);
          const r = await cloudCall('DELETE', `/v1/workspaces/${w.shared.id}/members/${m.userId}`);
          if (!r.ok) toast(r.error, 4000);
          openShare(w);
        } }, 'Remover'));
        list.append(h('div', { class: 'ws-row compact' },
          avatar(m, 'lg'),
          h('div', { class: 'ws-info' },
            h('div', { class: 'ws-title' }, m.name || '@' + m.username, self ? h('span', { class: 'ws-badge' }, 'você') : null),
            h('div', { class: 'ws-stats' }, '@' + m.username + ' · ' + (ROLE_LABEL[m.role] || 'pode editar'))),
          isOwner(w) && !self && m.role !== 'owner' ? (() => {
            const sel = h('select', { title: 'Acesso' }, h('option', { value: 'editor' }, 'Pode editar'), h('option', { value: 'viewer' }, 'Só leitura'));
            sel.value = m.role === 'viewer' ? 'viewer' : 'editor';
            sel.addEventListener('change', async () => {
              const r = await cloudCall('PATCH', `/v1/workspaces/${w.shared.id}/members/${m.userId}`, { role: sel.value });
              if (!r.ok) { toast(r.error, 3000); sel.value = m.role; return; }
              m.role = sel.value; persist(); toast(`@${m.username}: ${ROLE_LABEL[m.role]}`, 2200);
            });
            queueMicrotask(() => customSelect(sel, { variant: 'compact' }));
            return sel;
          })() : null,
          ...actions));
      }
      for (const i of w.shared.invites || []) {
        list.append(h('div', { class: 'ws-row compact pending' },
          h('span', { class: 'av lg pending' }, i.username[0].toUpperCase()),
          h('div', { class: 'ws-info' }, h('div', { class: 'ws-title' }, '@' + i.username), h('div', { class: 'ws-stats' }, `Convite enviado (${i.role === 'viewer' ? 'só leitura' : 'pode editar'}) — aguardando aceitar`))));
      }
    };
    shareModal = { w, draw };
    let seq = 0;
    input.addEventListener('input', async () => {
      err.classList.add('hidden');
      const q = Sync.normUser(input.value);
      const my = ++seq;
      if (q.length < 2) { sugg.classList.add('hidden'); return; }
      const r = await cloudCall('GET', `/v1/users?q=${encodeURIComponent(q)}`);
      if (my !== seq) return;
      const members = new Set((w.shared.members || []).map((m) => m.username));
      const users = r.ok ? r.data.users.filter((u) => !members.has(u.username)) : [];
      sugg.innerHTML = '';
      for (const u of users) sugg.append(h('button', { onclick: () => { input.value = u.username; sugg.classList.add('hidden'); invite(); } }, h('b', {}, '@' + u.username), u.name ? h('span', {}, u.name) : null));
      sugg.classList.toggle('hidden', !users.length);
    });
    const invite = async () => {
      const u = Sync.normUser(input.value);
      if (!u) return;
      inviteBtn.disabled = true;
      const r = await cloudCall('POST', `/v1/workspaces/${w.shared.id}/invites`, { username: u, role: roleSel.value });
      inviteBtn.disabled = false;
      if (!r.ok) { err.textContent = r.error; err.classList.remove('hidden'); return; }
      w.shared.invites = [...(w.shared.invites || []).filter((i) => i.username !== u), { username: r.data.invite.username, role: r.data.invite.role }];
      input.value = ''; sugg.classList.add('hidden'); persist(); draw();
      toast(`Convite enviado para @${r.data.invite.username}`, 3000);
    };
    inviteBtn.onclick = invite;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') invite(); if (e.key === 'Escape') sugg.classList.add('hidden'); });
    draw();
    body.append(
      h('h2', {}, `Pessoas em “${w.name}”`),
      h('p', { class: 'sub' }, 'Quem estiver aqui vê e edita coleções, pastas, requisições, ambientes e variáveis globais em tempo real. Valores marcados como segredo (cadeado) não são compartilhados — cada pessoa preenche os seus.'),
      canEditWs(w) ? h('div', { class: 'invite-row' }, h('div', { class: 'at-input grow' }, h('span', {}, '@'), input, sugg), roleSel, inviteBtn)
        : h('p', { class: 'hint' }, 'Você tem acesso só de leitura: não pode convidar pessoas.'),
      err,
      list,
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn-ghost', onclick: close }, 'Fechar')));
    setTimeout(() => input.focus(), 0);
    // atualiza membros e convites pendentes
    cloudCall('GET', `/v1/workspaces/${w.shared.id}`).then((r) => {
      if (r.ok && w.shared) { w.shared.members = r.data.workspace.members; w.shared.invites = r.data.workspace.invites || []; draw(); }
    });
  });
}
async function leaveShared(w, closeModal) {
  if (!(await confirmModal({ title: `Sair de “${w.name}”?`, sub: 'Você deixa de receber as mudanças. Fica uma cópia só neste computador.', ok: 'Sair' }))) return;
  const r = await cloudCall('DELETE', `/v1/workspaces/${w.shared.id}/members/${me().id}`);
  if (!r.ok && r.status !== 404) { toast(r.error, 4000); return; }
  detachShared(w, `Você saiu de “${w.name}”. Ficou uma cópia só neste computador.`);
  closeModal?.();
}
// Convite recebido: aceitar cria o workspace aqui e abre.
function openInvite(inv) {
  openModal((body, close) => {
    const accept = h('button', { class: 'btn-primary' }, 'Aceitar e abrir');
    accept.onclick = async () => {
      accept.disabled = true; accept.textContent = 'Entrando…';
      const r = await cloudCall('POST', `/v1/invites/${inv.id}/accept`);
      cloud.invites = cloud.invites.filter((i) => i.id !== inv.id);
      renderWorkspaceBtn();
      if (!r.ok) { close(); toast(r.error, 4000); return; }
      const sw = r.data.workspace;
      let w = wsByShared(sw.id);
      if (!w) {
        w = { id: uid('ws'), name: sw.name, description: sw.description || '', createdAt: Date.now(),
          data: { ...Sync.clone(sw.data), history: [], activeEnvId: sw.data.environments?.[0]?.id || '' },
          shared: { id: sw.id, version: sw.version, base: Sync.clone(sw.data), ownerId: sw.ownerId, members: sw.members, invites: [] } };
        data.workspaces.push(w);
      }
      close();
      switchWorkspace(w.id, { quiet: true });
      toast(`Você entrou em “${sw.name}”`, 3000);
    };
    body.append(
      h('h2', {}, `Convite para “${inv.wsName}”`),
      h('p', { class: 'sub' }, `${inv.from.name || '@' + inv.from.username} (@${inv.from.username}) convidou você para editar junto.${inv.wsDescription ? ' — ' + inv.wsDescription : ''}`),
      h('p', { class: 'acct-hint' }, inv.role === 'viewer' ? 'Acesso só de leitura: você vê tudo, envia as requisições e comenta, mas não altera o workspace.' : 'Ao aceitar, as coleções e os ambientes do workspace aparecem aqui, e as mudanças de todos chegam em tempo real.'),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn-ghost', onclick: async () => {
          const r = await cloudCall('POST', `/v1/invites/${inv.id}/decline`);
          cloud.invites = cloud.invites.filter((i) => i.id !== inv.id); renderWorkspaceBtn(); close();
          toast(r.ok ? 'Convite recusado' : r.error, 3000);
        } }, 'Recusar'),
        accept));
  });
}

// ---------- Colaboração: papel, presença, histórico e comentários ----------
const myRole = (w) => (w && w.shared && me() ? ((w.shared.members || []).find((m) => m.userId === me().id) || {}).role : null);
const canEditWs = (w) => !w || !w.shared || myRole(w) !== 'viewer';
const ROLE_LABEL = { owner: 'criou o workspace', editor: 'pode editar', viewer: 'só leitura' };
const initialOf = (u) => String((u && (u.name || u.username)) || '?').trim()[0].toUpperCase();
// Avatares: foto ou inicial na cor escolhida. Perfis (cor/foto) vêm do servidor e ficam em cache.
const AVATAR_COLORS = ['#8ab4f8', '#f28b82', '#fbbc04', '#81c995', '#c58af9', '#78d9ec', '#fcad70', '#ff8bcb', '#a8a8a8'];
const hashColor = (s) => { let x = 0; for (const ch of String(s || '')) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return AVATAR_COLORS[x % (AVATAR_COLORS.length - 1)]; };
cloud.profiles = new Map(); // userId → { username, name, color, avatar }
const uidOf = (u) => (u && (u.userId || u.id)) || '';
function profileOf(u) {
  const id = uidOf(u);
  const p = (id && cloud.profiles.get(id)) || (me() && id === me().id ? me() : null) || {};
  return { username: p.username || (u && u.username) || '', name: p.name || (u && u.name) || '', color: p.color || '', avatar: p.avatar || '' };
}
function paintAvatar(el, u) {
  const p = profileOf(u);
  el.textContent = '';
  el.style.background = '';
  if (p.avatar) { el.classList.add('has-img'); el.append(h('img', { src: p.avatar, alt: '' })); }
  else { el.classList.remove('has-img'); el.textContent = initialOf(p.username ? p : u); el.style.background = p.color || hashColor(p.username || (u && u.username)); el.style.color = '#0b0b0b'; }
}
function avatar(u, cls = '') {
  const el = h('span', { class: 'av ' + cls, 'data-uid': uidOf(u) || null, title: `${u.name ? u.name + ' · ' : ''}@${u.username}` });
  paintAvatar(el, u);
  if (uidOf(u)) ensureProfiles([uidOf(u)]);
  return el;
}
const profileWanted = new Set(), profileTried = new Set();
let profileTimer = null;
function ensureProfiles(ids) {
  if (!loggedIn()) return;
  for (const id of ids) if (id && !cloud.profiles.has(id) && !profileTried.has(id)) profileWanted.add(id);
  if (!profileWanted.size || profileTimer) return;
  profileTimer = setTimeout(async () => {
    profileTimer = null;
    const list = [...profileWanted].slice(0, 100);
    list.forEach((id) => { profileWanted.delete(id); profileTried.add(id); });
    const r = await cloudCall('GET', `/v1/profiles?ids=${encodeURIComponent(list.join(','))}`);
    if (r.ok) { for (const u of r.data.users) cloud.profiles.set(u.id, u); repaintAvatars(); }
  }, 60);
}
function repaintAvatars() {
  $$('.av[data-uid]').forEach((el) => paintAvatar(el, { userId: el.dataset.uid, username: (el.title.match(/@([\w.]+)/) || [])[1] || '' }));
}
// Foto escolhida no computador → recorte quadrado de 128 px em WebP (fica pequena para ir ao servidor).
function imageToAvatar(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type)) return reject(new Error('Escolha uma imagem (PNG, JPG ou WebP).'));
    if (file.size > 15 * 1024 * 1024) return reject(new Error('Imagem grande demais.'));
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
      g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 128, 128);
      let q = 0.86, out = c.toDataURL('image/webp', q);
      while (out.length > 85000 && q > 0.4) { q -= 0.12; out = c.toDataURL('image/webp', q); }
      if (!/^data:image\/webp/.test(out)) out = c.toDataURL('image/jpeg', 0.85);
      resolve(out);
    };
    img.onerror = () => reject(new Error('Não consegui abrir essa imagem.'));
    // data: (e não blob:) porque a CSP do app só libera imagens 'self' e data:
    const fr = new FileReader();
    fr.onload = () => { img.src = fr.result; };
    fr.onerror = () => reject(new Error('Não consegui ler o arquivo.'));
    fr.readAsDataURL(file);
  });
}
async function saveProfile(fields) {
  const r = await cloudCall('PATCH', '/v1/me', fields);
  if (!r.ok) { toast(r.error, 3500); return false; }
  cloudCfg().user = { ...me(), ...r.data.user };
  cloud.profiles.set(r.data.user.id, r.data.user);
  persist(); repaintAvatars(); renderWorkspaceBtn();
  return true;
}
const ago = (t) => {
  const s = Math.round((Date.now() - new Date(t).getTime()) / 1000);
  if (s < 45) return 'agora';
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

// Só leitura: o que foi mudado aqui volta ao que está no servidor.
let viewerWarned = 0;
function revertViewerChanges(w) {
  const local = wsData(w);
  const back = Sync.diff(Sync.shareable(local), w.shared.base || Sync.shareable({}));
  if (!back.length) return;
  Sync.applyOps(local, back);
  if (w.id === data.activeWorkspaceId) {
    for (const t of session().tabs) { const f = findRef(t.ref); if (f && !t.dirty) t.draft = clone(f.req); }
    renderSidebar(); renderTabs(); renderEnvSelect(); renderRequest();
  }
  if (Date.now() - viewerWarned > 4000) { viewerWarned = Date.now(); toast('Você tem acesso só de leitura neste workspace: dá para enviar requisições, mas não salvar alterações.', 4500); }
}

// Presença: avisa o servidor qual workspace/requisição está aberta (só quando muda).
cloud.presence = new Map(); // sharedId → [{ userId, username, name, reqIds }]
let presenceSent = '';
function presenceTick(force = false) {
  if (!loggedIn() || cloud.state !== 'online' || !data) return;
  const w = activeWorkspace();
  const ws = w && w.shared ? w.shared.id : null;
  const reqId = ws ? activeTab()?.ref?.reqId || null : null;
  const key = `${ws}|${reqId}`;
  if (!force && key === presenceSent) return;
  presenceSent = key;
  cloudCall('POST', '/v1/presence', { ws, reqId, clientId: cloud.clientId }).then((r) => {
    if (r.ok && ws) { cloud.presence.set(ws, r.data.users); decorateCollab(); }
  });
}
setInterval(() => { if (data) presenceTick(); }, 1200);
const othersHere = () => {
  const w = activeWorkspace();
  if (!w || !w.shared) return [];
  return (cloud.presence.get(w.shared.id) || []).filter((u) => u.userId !== me()?.id);
};

// Comentários por workspace compartilhado.
cloud.comments = new Map(); // sharedId → [comment]
async function loadComments(w) {
  if (!w.shared) return;
  const r = await cloudCall('GET', `/v1/workspaces/${w.shared.id}/comments`);
  if (r.ok) { cloud.comments.set(w.shared.id, r.data.comments); if (w.id === data.activeWorkspaceId) { decorateCollab(); updateCounts(); if (reqTab === 'comments') renderReqEditor(); } }
}
const commentsFor = (reqId) => {
  const w = activeWorkspace();
  return w && w.shared ? (cloud.comments.get(w.shared.id) || []).filter((c) => c.reqId === reqId) : [];
};

// Avatares de quem está online (topo), de quem está em cada requisição e contagem de comentários na árvore.
function decorateCollab() {
  if (!data) return;
  const box = $('#wsPresence');
  if (box) {
    box.innerHTML = '';
    const others = othersHere();
    for (const u of others.slice(0, 4)) box.append(avatar(u, 'on'));
    if (others.length > 4) box.append(h('span', { class: 'av more' }, '+' + (others.length - 4)));
    box.title = others.length ? `Online agora: ${others.map((u) => '@' + u.username).join(', ')}` : '';
    box.classList.toggle('hidden', !others.length);
  }
  const byReq = new Map();
  for (const u of othersHere()) for (const id of u.reqIds || []) byReq.set(id, [...(byReq.get(id) || []), u]);
  const comments = new Map();
  for (const c of (cloud.comments.get(activeWorkspace()?.shared?.id) || [])) if (!c.resolved) comments.set(c.reqId, (comments.get(c.reqId) || 0) + 1);
  $$('.tree-row.request[data-req], .tab[data-req]').forEach((row) => {
    row.querySelector('.row-collab')?.remove();
    const id = row.dataset.req;
    const users = byReq.get(id) || [], n = comments.get(id) || 0;
    if (!users.length && !n) return;
    const deco = h('span', { class: 'row-collab' },
      n && row.classList.contains('tree-row') ? h('span', { class: 'cmt-count', title: `${n} comentário${n > 1 ? 's' : ''} em aberto` }, '💬 ' + n) : null,
      ...users.slice(0, 3).map((u) => avatar(u, 'xs')));
    const anchor = row.querySelector('.more, .x');
    row.insertBefore(deco, anchor || null);
  });
}

// Histórico de alterações (com desfazer).
let historyModal = null; // { w, itemId, prepend }
const FIELD_LABEL = { name: 'Nome', method: 'Método', url: 'URL', params: 'Params', headers: 'Headers', body: 'Body', auth: 'Auth', pre: 'Script antes', tests: 'Script depois', folderId: 'Pasta', examples: 'Exemplos', description: 'Descrição', vars: 'Variáveis', variables: 'Variáveis', message: 'Mensagem', messages: 'Mensagens salvas' };
function changeLines(c) {
  if (!c.ops) return [h('div', { class: 'muted small' }, 'Alteração grande demais para mostrar os detalhes.')];
  const inv = c.inverse || [];
  const prev = (op) => inv.find((x) => x.t === op.t && x.id === op.id && (x.col || null) === (op.col || null));
  const kindName = { col: 'Coleção', fold: 'Pasta', req: 'Requisição', env: 'Ambiente', mon: 'Monitor' };
  const out = [];
  for (const op of c.ops) {
    if (/Order$/.test(op.t)) { out.push(h('div', { class: 'chg-line' }, 'Reordenou itens')); continue; }
    if (op.t === 'globals') { out.push(h('div', { class: 'chg-line' }, 'Alterou as variáveis globais')); continue; }
    const kind = op.t.replace(/Del$/, '');
    const item = (c.items || []).find((i) => i.id === op.id && i.t === kind);
    const name = (op.v && op.v.name) || (item && item.name) || '';
    if (/Del$/.test(op.t)) { out.push(h('div', { class: 'chg-line del' }, `${kindName[kind] || 'Item'} excluída: `, h('b', {}, name))); continue; }
    const old = prev(op);
    if (!old || !old.v) { out.push(h('div', { class: 'chg-line add' }, `${kindName[kind] || 'Item'} criada: `, h('b', {}, name))); continue; }
    const fields = [...new Set([...Object.keys(old.v), ...Object.keys(op.v)])].filter((k) => k !== 'id' && JSON.stringify(old.v[k]) !== JSON.stringify(op.v[k]));
    const detail = fields.map((k) => {
      const a = old.v[k], b = op.v[k];
      if ((typeof a === 'string' || a == null) && (typeof b === 'string' || b == null) && String(a ?? '').length < 160 && String(b ?? '').length < 160 && k !== 'pre' && k !== 'tests')
        return h('div', { class: 'chg-field' }, h('span', { class: 'chg-k' }, FIELD_LABEL[k] || k), h('span', { class: 'chg-old' }, String(a ?? '—') || '—'), ' → ', h('span', { class: 'chg-new' }, String(b ?? '—') || '—'));
      return h('div', { class: 'chg-field' }, h('span', { class: 'chg-k' }, FIELD_LABEL[k] || k), h('span', { class: 'muted' }, 'alterado'));
    });
    out.push(h('div', { class: 'chg-line' }, `${kindName[kind] || 'Item'} `, h('b', {}, name), detail.length ? h('div', { class: 'chg-fields' }, ...detail) : null));
  }
  return out;
}
async function undoChange(w, c, force = false) {
  const r = await cloudCall('POST', `/v1/workspaces/${w.shared.id}/changes/${c.id}/undo`, force ? { force: true } : {});
  if (r.ok) { toast('Alteração desfeita para todos', 2600); return true; }
  if (r.status === 409 && /alterados depois/.test(r.error)) {
    const who = [...new Set(((r.data && r.data.conflicts) || []).map((x) => '@' + x.by))].join(', ');
    if (await confirmModal({ title: 'Desfazer mesmo assim?', sub: `Esses itens foram alterados depois${who ? ' por ' + who : ''}. Desfazer volta ao valor anterior a esta alteração e descarta as mudanças posteriores neles.`, ok: 'Desfazer mesmo assim' })) return undoChange(w, c, true);
    return false;
  }
  toast(r.error, 4000);
  return false;
}
function openHistory(w = activeWorkspace(), { itemId = null, title = null } = {}) {
  if (!w.shared) {
    return openModal((body, close) => body.append(h('h2', {}, 'Histórico de alterações'),
      h('p', { class: 'sub' }, 'O histórico (com desfazer) fica guardado no servidor do Mono, então funciona em workspaces compartilhados. Compartilhe este workspace — mesmo sem convidar ninguém — para ter o histórico.'),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn-ghost', onclick: close }, 'Fechar'), h('button', { class: 'btn-primary', onclick: () => { close(); shareWorkspace(w); } }, 'Compartilhar'))));
  }
  openModal((body, close) => {
    body.classList.add('wide');
    const list = h('div', { class: 'chg-list' });
    const more = h('button', { class: 'btn-ghost sm hidden' }, 'Carregar mais');
    let oldest = Infinity;
    const editable = canEditWs(w);
    const row = (c) => {
      const det = h('div', { class: 'chg-detail hidden' }, ...changeLines(c));
      const undoBtn = editable && !c.undoneBy && c.ops !== null ? h('button', { class: 'btn-ghost sm', onclick: async (e) => { e.stopPropagation(); if (await undoChange(w, c)) { c.undoneBy = { username: me().username }; el.replaceWith(row(c)); } } }, 'Desfazer') : null;
      const el = h('div', { class: 'chg-row' + (c.undoOf ? ' undo' : '') },
        h('div', { class: 'chg-main', onclick: () => det.classList.toggle('hidden') },
          avatar(c.by),
          h('div', { class: 'chg-text' },
            h('div', {}, h('b', {}, '@' + c.by.username), c.undoOf ? ' desfez uma alteração — ' : ' ', c.summary),
            h('div', { class: 'muted small' }, ago(c.at), ` · versão ${c.version}`, c.undoneBy ? h('span', { class: 'tag' }, `desfeita por @${c.undoneBy.username}`) : null)),
          undoBtn),
        det);
      return el;
    };
    const load = async () => {
      more.disabled = true;
      const q = new URLSearchParams({ limit: '40' });
      if (Number.isFinite(oldest)) q.set('before', String(oldest));
      if (itemId) q.set('item', itemId);
      const r = await cloudCall('GET', `/v1/workspaces/${w.shared.id}/changes?${q}`);
      more.disabled = false;
      if (!r.ok) { list.append(h('p', { class: 'ws-err' }, r.error)); return; }
      const changes = r.data.changes;
      if (!changes.length && !Number.isFinite(oldest)) list.append(h('div', { class: 'placeholder small-ph' }, 'Nenhuma alteração registrada ainda.'));
      for (const c of changes) { list.append(row(c)); oldest = Math.min(oldest, c.version); }
      more.classList.toggle('hidden', changes.length < 40);
    };
    more.onclick = load;
    historyModal = { w, itemId, prepend: (c) => { if (!itemId || (c.items || []).some((i) => i.id === itemId)) { list.querySelector('.small-ph')?.remove(); list.prepend(row(c)); } } };
    body.append(h('h2', {}, title || `Histórico de “${w.name}”`),
      h('p', { class: 'sub' }, editable ? 'Clique numa alteração para ver o que mudou. Desfazer aplica o valor anterior para todos — e também fica no histórico.' : 'Você tem acesso só de leitura: dá para ver o histórico, mas não desfazer.'),
      list, h('div', { class: 'chg-more' }, more),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn-ghost', onclick: () => { historyModal = null; close(); } }, 'Fechar')));
    load();
  });
}

// Aba Comentários da requisição.
function renderCommentsTab(ed, tab) {
  const w = activeWorkspace();
  const reqId = tab.ref?.reqId;
  if (!w.shared) {
    ed.append(h('div', { class: 'ex-empty' }, h('b', {}, 'Comentários são do time'), 'Compartilhe este workspace para deixar notas nas requisições, como “esse endpoint muda em novembro”.',
      h('div', {}, h('button', { class: 'btn-ghost sm', onclick: () => openShare(w) }, 'Compartilhar workspace'))));
    return;
  }
  if (!reqId) { ed.append(h('div', { class: 'ex-empty' }, h('b', {}, 'Salve a requisição primeiro'), 'Comentários ficam presos a uma requisição salva na coleção (Ctrl + S).')); return; }
  if (!loggedIn()) { ed.append(h('div', { class: 'ex-empty' }, h('b', {}, 'Entre na sua conta'), 'Para ver e escrever comentários.', h('div', {}, h('button', { class: 'btn-ghost sm', onclick: () => openAccount() }, 'Entrar')))); return; }
  const list = commentsFor(reqId);
  const box = h('div', { class: 'cmt-list' });
  for (const c of list) {
    const mine = c.by.userId === me().id;
    const owner = isOwner(w);
    const text = h('div', { class: 'cmt-text' }, c.text);
    const actions = h('div', { class: 'cmt-actions' },
      h('button', { class: 'btn-text sm', onclick: async () => { const r = await cloudCall('PATCH', `/v1/workspaces/${w.shared.id}/comments/${c.id}`, { resolved: !c.resolved }); if (!r.ok) toast(r.error, 3000); } }, c.resolved ? 'Reabrir' : 'Resolver'),
      mine ? h('button', { class: 'btn-text sm', onclick: async () => {
        const o = await promptModal({ title: 'Editar comentário', label: 'Comentário', value: c.text, ok: 'Salvar' });
        if (o) { const r = await cloudCall('PATCH', `/v1/workspaces/${w.shared.id}/comments/${c.id}`, { text: o.value }); if (!r.ok) toast(r.error, 3000); }
      } }, 'Editar') : null,
      mine || owner ? h('button', { class: 'btn-text sm', onclick: async () => {
        if (!(await confirmModal({ title: 'Apagar comentário?', sub: 'Ele some para todo o time.', ok: 'Apagar' }))) return renderRequest();
        const r = await cloudCall('DELETE', `/v1/workspaces/${w.shared.id}/comments/${c.id}`); if (!r.ok) toast(r.error, 3000);
      } }, 'Apagar') : null);
    box.append(h('div', { class: 'cmt' + (c.resolved ? ' resolved' : '') }, avatar(c.by),
      h('div', { class: 'cmt-body' },
        h('div', { class: 'cmt-meta' }, h('b', {}, c.by.name || '@' + c.by.username), h('span', { class: 'muted small' }, ` @${c.by.username} · ${ago(c.at)}${c.editedAt ? ' · editado' : ''}`),
          c.resolved ? h('span', { class: 'tag' }, `resolvido${c.resolvedBy ? ' por @' + c.resolvedBy : ''}`) : null),
        text, actions)));
  }
  if (!list.length) box.append(h('p', { class: 'hint' }, 'Nenhum comentário nesta requisição.'));
  const input = h('textarea', { class: 'cmt-input', rows: 3, placeholder: 'Escreva um comentário para o time…  (Ctrl + Enter envia)' });
  const post = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.disabled = true;
    const r = await cloudCall('POST', `/v1/workspaces/${w.shared.id}/comments`, { reqId, colId: tab.ref.colId, text });
    input.disabled = false;
    if (!r.ok) return toast(r.error, 3000);
    input.value = '';
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); post(); } });
  ed.append(box, h('div', { class: 'cmt-compose' }, input, h('div', { class: 'row-actions' }, h('div', { class: 'grow' }), h('button', { class: 'btn-primary sm', onclick: post }, 'Comentar'))));
}
function onCollabEvent(event, p, w) {
  if (event === 'presence') { cloud.presence.set(p.ws, p.users); decorateCollab(); return true; }
  if (event === 'comment') {
    const list = cloud.comments.get(p.ws) || [];
    if (p.action === 'add') list.push(p.comment);
    else if (p.action === 'update') { const i = list.findIndex((c) => c.id === p.comment.id); if (i >= 0) list[i] = p.comment; }
    else if (p.action === 'delete') { const i = list.findIndex((c) => c.id === p.comment.id); if (i >= 0) list.splice(i, 1); }
    cloud.comments.set(p.ws, list);
    if (w && w.id === data.activeWorkspaceId) {
      decorateCollab(); updateCounts();
      if (reqTab === 'comments' && activeTab()?.ref?.reqId === p.comment.reqId) renderReqEditor();
      else if (p.action === 'add' && p.comment.by.userId !== me()?.id) toast(`@${p.comment.by.username} comentou: “${p.comment.text.slice(0, 80)}”`, 4000);
    }
    return true;
  }
  return false;
}

// ---------- Persistência ----------
let saveTimer;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.save(stripEmpty(data)), 250);
  scheduleSync();
  mockRefresh();
}
function stripEmpty(d) {
  // Remove linhas vazias de tabelas antes de gravar.
  const c = clone(d);
  const clean = (r) => {
    for (const k of ['params', 'headers']) r[k] = (r[k] || []).filter((p) => p.key || p.value);
    if (r.body) r.body.form = (r.body.form || []).filter((p) => p.key || p.value);
  };
  c.collections.forEach((col) => col.requests.forEach(clean));
  c.session?.tabs.forEach((t) => clean(t.draft));
  c.environments.forEach((e) => (e.vars = e.vars.filter((v) => v.key || v.value)));
  c.collections.forEach((col) => { if (col.variables) col.variables = col.variables.filter((v) => v.key || v.value); });
  if (c.globals) c.globals.vars = (c.globals.vars || []).filter((v) => v.key || v.value);
  return c;
}

// ---------- Query string <-> tabela ----------
function splitUrl(url) {
  const i = url.indexOf('?');
  return i === -1 ? [url, ''] : [url.slice(0, i), url.slice(i + 1)];
}
const safeDecode = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
function syncParamsFromUrl(req) {
  const [, q] = splitUrl(req.url);
  const disabled = req.params.filter((p) => p.enabled === false && (p.key || p.value));
  const parsed = q ? q.split('&').filter(Boolean).map((part) => {
    const j = part.indexOf('=');
    return { key: safeDecode(j === -1 ? part : part.slice(0, j)), value: j === -1 ? '' : safeDecode(part.slice(j + 1)), enabled: true };
  }) : [];
  req.params = [...parsed, ...disabled];
}
function syncUrlFromParams(req) {
  const [base] = splitUrl(req.url);
  const q = req.params.filter((p) => p.enabled !== false && p.key).map((p) => (p.value === '' ? p.key : `${p.key}=${p.value}`)).join('&');
  req.url = q ? `${base}?${q}` : base;
}

// ---------- Abas ----------
function openTab(req, ref = null) {
  if (ref) {
    const open = session().tabs.find((t) => t.ref && t.ref.reqId === ref.reqId);
    if (open) return focusTab(open.id);
  }
  const tab = { id: uid('tab'), ref, draft: clone(req), dirty: false };
  session().tabs.push(tab);
  focusTab(tab.id);
}
function focusTab(id) {
  session().active = id;
  persist();
  renderTabs(); renderRequest(); renderResponse(); renderSidebar();
}
async function closeTab(id) {
  const s = session();
  const tab = s.tabs.find((t) => t.id === id);
  if (tab?.dirty && !(await confirmModal({ title: 'Descartar alterações?', sub: `"${tab.draft.name}" tem alterações não salvas.`, ok: 'Descartar' }))) return;
  if (tab) liveCloseTab(tab);
  const idx = s.tabs.findIndex((t) => t.id === id);
  s.tabs.splice(idx, 1);
  delete runtime[id];
  if (!s.tabs.length) s.tabs.push({ id: uid('tab'), ref: null, draft: newRequest(), dirty: false });
  if (s.active === id) s.active = s.tabs[Math.max(0, idx - 1)].id;
  focusTab(s.active);
}
function markDirty() {
  const tab = activeTab();
  if (!tab) return;
  tab.dirty = true;
  $('#dirtyDot').classList.add('on');
  const el = $(`.tab[data-id="${tab.id}"]`);
  if (el) { el.classList.add('dirty'); $('.name', el).textContent = tab.draft.name; $('.m', el).textContent = tab.draft.method; $('.m', el).className = 'm ' + methodClass(tab.draft.method); }
  persist();
}

function renderTabs() { renderTabsCore(); decorateCollab(); }
function renderTabsCore() {
  const wrap = $('#tabs');
  wrap.innerHTML = '';
  for (const t of session().tabs) {
    const el = h('div', { class: `tab${t.id === session().active ? ' active' : ''}${t.dirty ? ' dirty' : ''}${rt(t).live?.state === 'open' ? ' live-on' : ''}`, 'data-id': t.id, 'data-req': t.ref?.reqId || null, title: t.draft.url || t.draft.name },
      h('span', { class: 'm ' + methodClass(t.draft.method) }, t.draft.method),
      h('span', { class: 'name' }, t.draft.name),
      h('button', { class: 'x', title: 'Fechar (Ctrl W)', html: icons.x, onclick: (e) => { e.stopPropagation(); closeTab(t.id); } }));
    el.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } });
    el.addEventListener('click', () => focusTab(t.id));
    wrap.append(el);
  }
  wrap.append(h('button', { class: 'tab-add', title: 'Nova aba (Ctrl T)', onclick: () => openTab(newRequest()) }, '+'));
  $('.tab.active', wrap)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ---------- Seletor de método ----------
const METHODS = [
  ['GET', 'Buscar dados'], ['POST', 'Criar recurso'], ['PUT', 'Substituir recurso'], ['PATCH', 'Atualizar em parte'],
  ['DELETE', 'Remover recurso'], ['HEAD', 'Só os headers'], ['OPTIONS', 'Métodos permitidos'],
  ['WS', 'WebSocket (conexão contínua)'], ['SSE', 'Server-Sent Events (eventos do servidor)'],
];
const methodClass = (m) => (METHODS.some(([k]) => k === m) ? m : 'CUSTOM');
function setMethodButton(m) {
  const lab = $('#method .method-label');
  lab.textContent = m; lab.className = 'method-label m ' + methodClass(m);
}
function setMethod(m) {
  m = String(m || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 20);
  if (!m) return;
  const r = activeTab().draft;
  if (r.method === m) return;
  const was = kindOf(r);
  r.method = m; setMethodButton(m); markDirty();
  if (was !== kindOf(r)) { const tab = activeTab(); if (was !== 'http') liveCloseTab(tab); renderRequest(); renderResponse(); }
}
function initMethodMenu() {
  const btn = $('#method'), menu = $('#methodMenu');
  let items = [], idx = 0;
  const close = (focusBtn = true) => {
    menu.classList.add('hidden'); btn.setAttribute('aria-expanded', 'false'); btn.classList.remove('open');
    document.removeEventListener('mousedown', outside, true);
    if (focusBtn) btn.focus();
  };
  const outside = (e) => { if (!menu.contains(e.target) && !btn.contains(e.target)) close(false); };
  const highlight = (i) => {
    idx = (i + items.length) % items.length;
    items.forEach((el, j) => el.classList.toggle('kb', j === idx));
    items[idx].scrollIntoView({ block: 'nearest' });
  };
  const open = () => {
    const current = activeTab().draft.method;
    menu.innerHTML = '';
    items = METHODS.map(([m, desc], i) => {
      const el = h('div', { class: 'mm-item' + (m === current ? ' selected' : ''), role: 'option', 'aria-selected': String(m === current),
        onmousedown: (e) => e.preventDefault(), onclick: () => { setMethod(m); close(); }, onmousemove: () => highlight(i) },
        h('span', { class: 'm ' + m }, m), h('span', { class: 'mm-desc' }, desc),
        h('span', { class: 'mm-check', html: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>' }));
      return el;
    });
    const custom = h('input', { class: 'mm-custom', placeholder: 'Digite um método personalizado', spellcheck: 'false', maxlength: '20',
      value: METHODS.some(([k]) => k === current) ? '' : current });
    custom.addEventListener('input', () => { custom.value = custom.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ''); });
    custom.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (custom.value) { setMethod(custom.value); close(); } }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowUp' && !custom.value) { e.preventDefault(); menu.focus(); highlight(items.length - 1); }
      e.stopPropagation();
    });
    menu.append(...items, h('div', { class: 'mm-sep' }), custom);
    const r = btn.getBoundingClientRect();
    menu.style.left = r.left + 'px'; menu.style.top = r.bottom + 6 + 'px';
    menu.classList.remove('hidden'); btn.setAttribute('aria-expanded', 'true'); btn.classList.add('open');
    highlight(Math.max(0, METHODS.findIndex(([k]) => k === current)));
    menu.focus();
    document.addEventListener('mousedown', outside, true);
  };
  menu.tabIndex = -1;
  btn.addEventListener('click', () => (menu.classList.contains('hidden') ? open() : close()));
  btn.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp'].includes(e.key) && menu.classList.contains('hidden')) { e.preventDefault(); open(); }
  });
  menu.addEventListener('keydown', (e) => {
    if (e.target.classList.contains('mm-custom')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(idx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(idx - 1); }
    else if (e.key === 'Home') { e.preventDefault(); highlight(0); }
    else if (e.key === 'End') { e.preventDefault(); highlight(items.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMethod(METHODS[idx][0]); close(); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); close(); }
    else if (/^[a-z]$/i.test(e.key) && !e.ctrlKey && !e.metaKey) {
      // Pula para o próximo método que começa com a letra digitada (G, P, D…).
      const L = e.key.toUpperCase();
      for (let k = 1; k <= items.length; k++) { const j = (idx + k) % items.length; if (METHODS[j][0][0] === L) { highlight(j); break; } }
    }
  });
  addEventListener('resize', () => close(false));
}

// ---------- Editor de requisição ----------
function renderRequest() {
  const tab = activeTab();
  const r = tab.draft;
  $('#reqName').value = r.name;
  const found = findRef(tab.ref);
  $('#crumbs').textContent = found ? [found.col.name, ...folderPath(found.col, found.req.folderId).map((f) => f.name)].join(' / ') + ' /' : '';
  setMethodButton(r.method);
  $('#url').value = r.url;
  $('#dirtyDot').classList.toggle('on', tab.dirty);
  const allowed = { http: ['params', 'headers', 'body', 'auth', 'scripts', 'examples', 'comments'], ws: ['message', 'params', 'headers', 'auth', 'comments'], sse: ['params', 'headers', 'auth', 'comments'] }[kindOf(r)];
  if (!allowed.includes(reqTab)) reqTab = allowed[0];
  $('#compareBtn')?.classList.toggle('hidden', kindOf(r) !== 'http');
  $('#curlBtn')?.classList.toggle('hidden', kindOf(r) !== 'http');
  $$('#reqTabs button').forEach((b) => { b.classList.toggle('active', b.dataset.rt === reqTab); b.hidden = !allowed.includes(b.dataset.rt); });
  updateCounts();
  renderReqEditor();
  window.MonoVars.refresh();
}
function updateCounts() {
  const r = activeTab().draft;
  const n = (l) => l.filter((p) => p.enabled !== false && p.key).length || '';
  $('#cParams').textContent = n(r.params);
  $('#cHeaders').textContent = n(r.headers);
  $('#cScripts').classList.toggle('on', !!(String(r.pre || '').trim() || String(r.tests || '').trim()));
  $('#cExamples').textContent = (r.examples || []).length || '';
  const tabRef = activeTab().ref;
  $('#cComments').textContent = tabRef ? commentsFor(tabRef.reqId).filter((c) => !c.resolved).length || '' : '';
}
function chips(options, current, onPick) {
  return h('div', { class: 'radio-row' }, options.map(([val, label]) =>
    h('button', { class: 'chip' + (current === val ? ' active' : ''), onclick: () => onPick(val) }, label)));
}
function renderReqEditor() {
  const ed = $('#reqEditor');
  const r = activeTab().draft;
  ed.innerHTML = '';
  ed.classList.toggle('fill', reqTab === 'scripts');
  const changed = () => { markDirty(); updateCounts(); };

  if (reqTab === 'params') {
    ed.append(kvTable(r.params, () => { syncUrlFromParams(r); $('#url').value = r.url; changed(); }, { keyPh: 'Parâmetro' }));
  } else if (reqTab === 'headers') {
    ed.append(kvTable(r.headers, changed, { keyPh: 'Header' }));
    ed.append(h('p', { class: 'hint' }, 'Content-Type e Authorization são adicionados automaticamente pelo Body e pelo Auth, a menos que você defina aqui.'));
  } else if (reqTab === 'body') {
    renderBodyEditor(ed, r.body, changed);
  } else if (reqTab === 'auth') {
    const tab = activeTab();
    const found = findRef(tab.ref);
    r.auth ||= { type: 'inherit' };
    ed.append(window.MonoAuth.editor(r.auth, {
      onChange: changed, allowInherit: true, vars: envVars,
      inherited: found ? inheritedAuth(found.col, found.req.folderId) : null,
      onEditParent: found ? () => { const inh = inheritedAuth(found.col, found.req.folderId); openContainerAuth(found.col, inh.holder === found.col ? null : inh.holder); } : null,
    }));
  } else if (reqTab === 'comments') {
    renderCommentsTab(ed, activeTab());
  } else if (reqTab === 'message') {
    renderMessageEditor(ed, activeTab());
  } else if (reqTab === 'examples') {
    renderExamplesTab(ed, activeTab());
  } else if (reqTab === 'scripts') {
    const which = scriptWhich || (String(r.pre || '').trim() && !String(r.tests || '').trim() ? 'pre' : 'post');
    ed.append(window.MonoScripts.scriptsPanel(r, { which, onWhich: (k) => { scriptWhich = k; }, onChange: changed }));
  }
}

// ---------- Body: JSON, XML/SOAP, texto, form-data (com arquivos), URL-encoded e binário ----------
const SOAP_TEMPLATES = [
  ['SOAP 1.1 — envelope', `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header/>
  <soap:Body>
    <Operacao xmlns="http://tempuri.org/">
      <parametro>valor</parametro>
    </Operacao>
  </soap:Body>
</soap:Envelope>`, { headers: [['SOAPAction', '"http://tempuri.org/Operacao"']] }],
  ['SOAP 1.2 — envelope', `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Header/>
  <soap12:Body>
    <Operacao xmlns="http://tempuri.org/">
      <parametro>valor</parametro>
    </Operacao>
  </soap12:Body>
</soap12:Envelope>`],
  ['SEFAZ · NF-e Status do Serviço 4.00', `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4">
      <consStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
        <tpAmb>2</tpAmb>
        <cUF>35</cUF>
        <xServ>STATUS</xServ>
      </consStatServ>
    </nfeDadosMsg>
  </soap12:Body>
</soap12:Envelope>`, { url: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx', note: 'Modelo de homologação de SP (tpAmb 2, cUF 35). Troque a URL e o cUF para o seu estado e cadastre o certificado A1 em Configurações › Certificados.' }],
];
const fmtSize = (n) => (n == null ? '' : fmtBytes(n));
function filePickButton(label, current, onPick, filters) {
  return h('button', { class: 'btn-ghost sm', type: 'button', onclick: async () => {
    const r = await api.pickFile({ filters, title: label });
    if (r && r.ok) onPick(r);
  } }, current ? 'Trocar arquivo' : label);
}
function multipartTable(rows, onChange) {
  const table = h('table', { class: 'kv mp' });
  const draw = () => {
    table.innerHTML = '';
    table.append(h('tr', {}, h('th', {}), h('th', {}, 'Campo'), h('th', { style: 'width:110px' }, 'Tipo'), h('th', {}, 'Valor'), h('th', {})));
    rows.forEach((r, i) => {
      const chk = h('input', { type: 'checkbox', checked: r.enabled !== false, onchange: (e) => { r.enabled = e.target.checked; onChange(); } });
      const k = h('input', { type: 'text', value: r.key || '', placeholder: 'campo', spellcheck: 'false' });
      k.addEventListener('input', () => { r.key = k.value; onChange(); });
      const kind = h('select', {}, h('option', { value: 'text' }, 'Texto'), h('option', { value: 'file' }, 'Arquivo'));
      kind.value = r.kind === 'file' ? 'file' : 'text';
      kind.addEventListener('change', () => { r.kind = kind.value; onChange(); draw(); });
      let val;
      if (r.kind === 'file') {
        val = h('div', { class: 'mp-file' },
          r.file ? h('span', { class: 'mp-name', title: r.file }, r.fileName || r.file.split(/[\\/]/).pop(), h('span', { class: 'muted' }, ' ' + fmtSize(r.size))) : h('span', { class: 'muted' }, r.fileName ? `${r.fileName} — escolha de novo neste computador` : 'Nenhum arquivo'),
          filePickButton('Escolher arquivo', r.file, (f) => { r.file = f.path; r.fileName = f.name; r.size = f.size; onChange(); draw(); }));
      } else {
        val = h('input', { type: 'text', value: r.value || '', placeholder: 'valor', spellcheck: 'false' });
        val.addEventListener('input', () => { r.value = val.value; onChange(); });
      }
      table.append(h('tr', { class: r.enabled === false ? 'off' : '' }, h('td', { class: 'chk' }, chk), h('td', {}, k), h('td', { class: 'mp-kind' }, kind), h('td', {}, val),
        h('td', { class: 'act' }, h('button', { class: 'del', title: 'Remover', html: icons.x, onclick: () => { rows.splice(i, 1); onChange(); draw(); } }))));
      queueMicrotask(() => customSelect(kind, { variant: 'compact' }));
    });
  };
  draw();
  return h('div', {}, table, h('div', { class: 'row-actions', style: 'margin-top:8px' },
    h('button', { class: 'btn-ghost sm', type: 'button', onclick: () => { rows.push({ key: '', value: '', kind: 'text', enabled: true }); onChange(); draw(); } }, '+ Campo de texto'),
    h('button', { class: 'btn-ghost sm', type: 'button', onclick: () => { rows.push({ key: 'arquivo', kind: 'file', enabled: true }); onChange(); draw(); } }, '+ Arquivo')));
}
function renderBodyEditor(ed, b, changed) {
  b.form ||= []; b.multipart ||= [];
  // Tipo do corpo num select (como no Postman); as ações do tipo ficam na mesma linha.
  const typeSel = h('select', {}, [['none', 'Nenhum'], ['json', 'JSON'], ['graphql', 'GraphQL'], ['xml', 'XML / SOAP'], ['text', 'Texto'], ['multipart', 'Form-data'], ['form', 'x-www-form-urlencoded'], ['binary', 'Binário']]
    .map(([v, l]) => h('option', { value: v }, l)));
  typeSel.value = b.type || 'none';
  typeSel.addEventListener('change', () => {
    if (typeSel.value === 'xml' && b.type === 'json') b.raw = '';
    b.type = typeSel.value;
    if (b.type === 'graphql') { const r = activeTab().draft; if (!isMutating(r.method) || kindOf(r) !== 'http') { r.method = 'POST'; setMethodButton('POST'); } }
    changed(); renderReqEditor();
  });
  const bar = h('div', { class: 'body-bar' }, h('span', { class: 'body-bar-label' }, 'Tipo'), typeSel);
  ed.append(bar);
  queueMicrotask(() => customSelect(typeSel, { variant: 'compact' }));
  if (b.type === 'json' || b.type === 'text' || b.type === 'xml') {
    const ph = b.type === 'json' ? '{\n  "chave": "{{variavel}}"\n}' : b.type === 'xml' ? '<?xml version="1.0" encoding="utf-8"?>\n<raiz>\n  <campo>{{variavel}}</campo>\n</raiz>' : 'Texto livre';
    // Mesmo editor dos scripts: números de linha, cores e linha atual em destaque (padrão do app).
    const highlight = b.type === 'json' ? highlightJson : b.type === 'xml' ? (v) => v.split('\n').map(highlightMarkupLine).join('\n') : (v) => esc(v);
    const editor = window.MonoScripts.codeEditor({ value: b.raw || '', placeholder: ph, label: 'Corpo', highlight, complete: false, onChange: (v) => { b.raw = v; changed(); } });
    const ta = { set value(v) { editor.setValue(v); }, get value() { return editor.getValue(); } };
    if (b.type === 'json') {
      bar.append(h('div', { class: 'grow' }), h('button', { class: 'btn-ghost sm', onclick: () => {
        try { ta.value = b.raw = JSON.stringify(JSON.parse(b.raw), null, 2); changed(); } catch (e) { toast('JSON inválido: ' + e.message, 2600); }
      } }, 'Formatar JSON'));
    }
    if (b.type === 'xml') {
      const r = activeTab().draft;
      bar.append(h('span', { class: 'muted small' }, /http:\/\/www\.w3\.org\/2003\/05\/soap-envelope/.test(b.raw || '') ? 'application/soap+xml (SOAP 1.2)' : 'text/xml'), h('div', { class: 'grow' }),
        h('button', { class: 'btn-ghost sm', type: 'button', onclick: (e) => showMenu(e.currentTarget, SOAP_TEMPLATES.map(([label, xml, extra = {}]) => ({ label, run: () => {
          ta.value = b.raw = xml;
          if (!isMutating(r.method)) { r.method = 'POST'; setMethodButton('POST'); }
          if (extra.url && !r.url.trim()) { r.url = extra.url; $('#url').value = r.url; syncParamsFromUrl(r); }
          for (const [k, v] of extra.headers || []) if (!r.headers.some((x) => x.key.toLowerCase() === k.toLowerCase() && x.value)) r.headers.splice(Math.max(0, r.headers.length - 1), 0, { key: k, value: v, enabled: true });
          changed(); renderRequest();
          if (extra.note) toast(extra.note, 6000);
        } }))) }, 'Modelos SOAP ▾'),
        h('button', { class: 'btn-ghost sm', type: 'button', onclick: async () => {
          if (/<Signature[\s>]/.test(b.raw || '') && !(await confirmModal({ title: 'Formatar XML assinado?', sub: 'Mudar espaços e quebras de linha invalida a assinatura digital. Você vai precisar assinar de novo.', ok: 'Formatar mesmo assim' }))) return;
          const f = window.MonoFormat.pretty('xml', b.raw); if (f) { ta.value = b.raw = f; changed(); } else toast('Não consegui formatar esse XML.', 2400);
        } }, 'Formatar XML'),
        h('button', { class: 'btn-ghost sm', type: 'button', title: 'Assinatura digital XMLDSig com o certificado A1', onclick: () => openSignXml(b, () => { changed(); renderReqEditor(); }) }, 'Assinar'),
        /<Signature[\s>]/.test(b.raw || '') ? h('button', { class: 'btn-text sm', type: 'button', onclick: async () => {
          const v = await api.verifyXml(b.raw);
          if (v.error && !v.results.length) return toast(v.error, 3000);
          toast(v.ok ? `✓ ${v.results.length} assinatura(s) válida(s) — ${v.results[0].subject.split(',')[0]}` : `Assinatura inválida: ${v.results.map((x) => x.error || (x.digestOk ? 'valor da assinatura não confere' : 'conteúdo alterado depois de assinar')).join('; ')}`, 4200);
        } }, 'Verificar') : null);
    }
    ed.append(h('div', { class: 'body-code' }, editor));
  } else if (b.type === 'graphql') {
    renderGraphqlBody(ed, bar, b, changed);
  } else if (b.type === 'form') {
    ed.append(kvTable(b.form, changed, { keyPh: 'Campo' }));
  } else if (b.type === 'multipart') {
    ed.append(multipartTable(b.multipart, changed),
      h('p', { class: 'hint' }, 'Enviado como multipart/form-data. O arquivo é lido do seu computador na hora do envio.'));
  } else if (b.type === 'binary') {
    const f = b.file;
    ed.append(h('div', { class: 'bin-box' },
      f && f.path ? h('div', {}, h('b', {}, f.name), h('span', { class: 'muted' }, ` · ${fmtSize(f.size)}`), h('div', { class: 'muted small mono' }, f.path))
        : h('div', { class: 'muted' }, f && f.name ? `${f.name} — escolha o arquivo de novo neste computador.` : 'Nenhum arquivo escolhido. O conteúdo do arquivo vai como corpo da requisição.'),
      h('div', { class: 'row-actions' }, filePickButton('Escolher arquivo', f && f.path, (x) => { b.file = { path: x.path, name: x.name, size: x.size }; changed(); renderReqEditor(); }),
        f ? h('button', { class: 'btn-text sm', type: 'button', onclick: () => { b.file = null; changed(); renderReqEditor(); } }, 'Remover') : null)));
  } else {
    ed.append(h('p', { class: 'hint' }, 'Esta requisição não envia corpo.'));
  }
}

// ---------- Assinatura XML (XMLDSig) ----------
// Certificado: o configurado para o host da URL; se houver só um cadastrado, ele.
function certFor(url) {
  const list = (settings().certs || []).filter((c) => c.enabled !== false && c.path);
  return certForUrl(url) || (list.length === 1 ? list[0] : null);
}
async function signForUrl({ xml, tag, alg, minify, url, vars }) {
  const cert = certFor(fill(url || '', vars || envVars()));
  if (!cert) return { ok: false, error: 'Nenhum certificado para este host. Cadastre em Configurações › Certificados.' };
  const r = await api.signXml({ xml, tag, certPath: cert.path, passphrase: cert.passphrase, alg, minify });
  return { ...r, cert: cert.name };
}
// Elementos com atributo Id (candidatos a assinatura): infNFe, infEvento, infInut…
function signCandidates(xml) {
  const X = window.MonoXml;
  const doc = X.parse(xml);
  const seen = new Map();
  for (const e of X.walk(doc.root)) {
    const id = X.attr(e, 'Id') ?? X.attr(e, 'ID') ?? X.attr(e, 'id');
    if (id != null && e.local !== 'Signature') seen.set(e.local, (seen.get(e.local) || 0) + 1);
  }
  return [...seen].map(([tag, count]) => ({ tag, count }));
}
function openSignXml(b, onDone) {
  let cands;
  try { cands = signCandidates(b.raw || ''); } catch (e) { return toast(e.message, 3600); }
  const r = activeTab().draft;
  const certs = (settings().certs || []).filter((c) => c.enabled !== false && c.path);
  openModal((body, close) => {
    if (!certs.length) {
      body.append(h('h2', {}, 'Assinar XML'), h('p', { class: 'sub' }, 'Para assinar, cadastre o certificado digital (.pfx) em Configurações › Certificados.'),
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn-ghost', onclick: close }, 'Cancelar'), h('button', { class: 'btn-primary', onclick: () => { close(); openSettings('certs'); } }, 'Abrir Certificados')));
      return;
    }
    const certSel = h('select', {}, certs.map((c, i) => h('option', { value: String(i) }, `${c.name}${c.host ? ' · ' + c.host : ''}`)));
    const pre = certFor(fill(r.url, envVars()));
    certSel.value = String(Math.max(0, certs.indexOf(pre)));
    const tagSel = h('select', {}, [...cands.map((c) => h('option', { value: c.tag }, `<${c.tag}>${c.count > 1 ? ` · ${c.count} ocorrências` : ''}`)), h('option', { value: '' }, 'Documento inteiro (Reference URI="")')]);
    const preferred = ['infNFe', 'infEvento', 'infInut', 'infCte', 'infMDFe', 'infCanc', 'infDPS', 'infRps'].find((t) => cands.some((c) => c.tag === t));
    tagSel.value = preferred || (cands[0] ? cands[0].tag : '');
    const algSel = h('select', {}, h('option', { value: 'sha1' }, 'RSA-SHA1 — NF-e, NFC-e, CT-e, MDF-e'), h('option', { value: 'sha256' }, 'RSA-SHA256 — eSocial, EFD-Reinf, algumas NFS-e'));
    const minify = h('input', { type: 'checkbox', checked: true });
    const err = h('p', { class: 'form-err' });
    const go = h('button', { class: 'btn-primary', type: 'button', onclick: async () => {
      err.textContent = ''; go.disabled = true; go.textContent = 'Assinando…';
      const c = certs[Number(certSel.value)];
      const res = await api.signXml({ xml: b.raw, tag: tagSel.value, certPath: c.path, passphrase: c.passphrase, alg: algSel.value, minify: minify.checked });
      go.disabled = false; go.textContent = 'Assinar';
      if (!res.ok) { err.textContent = res.error; return; }
      b.raw = res.xml; close(); onDone();
      const n = (res.xml.match(/<Signature[\s>]/g) || []).length;
      toast(`XML assinado com ${c.name} · ${n} assinatura(s)`, 3000);
    } }, 'Assinar');
    body.append(h('h2', {}, 'Assinar XML com certificado digital'),
      h('p', { class: 'sub' }, 'Assinatura XMLDSig "enveloped" no padrão dos documentos fiscais: canonicalização C14N, Reference para o Id do elemento e certificado no KeyInfo. Se o XML estiver dentro de um envelope SOAP, só o documento fiscal é assinado.'),
      h('div', { class: 'field' }, h('label', {}, 'Certificado'), certSel),
      h('div', { class: 'field-row' }, h('div', { class: 'field' }, h('label', {}, 'Elemento a assinar'), tagSel), h('div', { class: 'field' }, h('label', {}, 'Algoritmo'), algSel)),
      h('label', { class: 'check-row' }, minify, h('span', {}, h('b', {}, 'Remover formatação antes de assinar'), ' — a SEFAZ rejeita quebras de linha e espaços entre as tags (rejeição 588). Não reformate depois de assinar.')),
      err,
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn-ghost', onclick: close }, 'Cancelar'), go));
    queueMicrotask(() => { customSelect(certSel); customSelect(tagSel); customSelect(algSel); });
  });
  $('#modalBody').classList.add('wide');
}

// ---------- Collection Runner ----------
// Executa uma coleção ou pasta em sequência, com scripts, várias iterações e arquivo de dados (CSV/JSON).
function requestsInOrder(col, fid) {
  const out = [];
  const walk = (f) => { for (const sub of childFolders(col, f)) walk(sub.id); for (const r of childReqs(col, f)) out.push(r); };
  walk(fid || null);
  return out;
}
function applyToList(list, ch) {
  for (const [k, c] of Object.entries(ch || {})) {
    const i = list.findIndex((v) => v.key === k);
    if (c.unset) { if (i >= 0) list.splice(i, 1); continue; }
    if (i >= 0) { list[i].value = c.value; list[i].enabled = true; } else list.push({ key: k, value: c.value, enabled: true, ...(looksSecret(k) ? { secret: true } : {}) });
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function runnerExec(col, reqObj, ctx) {
  const tab = { id: 'runner', ref: { colId: col.id, reqId: reqObj.id }, draft: reqObj };
  let req = clone(reqObj);
  const rec = { iteration: ctx.i, reqId: reqObj.id, name: reqObj.name, method: req.method, url: '', tests: [], logs: [] };
  const w = ctx.w;
  const scopes = () => ({ globals: listVars(w.glob), collection: listVars(w.col), environment: listVars(w.env) });
  const base = { data: ctx.row, iteration: ctx.i, iterationCount: ctx.n, info: { requestName: req.name, requestId: reqObj.id } };
  const absorb = (out) => {
    applyToList(w.env, out.changes?.environment); applyToList(w.col, out.changes?.collection); applyToList(w.glob, out.changes?.globals);
    rec.tests.push(...(out.results || [])); rec.logs.push(...(out.logs || []));
    if (out.visualizer) rec.visualizer = out.visualizer;
  };
  let local = {}, next;
  const pre = scriptChain(tab, req, 'pre');
  if (pre.length) {
    const out = await runScripts({ event: 'prerequest', scripts: pre, request: req, vars: scopes(), ...base });
    absorb(out); local = out.local || {};
    if (out.nextRequest !== undefined) next = out.nextRequest;
    if (out.error) { rec.error = scriptErrorText('Antes da requisição', out.error); return { rec, next }; }
    if (out.skipRequest) { rec.skipped = true; return { rec, next }; }
    if (out.request) req = { ...req, ...out.request };
  }
  const s = scopes();
  const vars = { ...s.globals, ...s.collection, ...s.environment, ...ctx.row, ...local };
  await prepareAuth(tab, req, vars);
  const res = await api.send(req, vars);
  rec.method = req.method; rec.url = (res.request && res.request.url) || fill(req.url, vars); rec.time = res.time ?? null;
  if (!res.ok) { rec.error = res.error; return { rec, next }; }
  Object.assign(rec, { status: res.status, statusText: res.statusText, size: res.size, contentType: res.contentType, body: res.body ? res.body.slice(0, 20000) : null, truncated: !!(res.body && res.body.length > 20000) });
  const post = scriptChain(tab, req, 'tests');
  if (post.length) {
    const out = await runScripts({ event: 'test', scripts: post, request: req, response: res, vars: scopes(), local, ...base });
    absorb(out);
    if (out.nextRequest !== undefined) next = out.nextRequest;
    if (out.error) rec.error = scriptErrorText('Após a resposta', out.error);
  }
  return { rec, next };
}
const recFailed = (r) => !!r.error || (r.tests || []).some((t) => !t.pass && !t.skipped);

function openRunner(col, folder) {
  const Rn = window.MonoRunner;
  const all = requestsInOrder(col, folder ? folder.id : null);
  const sel = new Set(all.map((r) => r.id));
  const cfg = { iterations: 1, delay: 0, persist: true, stopOnFail: false, keepBodies: true };
  let dataFile = null; // { name, kind, columns, rows }
  let state = null;    // execução em andamento/terminada
  const title = folder ? `${col.name} / ${folder.name}` : col.name;
  openModal((body, close) => {
    const root = h('div', { class: 'runner' });
    body.append(root);
    const drawConfig = () => {
      root.innerHTML = '';
      const env = activeEnv();
      const list = h('div', { class: 'rn-list' });
      const drawList = () => {
        list.innerHTML = '';
        all.forEach((r) => {
          const path = folderPath(col, r.folderId).map((f) => f.name).join(' / ');
          list.append(h('label', { class: 'rn-item' },
            h('input', { type: 'checkbox', checked: sel.has(r.id), onchange: (e) => { if (e.target.checked) sel.add(r.id); else sel.delete(r.id); count.textContent = `${sel.size} de ${all.length}`; } }),
            h('span', { class: 'm ' + methodClass(r.method) }, r.method), h('span', { class: 'rn-name' }, r.name), path ? h('span', { class: 'muted small' }, path) : null));
        });
      };
      const count = h('span', { class: 'muted small' }, `${sel.size} de ${all.length}`);
      drawList();
      const num = (key, min, label, suffix) => {
        const i = h('input', { class: 'input sm', type: 'number', min: String(min), value: String(cfg[key]), style: 'width:110px' });
        i.addEventListener('input', () => { cfg[key] = Math.max(min, Number(i.value) || min); });
        return h('div', { class: 'field' }, h('label', {}, label), h('div', { class: 'row-actions' }, i, suffix ? h('span', { class: 'muted small' }, suffix) : null));
      };
      const check = (key, t, sub) => h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: cfg[key], onchange: (e) => { cfg[key] = e.target.checked; } }), h('span', {}, h('b', {}, t), sub ? ' — ' + sub : ''));
      const dataBox = h('div', { class: 'rn-data' });
      const drawData = () => {
        dataBox.innerHTML = '';
        if (!dataFile) {
          dataBox.append(h('p', { class: 'muted small', style: 'margin:0 0 8px' }, 'Opcional. Cada linha vira uma iteração; as colunas viram variáveis ({{cpf}}) e ficam em pm.iterationData.'),
            h('button', { class: 'btn-ghost sm', type: 'button', onclick: async () => {
              const r = await api.openFile({ filters: [{ name: 'Dados', extensions: ['csv', 'json', 'txt'] }] });
              if (!r.ok) { if (r.error) toast(r.error, 2600); return; }
              try { dataFile = { name: r.name, ...Rn.parseDataFile(r.content, r.name) }; cfg.iterations = dataFile.rows.length || 1; drawConfig(); }
              catch (e) { toast(e.message, 3200); }
            } }, 'Escolher CSV ou JSON…'));
          return;
        }
        const prev = dataFile.rows.slice(0, 5);
        dataBox.append(h('div', { class: 'row-actions' }, h('b', {}, dataFile.name), h('span', { class: 'muted small' }, `${dataFile.kind} · ${dataFile.rows.length} linha(s) · ${dataFile.columns.length} coluna(s)`), h('div', { class: 'grow' }),
          h('button', { class: 'btn-text sm', type: 'button', onclick: () => { dataFile = null; cfg.iterations = 1; drawConfig(); } }, 'Remover')),
          h('div', { class: 'rn-preview' }, h('table', { class: 'data-table' }, h('tr', {}, dataFile.columns.map((c) => h('th', {}, `{{${c}}}`))),
            prev.map((row) => h('tr', {}, dataFile.columns.map((c) => h('td', { class: 'mono-cell' }, String(row[c] ?? '')))))),
            dataFile.rows.length > 5 ? h('div', { class: 'muted small', style: 'padding:6px 8px' }, `+ ${dataFile.rows.length - 5} linha(s)`) : null));
      };
      drawData();
      const runBtn = h('button', { class: 'btn-primary', type: 'button', onclick: () => start() }, `Executar ${title}`);
      root.append(
        h('h2', {}, 'Executar coleção'),
        h('p', { class: 'sub' }, `${title} · ambiente: ${env ? env.name : 'nenhum'}`),
        h('div', { class: 'rn-grid' },
          h('div', {}, h('div', { class: 'row-actions rn-head' }, h('b', {}, 'Ordem de execução'), count, h('div', { class: 'grow' }),
            h('button', { class: 'btn-text sm', type: 'button', onclick: () => { all.forEach((r) => sel.add(r.id)); drawList(); count.textContent = `${sel.size} de ${all.length}`; } }, 'Todas'),
            h('button', { class: 'btn-text sm', type: 'button', onclick: () => { sel.clear(); drawList(); count.textContent = `0 de ${all.length}`; } }, 'Nenhuma')), list),
          h('div', { class: 'rn-side' },
            h('div', { class: 'field-row' }, num('iterations', 1, 'Iterações', dataFile ? 'uma por linha' : ''), num('delay', 0, 'Intervalo', 'ms')),
            h('div', { class: 'field' }, h('label', {}, 'Arquivo de dados'), dataBox),
            check('persist', 'Gravar variáveis no ambiente', 'o que os scripts salvarem fica no ambiente ao final'),
            check('stopOnFail', 'Parar na primeira falha'),
            check('keepBodies', 'Guardar respostas no relatório', 'até 20 KB cada'))),
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn-ghost', onclick: close }, 'Fechar'), runBtn));
    };

    async function start() {
      const list = all.filter((r) => sel.has(r.id));
      if (!list.length) return toast('Selecione ao menos uma requisição.', 2200);
      const env = activeEnv();
      const n = Math.max(1, cfg.iterations | 0);
      if (env && env.prod && list.some((r) => isMutating(r.method)) && !(await confirmModal({ title: 'Executar em produção?', sub: `O ambiente "${env.name}" é de produção e a execução tem ${list.filter((r) => isMutating(r.method)).length} requisição(ões) que alteram dados, repetidas em ${n} iteração(ões).`, ok: 'Executar em produção' }))) return;
      state = { name: title, envName: env ? env.name : '', startedAt: Date.now(), iterations: n, dataFile: dataFile ? dataFile.name : '', records: [], stop: false, running: true, filter: 'all', open: new Set() };
      const w = { env: env ? clone(env.vars) : [], col: clone(col.variables || []), glob: clone(globalsOf().vars) };
      drawRun();
      outer: for (let i = 0; i < n; i++) {
        const row = dataFile ? Rn.rowFor(dataFile.rows, i) : {};
        let idx = 0, steps = 0;
        while (idx < list.length && steps++ < list.length * 50) {
          if (state.stop) break outer;
          state.current = { i, name: list[idx].name };
          drawProgress();
          const { rec, next } = await runnerExec(col, list[idx], { i, n, row, w });
          if (!cfg.keepBodies) { delete rec.body; }
          state.records.push(rec);
          appendRecord(rec);
          drawProgress();
          if (cfg.stopOnFail && recFailed(rec)) { state.stopReason = 'Parou na primeira falha.'; break outer; }
          if (next === null) break;
          if (typeof next === 'string') {
            const j = list.findIndex((x) => x.name === next || x.id === next);
            if (j >= 0) { idx = j; continue; }
            rec.logs.push({ level: 'warn', text: `setNextRequest("${next}"): requisição não encontrada na execução.` });
          }
          idx++;
          if (cfg.delay && idx < list.length) await sleep(cfg.delay);
        }
      }
      state.running = false; state.current = null;
      if (state.stop && !state.stopReason) state.stopReason = 'Interrompida.';
      if (cfg.persist) {
        let e = env;
        if (!e && w.env.length) { e = { id: uid('env'), name: 'Local', vars: [] }; data.environments.push(e); data.activeEnvId = e.id; }
        if (e) e.vars = w.env;
        col.variables = w.col; globalsOf().vars = w.glob;
        persist(); renderEnvSelect(); window.MonoVars.refresh();
      }
      data.lastRun ||= {}; data.lastRun[col.id + (folder ? ':' + folder.id : '')] = { at: state.startedAt, summary: Rn.summarize(state.records) };
      persist();
      drawProgress(); drawActions();
    }

    let progEl, listEl, actionsEl;
    const drawRun = () => {
      root.innerHTML = '';
      progEl = h('div', { class: 'rn-prog' });
      listEl = h('div', { class: 'rn-records' });
      actionsEl = h('div', { class: 'modal-actions' });
      const filt = h('div', { class: 'radio-row', style: 'margin:0' });
      const drawFilt = () => { filt.innerHTML = ''; for (const [k, l] of [['all', 'Todas'], ['fail', 'Só falhas']]) filt.append(h('button', { class: 'chip' + (state.filter === k ? ' active' : ''), onclick: () => { state.filter = k; drawFilt(); redrawRecords(); } }, l)); };
      drawFilt();
      root.append(h('h2', {}, `Execução · ${title}`), h('p', { class: 'sub' }, `${state.envName ? 'Ambiente ' + state.envName + ' · ' : ''}${state.iterations} iteração(ões)${state.dataFile ? ' · dados: ' + state.dataFile : ''}`),
        progEl, h('div', { class: 'row-actions', style: 'margin:10px 0 6px' }, filt), listEl, actionsEl);
      drawProgress(); drawActions();
    };
    const drawProgress = () => {
      if (!progEl) return;
      const s = Rn.summarize(state.records);
      const total = all.filter((r) => sel.has(r.id)).length * state.iterations;
      const pct = Math.min(100, Math.round((state.records.length / Math.max(1, total)) * 100));
      progEl.innerHTML = '';
      progEl.append(h('div', { class: 'rn-bar' }, h('div', { class: 'rn-bar-fill' + (s.failedRequests ? ' bad' : ''), style: `width:${state.running ? pct : 100}%` })),
        h('div', { class: 'rn-stats' },
          h('div', {}, h('b', {}, String(s.requests)), 'requisições'),
          h('div', { class: 'ok' }, h('b', {}, String(s.testsPassed)), 'testes passaram'),
          h('div', { class: s.testsFailed ? 'bad' : '' }, h('b', {}, String(s.testsFailed)), 'testes falharam'),
          h('div', { class: s.errors ? 'bad' : '' }, h('b', {}, String(s.errors)), 'erros'),
          h('div', {}, h('b', {}, fmtTime(s.avgTime)), 'tempo médio')),
        h('div', { class: 'muted small' }, state.running ? `Executando iteração ${state.current ? state.current.i + 1 : 1}/${state.iterations}${state.current ? ' · ' + state.current.name : ''}…` : `${state.stopReason ? state.stopReason + ' ' : 'Concluída. '}Duração ${fmtTime(Date.now() - state.startedAt)}.`));
    };
    const recordEl = (r) => {
      const failed = recFailed(r);
      const passed = (r.tests || []).filter((t) => t.pass && !t.skipped).length, total = (r.tests || []).filter((t) => !t.skipped).length;
      const key = state.records.indexOf(r);
      const detail = h('div', { class: 'rn-detail' + (state.open.has(key) ? '' : ' hidden') });
      const fillDetail = () => {
        detail.innerHTML = '';
        detail.append(h('div', { class: 'mono small muted', style: 'word-break:break-all' }, r.url || ''));
        if (r.error) detail.append(h('pre', { class: 'res-error' }, r.error));
        if ((r.tests || []).length) detail.append(renderTestList(r.tests, null));
        if ((r.logs || []).length) detail.append(h('div', { class: 'section-label', style: 'margin-top:10px' }, 'Console'), renderConsole(r.logs));
        if (r.body != null) {
          const lang = window.MonoFormat.detect(r.contentType, r.body);
          const pretty = window.MonoFormat.pretty(lang, r.body) || r.body;
          detail.append(h('div', { class: 'section-label', style: 'margin-top:10px' }, `Resposta${r.truncated ? ' (primeiros 20 KB)' : ''}`), h('div', { class: 'rn-body' }, codeView(pretty, lang === 'json' ? 'json' : lang === 'html' || lang === 'xml' ? 'markup' : 'plain')));
        }
      };
      if (state.open.has(key)) fillDetail();
      const row = h('div', { class: 'rn-rec' + (failed ? ' fail' : '') },
        h('button', { class: 'rn-rec-head', type: 'button', onclick: () => { if (state.open.has(key)) { state.open.delete(key); detail.classList.add('hidden'); } else { state.open.add(key); fillDetail(); detail.classList.remove('hidden'); } } },
          h('span', { class: 'rn-it' }, `#${r.iteration + 1}`),
          h('span', { class: 'm ' + methodClass(r.method) }, r.method),
          h('span', { class: 'rn-name' }, r.name),
          r.skipped ? h('span', { class: 'badge' }, 'PULADA') : r.error && r.status == null ? h('span', { class: 'status err' }, 'ERRO') : h('span', { class: `status s${String(r.status)[0]}` }, String(r.status ?? '')),
          r.time != null ? h('span', { class: 'muted small' }, fmtTime(r.time)) : null,
          total ? h('span', { class: 'rn-tests ' + (passed === total ? 'ok' : 'bad') }, `${passed}/${total} testes`) : null),
        detail);
      return row;
    };
    const appendRecord = (r) => { if (state.filter === 'fail' && !recFailed(r)) return; listEl.append(recordEl(r)); listEl.scrollTop = listEl.scrollHeight; };
    const redrawRecords = () => { listEl.innerHTML = ''; for (const r of state.records) if (state.filter === 'all' || recFailed(r)) listEl.append(recordEl(r)); if (!listEl.children.length) listEl.append(h('div', { class: 'muted', style: 'padding:12px' }, state.filter === 'fail' ? 'Nenhuma falha.' : 'Nada executado ainda.')); };
    const drawActions = () => {
      actionsEl.innerHTML = '';
      if (state.running) { actionsEl.append(h('button', { class: 'btn-ghost', type: 'button', onclick: () => { state.stop = true; toast('Parando depois da requisição atual…', 2000); } }, 'Parar')); return; }
      const report = { name: state.name, envName: state.envName, startedAt: state.startedAt, iterations: state.iterations, dataFile: state.dataFile, summary: Rn.summarize(state.records), records: state.records };
      actionsEl.append(
        h('button', { class: 'btn-ghost', type: 'button', onclick: (e) => showMenu(e.currentTarget, [
          { label: 'Relatório HTML', run: () => saveText(`execucao-${slug(state.name)}.html`, Rn.reportHtml(report), [{ name: 'HTML', extensions: ['html'] }]) },
          { label: 'Resultado em JSON', run: () => saveText(`execucao-${slug(state.name)}.json`, JSON.stringify(report, null, 2), [{ name: 'JSON', extensions: ['json'] }]) },
        ]) }, 'Exportar relatório'),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn-ghost', type: 'button', onclick: () => { state = null; drawConfig(); } }, 'Configurar de novo'),
        h('button', { class: 'btn-ghost', type: 'button', onclick: () => start() }, 'Executar de novo'),
        h('button', { class: 'btn-primary', type: 'button', onclick: close }, 'Fechar'));
    };
    drawConfig();
  });
  $('#modalBody').classList.add('wide', 'xl');
}

// ---------- Gerar código (cURL, C#, JavaScript, Python, Power Automate) ----------
const CODE_KW_PY = new Set('import from as def return if else elif for in with open print True False None and or not'.split(' '));
function certForUrl(url) { return (settings().certs || []).find((c) => c.enabled !== false && c.path && /^https:/i.test(url) && window.MonoCodegen.hostMatches(c.host, url)) || null; }
function codegenSource(tab, resolve) {
  const d = clone(tab.draft);
  const vars = envVars();
  const f = (x) => (resolve ? fill(x, vars) : String(x ?? ''));
  const kv = (l) => (l || []).map((p) => ({ ...p, key: f(p.key), value: f(p.value) }));
  const auth = clone(resolveAuth(tab, d));
  for (const k of ['token', 'username', 'password', 'key', 'value']) if (auth[k] != null) auth[k] = f(auth[k]);
  const body = { ...d.body, raw: f(d.body.raw), form: kv(d.body.form), multipart: (d.body.multipart || []).map((p) => ({ ...p, key: f(p.key), value: f(p.value) })) };
  return { method: d.method, url: f(d.url), params: kv(d.params), headers: kv(d.headers), body, auth };
}
function openCodegen() {
  const tab = activeTab();
  const C = window.MonoCodegen;
  let lang = data.codegenLang || 'curl';
  let resolve = data.codegenResolve !== false;
  let withTypes = true;
  const last = rt(tab).response;
  const lastJson = last && last.ok && last.body ? Shape.tryJson(last.body) : { ok: false };
  openModal((body, close) => {
    const seg = h('div', { class: 'radio-row', style: 'margin:0' });
    const opts = h('div', { class: 'row-actions cg-opts' });
    const out = h('div', { class: 'res-body tg-out' });
    const note = h('p', { class: 'hint', style: 'margin:6px 0 0' });
    let code = '';
    const draw = () => {
      seg.innerHTML = ''; opts.innerHTML = '';
      for (const [k, label] of C.LANGS) seg.append(h('button', { class: 'chip' + (lang === k ? ' active' : ''), onclick: () => { lang = k; data.codegenLang = k; persist(); draw(); } }, label));
      opts.append(h('label', { class: 'check-row', style: 'margin:0' }, h('input', { type: 'checkbox', checked: resolve, onchange: (e) => { resolve = e.target.checked; data.codegenResolve = resolve; persist(); draw(); } }), h('span', {}, 'Resolver {{variáveis}}')));
      if (lang === 'csharp' && lastJson.ok) opts.append(h('label', { class: 'check-row', style: 'margin:0' }, h('input', { type: 'checkbox', checked: withTypes, onchange: (e) => { withTypes = e.target.checked; draw(); } }), h('span', {}, 'Incluir records da última resposta')));
      const src = codegenSource(tab, resolve);
      const cert = certForUrl(resolve ? src.url : fill(src.url, envVars()));
      let types = null;
      if (lang === 'csharp' && lastJson.ok && withTypes) {
        const name = Typegen.pascal(tab.draft.name || 'Resposta');
        const tcode = Typegen.toCSharp(lastJson.value, name);
        const m = tcode.match(/desserialize como (List<\w+>)/);
        types = { code: tcode, root: m ? m[1] : name };
      }
      try { code = C.generate(lang, src, { cert, types }); } catch (e) { code = '// ' + e.message; }
      const kind = lang === 'csharp' ? 'code:cs' : lang === 'fetch' || lang === 'axios' ? 'code:ts' : lang === 'python' ? 'code:py' : lang === 'powerautomate' ? 'json' : 'plain';
      out.innerHTML = ''; out.append(codeView(code, kind));
      note.textContent = lang === 'powerautomate'
        ? 'Copie e cole no designer do Power Automate (Ctrl+V em "Adicionar uma ação" › Minha área de transferência). Se não colar no seu ambiente, use URI, método, headers e corpo numa ação HTTP. Arquivos e .pfx entram como conteúdo de outra ação.'
        : cert ? `Inclui o certificado digital "${cert.name}" configurado para este host.` : !resolve ? 'As {{variáveis}} ficam como texto: substitua pelos valores no seu código.' : 'Segredos (tokens, senhas) aparecem no código — cuidado ao compartilhar.';
    };
    body.append(h('h2', {}, 'Gerar código'), h('p', { class: 'sub' }, 'A partir da requisição atual, com headers, corpo e autorização (inclusive a herdada da pasta/coleção).'),
      seg, opts, out, note,
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn-ghost', onclick: close }, 'Fechar'),
        h('button', { class: 'btn-primary', onclick: () => api.copy(code).then(() => toast('Código copiado')) }, 'Copiar código')));
    draw();
  });
  $('#modalBody').classList.add('wide');
}

// ---------- Envio ----------
// Roda a cadeia de scripts num worker isolado. pm.sendRequest volta para cá e sai pela rede do app.
function runScripts(input) {
  return new Promise((resolve) => {
    const w = new Worker('test-worker.js');
    const id = uid('s');
    let timer = null, inflight = 0, finished = false;
    const finish = (out) => {
      if (finished) return;
      finished = true; clearTimeout(timer); w.terminate();
      resolve({ results: [], logs: [], error: null, changes: {}, local: input.local || {}, ...out });
    };
    const arm = () => {
      clearTimeout(timer);
      if (!inflight) timer = setTimeout(() => finish({ error: { message: `O script passou de ${SCRIPT_TIMEOUT_MS / 1000}s e foi interrompido (loop infinito ou timer que nunca termina?).`, source: '' } }), SCRIPT_TIMEOUT_MS);
    };
    w.onmessage = async ({ data: m }) => {
      if (!m || m.id !== id) return;
      if (m.type === 'send') {
        inflight++; clearTimeout(timer);
        let res;
        try { res = await api.send(m.req, m.vars || {}); } catch (e) { res = { ok: false, error: e.message }; }
        inflight--; arm();
        if (!finished) w.postMessage({ type: 'sendResult', rid: m.rid, res });
      } else if (m.type === 'sign') {
        inflight++; clearTimeout(timer);
        const res = await signForUrl(m.opts);
        inflight--; arm();
        if (!finished) w.postMessage({ type: 'sendResult', rid: m.rid, res });
      } else if (m.type === 'done') finish(m);
    };
    w.onerror = (e) => { if (e.preventDefault) e.preventDefault(); finish({ error: { message: e.message || 'Não foi possível iniciar o sandbox de scripts.', source: '' } }); };
    arm();
    w.postMessage({ type: 'run', id, input });
  });
}
// Ordem do Postman: coleção → pastas (de fora para dentro) → requisição.
function scriptChain(tab, req, key) {
  const out = [];
  const found = findRef(tab.ref);
  if (found) {
    const { col } = found;
    if (String(col[key] || '').trim()) out.push({ code: col[key], source: `Coleção · ${col.name}` });
    for (const f of folderPath(col, found.req.folderId)) if (String(f[key] || '').trim()) out.push({ code: f[key], source: `Pasta · ${f.name}` });
  }
  if (String(req[key] || '').trim()) out.push({ code: req[key], source: 'Requisição' });
  return out;
}
// Grava o que os scripts mudaram (pm.environment / pm.globals / pm.collectionVariables).
function applyScriptChanges(changes, env, col) {
  const changed = [];
  const apply = (list, ch, guessSecret) => {
    for (const [k, c] of Object.entries(ch || {})) {
      const i = list.findIndex((v) => v.key === k);
      if (c.unset) { if (i >= 0) list.splice(i, 1); continue; }
      if (i >= 0) { if (list[i].value !== c.value) changed.push(k); list[i].value = c.value; list[i].enabled = true; }
      else { changed.push(k); list.push({ key: k, value: c.value, enabled: true, ...(guessSecret && /token|secret|senha|password/i.test(k) ? { secret: true } : {}) }); }
    }
  };
  const ch = changes || {};
  let touched = false;
  const envChanged = [];
  if (Object.keys(ch.environment || {}).length) {
    if (!env) { env = { id: uid('env'), name: 'Local', vars: [] }; data.environments.push(env); data.activeEnvId = env.id; renderEnvSelect(); }
    apply(env.vars, ch.environment, true); touched = true;
    envChanged.push(...changed);
  }
  if (Object.keys(ch.globals || {}).length) { apply(globalsOf().vars, ch.globals, false); touched = true; }
  if (Object.keys(ch.collection || {}).length) {
    if (col) { apply(col.variables ||= [], ch.collection, false); touched = true; }
    else toast('pm.collectionVariables só é gravado quando a requisição está salva numa coleção.', 3200);
  }
  if (touched) { persist(); window.MonoVars.refresh(); }
  return { env, envChanged };
}
const scriptErrorText = (phase, err) => `Erro no script "${phase}"${err.source ? ` (${err.source})` : ''}${err.line ? `, linha ${err.line}` : ''}: ${err.message}`;

// Trava de produção: requisições que alteram dados num ambiente marcado como produção pedem confirmação.
function confirmProduction(envs, req) {
  const prodEnvs = envs.filter((e) => e && e.prod);
  if (!prodEnvs.length || !isMutating(req.method)) return Promise.resolve(true);
  return new Promise((resolve) => {
    openModal((body, close) => {
      const done = (v) => { close(); resolve(v); };
      const url = fill(req.url, varsOf(prodEnvs[0]));
      const cancel = h('button', { class: 'btn-ghost', onclick: () => done(false) }, 'Cancelar');
      body.append(
        h('div', { class: 'prod-modal-tag' }, 'PRODUÇÃO'),
        h('h2', {}, `Enviar ${req.method} para produção?`),
        h('p', { class: 'sub' }, `O ambiente "${prodEnvs.map((e) => e.name).join('", "')}" está marcado como produção. Esta requisição pode alterar dados reais.`),
        h('div', { class: 'prod-target' }, h('span', { class: 'm ' + methodClass(req.method) }, req.method), h('code', {}, url)),
        h('div', { class: 'modal-actions' }, cancel, h('button', { class: 'btn-danger-solid', onclick: () => done(true) }, 'Enviar para produção')));
      setTimeout(() => cancel.focus(), 0);
    });
  });
}

function addHistory(req, res, env) {
  data.history.unshift({ id: uid('h'), at: Date.now(), method: req.method, url: req.url, env: env?.name || '', status: res.ok ? res.status : null, time: res.time ?? null, request: req });
  data.history.length = Math.min(data.history.length, HISTORY_MAX);
}

// Depois de cada resposta: testes, "o que mudou desde a última vez" e conferência com o contrato OpenAPI.
async function afterResponse(tab, req, res, env) {
  const state = rt(tab);
  state.changes = null; state.contract = null;
  if (!res.ok) return;
  const parsed = res.body ? Shape.tryJson(res.body) : { ok: false };
  if (parsed.ok) {
    const key = `${tab.ref?.reqId || req.method + ' ' + req.url}@${env?.id || '-'}#${res.status}`;
    const shape = Shape.inferShape(parsed.value);
    data.snapshots ||= {};
    const prev = data.snapshots[key];
    if (prev) state.changes = { since: prev.at, list: Shape.diffShape(prev.shape, shape) };
    data.snapshots[key] = { at: Date.now(), shape };
    const keys = Object.keys(data.snapshots);
    if (keys.length > 400) keys.sort((a, b) => data.snapshots[a].at - data.snapshots[b].at).slice(0, keys.length - 400).forEach((k) => delete data.snapshots[k]);
  }
  const col = req.contract && (findRef(tab.ref)?.col || data.collections.find((c) => c.id === req.contract.colId));
  if (col && col.spec) {
    try { state.contract = OpenApi.checkResponse(col.spec, req.contract, res.status, res.body ?? ''); }
    catch (e) { state.contract = { status: 'mismatch', message: 'Erro ao validar: ' + e.message, issues: [] }; }
  }
}

async function send() {
  const tab = activeTab();
  if (kindOf(tab.draft) !== 'http') return liveToggle(tab);
  const state = rt(tab);
  if (state.loading) return;
  let req = clone(tab.draft);
  let env = activeEnv();
  const col = tabCol(tab);
  const prevScripts = state.scripts;
  state.loading = true; state.compare = null;
  if (resTab === 'compare') resTab = 'body';
  renderResponse();
  const run = { pre: null, post: null };
  const info = { requestName: req.name, requestId: tab.ref?.reqId || null };
  const toastVars = [];
  let local = {};
  const done = (res) => {
    state.loading = false;
    state.scripts = run.pre || run.post ? run : null;
    if (res) state.response = res;
    if (activeTab() === tab) renderResponse();
  };

  // 1. Antes da requisição
  const preChain = scriptChain(tab, req, 'pre');
  if (preChain.length) {
    const out = await runScripts({ event: 'prerequest', scripts: preChain, request: req, vars: scopeVars(env, col), info });
    run.pre = out;
    const applied = applyScriptChanges(out.changes, env, col);
    env = applied.env; toastVars.push(...applied.envChanged);
    local = out.local || {};
    if (out.request && !out.error) req = { ...req, ...out.request };
    if (out.error || out.skipRequest) {
      if (out.error) resTab = 'body';
      return done({ ok: false, scriptBlocked: true, error: out.error ? scriptErrorText('Antes da requisição', out.error) : 'Requisição não enviada: o script chamou pm.execution.skipRequest().', time: null });
    }
  }

  // 2. Envio
  if (!(await confirmProduction([env], req))) { state.loading = false; state.scripts = prevScripts; renderResponse(); return; }
  const vars = mergedVars(env, col, local);
  await prepareAuth(tab, req, vars);
  const res = await api.send(req, vars);

  // 3. Após a resposta
  const postChain = res.ok ? scriptChain(tab, req, 'tests') : [];
  if (postChain.length) {
    const out = await runScripts({ event: 'test', scripts: postChain, request: req, response: res, vars: scopeVars(env, col), local, info });
    run.post = out;
    const applied = applyScriptChanges(out.changes, env, col);
    env = applied.env; toastVars.push(...applied.envChanged);
  }
  if (toastVars.length) toast(`${[...new Set(toastVars)].map((k) => `{{${k}}}`).join(', ')} salvo em "${env.name}"`, 2600);
  await afterResponse(tab, req, res, env);
  if (run.post?.visualizer && resTab === 'body') resTab = 'visualize';
  if (state.changes?.list.length && resTab === 'body') resTab = 'changes';
  addHistory(req, res, env);
  persist();
  if (side === 'history') renderSidebar();
  done(res);
}

// ---------- WebSocket e SSE ----------
// O método "WS" ou "SSE" transforma a aba numa conexão contínua: Conectar/Desconectar e um registro de mensagens.
const kindOf = (r) => (r && r.method === 'WS' ? 'ws' : r && r.method === 'SSE' ? 'sse' : 'http');
const LIVE_MAX = 2000, LIVE_SHOW = 500;
const liveOf = (tab) => (rt(tab).live ||= { state: 'off', log: [], since: null, filter: '', open: new Set() });
let liveFrame = 0;
function liveInit() {
  if (!api.realtime) return;
  api.realtime.onEvent((e) => {
    const tab = session().tabs.find((t) => t.id === e.id);
    if (!tab) return;
    const L = liveOf(tab);
    if (e.type === 'connecting') { L.state = 'connecting'; L.since = null; }
    else if (e.type === 'open') { L.state = 'open'; L.since = e.at; }
    else if (e.type === 'close') L.state = 'off';
    L.log.push(e);
    if (L.log.length > LIVE_MAX) L.log.splice(0, L.log.length - LIVE_MAX);
    $(`.tab[data-id="${tab.id}"]`)?.classList.toggle('live-on', L.state === 'open');
    if (activeTab() === tab && !liveFrame) liveFrame = requestAnimationFrame(() => { liveFrame = 0; if (kindOf(activeTab().draft) !== 'http') renderResponse(); });
  });
}
function liveCloseTab(tab) {
  const L = rt(tab).live;
  if (L && L.state !== 'off' && api.realtime) api.realtime.close({ id: tab.id }).catch(() => {});
}
async function liveToggle(tab) {
  if (!api.realtime) return toast('WebSocket e SSE só funcionam no app instalado.', 3000);
  const L = liveOf(tab);
  if (L.state !== 'off') { await api.realtime.close({ id: tab.id }).catch(() => {}); return; }
  const req = clone(tab.draft);
  const kind = kindOf(req);
  const env = activeEnv(), col = tabCol(tab);
  const vars = mergedVars(env, col);
  await prepareAuth(tab, req, vars);
  req.method = 'GET';
  req.body = { type: 'none' };
  L.log = []; L.open = new Set(); L.state = 'connecting';
  renderResponse();
  try { await api.realtime.connect({ id: tab.id, kind, req, vars }); }
  catch (e) { L.state = 'off'; L.log.push({ id: tab.id, type: 'error', at: Date.now(), error: e.message }); renderResponse(); }
}
async function liveSend(tab) {
  const L = liveOf(tab);
  if (L.state !== 'open') return toast('Conecte antes de enviar.', 2000);
  const m = tab.draft.message || {};
  const text = fill(m.text || '', envVars());
  if (!text) return toast('Escreva a mensagem.', 1800);
  try { await api.realtime.send({ id: tab.id, data: text }); } catch (e) { toast(e.message, 3000); }
}
function renderMessageEditor(ed, tab) {
  const r = tab.draft;
  r.message ||= { text: '', format: 'json' };
  const m = r.message;
  const L = liveOf(tab);
  const fmtSel = h('select', {}, h('option', { value: 'json' }, 'JSON'), h('option', { value: 'text' }, 'Texto'));
  fmtSel.value = m.format || 'json';
  fmtSel.addEventListener('change', () => { m.format = fmtSel.value; markDirty(); renderReqEditor(); });
  const sendBtn = h('button', { class: 'btn-primary sm', disabled: L.state !== 'open', title: 'Ctrl + Enter', onclick: () => liveSend(tab) }, 'Enviar mensagem');
  const bar = h('div', { class: 'body-bar' }, h('span', { class: 'body-bar-label' }, 'Mensagem'), fmtSel, h('div', { class: 'grow' }),
    m.format === 'json' ? h('button', { class: 'btn-ghost sm', onclick: () => { try { m.text = JSON.stringify(JSON.parse(m.text), null, 2); markDirty(); renderReqEditor(); } catch (e) { toast('JSON inválido: ' + e.message, 2400); } } }, 'Formatar JSON') : null,
    sendBtn);
  queueMicrotask(() => customSelect(fmtSel, { variant: 'compact' }));
  const editor = window.MonoScripts.codeEditor({ value: m.text || '', placeholder: m.format === 'json' ? '{\n  "tipo": "assinar",\n  "canal": "{{canal}}"\n}' : 'Mensagem', label: 'Mensagem', highlight: m.format === 'json' ? highlightJson : (v) => esc(v), complete: false, onChange: (v) => { m.text = v; markDirty(); } });
  const box = h('div', { class: 'body-code' }, editor);
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); liveSend(tab); } });
  // mensagens salvas na requisição
  r.messages ||= [];
  const saved = h('div', { class: 'msg-saved' },
    h('div', { class: 'msg-saved-head' }, h('span', { class: 'section-label' }, 'Mensagens salvas'),
      h('button', { class: 'btn-text sm', onclick: async () => {
        if (!m.text) return toast('Escreva a mensagem primeiro.', 1800);
        const o = await promptModal({ title: 'Salvar mensagem', label: 'Nome', value: '', ok: 'Salvar' });
        if (o) { r.messages.push({ id: uid('msg'), name: o.value, text: m.text, format: m.format }); markDirty(); renderReqEditor(); }
      } }, '+ Salvar esta')),
    r.messages.length ? r.messages.map((x) => h('div', { class: 'msg-saved-row' },
      h('button', { class: 'linklike', title: 'Carregar no editor', onclick: () => { m.text = x.text; m.format = x.format || m.format; markDirty(); renderReqEditor(); } }, x.name),
      h('div', { class: 'grow' }),
      h('button', { class: 'btn-text sm', disabled: L.state !== 'open', onclick: async () => { try { await api.realtime.send({ id: tab.id, data: fill(x.text, envVars()) }); } catch (e) { toast(e.message, 3000); } } }, 'Enviar'),
      h('button', { class: 'del', title: 'Remover', html: icons.x, onclick: () => { r.messages.splice(r.messages.indexOf(x), 1); markDirty(); renderReqEditor(); } })))
      : h('p', { class: 'hint' }, 'Guarde mensagens que você manda sempre (assinar canal, ping, autenticar) para enviar com um clique.'));
  ed.append(bar, box, saved);
}
const hhmmss = (t) => { const d = new Date(t); return d.toLocaleTimeString('pt-BR', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0'); };
function renderLive(pane, tab) {
  const L = liveOf(tab);
  const kind = kindOf(tab.draft);
  const sendBtn = $('#sendBtn');
  sendBtn.disabled = false;
  sendBtn.textContent = L.state === 'open' ? 'Desconectar' : L.state === 'connecting' ? 'Cancelar' : 'Conectar';
  sendBtn.classList.toggle('danger', L.state !== 'off');
  const msgs = L.log.filter((e) => e.type === 'message');
  const out = msgs.filter((e) => e.dir === 'out').length, inn = msgs.length - out;
  const elapsed = L.since ? Math.round((Date.now() - L.since) / 1000) : 0;
  const stTxt = { open: `Conectado${elapsed ? ' · ' + (elapsed < 60 ? elapsed + ' s' : Math.floor(elapsed / 60) + ' min') : ''}`, connecting: 'Conectando…', off: L.log.length ? 'Desconectado' : 'Pronto para conectar' }[L.state];
  const filter = h('input', { class: 'live-filter', placeholder: 'Filtrar mensagens', value: L.filter, spellcheck: 'false' });
  filter.addEventListener('input', () => { L.filter = filter.value; drawList(); });
  const list = h('div', { class: 'live-list' });
  const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  function rowFor(e, i) {
    if (e.type === 'message') {
      const json = (() => { try { return e.binary ? null : JSON.parse(e.data); } catch { return null; } })();
      const key = e.at + ':' + i;
      const open = L.open.has(key);
      const preview = e.binary ? `binário · ${fmtBytes(e.size)}` : String(e.data).replace(/\s+/g, ' ').slice(0, 300);
      const row = h('div', { class: 'live-row msg ' + e.dir + (open ? ' open' : '') },
        h('span', { class: 'live-dir', title: e.dir === 'out' ? 'Enviada' : 'Recebida' }, e.dir === 'out' ? '↑' : '↓'),
        h('span', { class: 'live-time' }, hhmmss(e.at)),
        kind === 'sse' && e.event ? h('span', { class: 'live-ev' }, e.event) : null,
        h('span', { class: 'live-prev' + (json ? ' json' : '') }, preview),
        h('span', { class: 'live-size' }, fmtBytes(e.size || 0)));
      row.addEventListener('click', (ev) => { if (ev.target.closest('.live-detail')) return; if (open) L.open.delete(key); else L.open.add(key); drawList(true); });
      if (open) {
        const full = e.binary ? `(binário, ${fmtBytes(e.size)}) base64: ${e.data}` : json ? JSON.stringify(json, null, 2) : String(e.data);
        row.append(h('div', { class: 'live-detail' },
          h('div', { class: 'live-detail-tools' }, e.eventId ? h('span', { class: 'muted small' }, 'id: ' + e.eventId) : null, h('div', { class: 'grow' }), copyButton(full, 'Copiar')),
          json ? h('pre', { class: 'code', html: highlightJson(full) }) : h('pre', { class: 'code' }, full)));
      }
      return row;
    }
    const sys = {
      connecting: () => `Conectando em ${e.url}`,
      open: () => kind === 'ws' ? `Conectado (${e.status} Switching Protocols${e.protocol ? ' · ' + e.protocol : ''})` : `Conectado (HTTP ${e.status})`,
      close: () => `Desconectado${e.code && e.code !== 1000 && e.code !== 1005 ? ' · código ' + e.code : ''}${e.reason ? ' · ' + e.reason : ''}`,
      error: () => e.error, note: () => e.text,
    }[e.type];
    return h('div', { class: 'live-row sys ' + e.type }, h('span', { class: 'live-dir' }, e.type === 'error' ? '!' : '•'), h('span', { class: 'live-time' }, hhmmss(e.at)), h('span', { class: 'live-prev' }, sys ? sys() : e.type));
  }
  function drawList(keepScroll) {
    const stick = !keepScroll && (list.childElementCount === 0 || atBottom());
    const q = L.filter.trim().toLowerCase();
    const rows = L.log.map((e, i) => [e, i]).filter(([e]) => !q || (e.type === 'message' && (String(e.data).toLowerCase().includes(q) || String(e.event || '').toLowerCase().includes(q))));
    const st = list.scrollTop;
    list.innerHTML = '';
    if (rows.length > LIVE_SHOW) list.append(h('div', { class: 'live-more muted small' }, `Mostrando as últimas ${LIVE_SHOW} de ${rows.length}`));
    for (const [e, i] of rows.slice(-LIVE_SHOW)) list.append(rowFor(e, i));
    if (!rows.length) list.append(h('div', { class: 'placeholder small-ph' }, L.log.length ? 'Nenhuma mensagem com esse filtro.' : kind === 'ws' ? 'Conecte para trocar mensagens. Escreva na aba Mensagem e envie com Ctrl + Enter.' : 'Conecte para receber os eventos do servidor.'));
    if (stick) list.scrollTop = list.scrollHeight; else list.scrollTop = st;
  }
  pane.append(
    h('div', { class: 'res-head live-head' },
      h('div', { class: 'metrics' },
        h('span', { class: 'live-state ' + L.state }, h('span', { class: 'dot' }), stTxt),
        h('span', {}, kind === 'ws' ? 'WebSocket' : 'Server-Sent Events'),
        msgs.length ? h('span', {}, kind === 'ws' ? `↑ ${out} · ↓ ${inn}` : `${inn} eventos`) : null),
      h('div', { class: 'res-tools' }, filter, L.log.length ? h('button', { class: 'btn-ghost sm', onclick: () => { L.log = []; L.open = new Set(); renderResponse(); } }, 'Limpar') : null)),
    list);
  drawList();
}

// ---------- GraphQL ----------
const gqlSchemas = new Map(); // URL resolvida → schema (só nesta sessão do app)
const gqlKey = (tab) => fill(tab.draft.url || '', envVars()).split('?')[0];
async function fetchGqlSchema(tab, onDone) {
  const req = clone(tab.draft);
  req.method = 'POST';
  req.body = { type: 'graphql', graphql: { query: window.MonoGraphQL.INTROSPECTION, variables: '' } };
  const env = activeEnv(), col = tabCol(tab);
  const vars = mergedVars(env, col);
  await prepareAuth(tab, req, vars);
  const res = await api.send(req, vars);
  if (!res.ok) return toast('Não consegui buscar o schema: ' + res.error, 4000);
  let json;
  try { json = JSON.parse(res.body); } catch { return toast(`A API respondeu ${res.status}, mas não em JSON.`, 3600); }
  if (json.errors && !json.data) return toast('A API recusou a introspecção: ' + (json.errors[0]?.message || 'erro'), 4200);
  try {
    const schema = window.MonoGraphQL.fromIntrospection(json);
    gqlSchemas.set(gqlKey(tab), schema);
    toast(`Schema carregado: ${schema.count} tipos`, 2200);
    onDone?.();
  } catch (e) { toast(e.message, 4000); }
}
function renderGraphqlBody(ed, bar, b, changed) {
  b.graphql ||= { query: '', variables: '' };
  const g = b.graphql;
  const tab = activeTab();
  const G = window.MonoGraphQL;
  const sch = gqlSchemas.get(gqlKey(tab));
  const ops = G.operations(g.query || '');
  let opSel = null;
  if (ops.length > 1) {
    opSel = h('select', { title: 'Operação a executar (operationName)' }, ops.map((o) => h('option', { value: o.name }, `${o.type} ${o.name}`)));
    opSel.value = g.operationName && ops.some((o) => o.name === g.operationName) ? g.operationName : ops[0].name;
    g.operationName = opSel.value;
    opSel.addEventListener('change', () => { g.operationName = opSel.value; changed(); });
    queueMicrotask(() => customSelect(opSel, { variant: 'compact' }));
  } else if (g.operationName) { g.operationName = ''; }
  bar.append(opSel, h('div', { class: 'grow' }),
    h('span', { class: 'muted small', title: sch ? 'Autocompletar ativo (Ctrl + Espaço)' : '' }, sch ? `Schema · ${sch.count} tipos` : 'Sem schema'),
    h('button', { class: 'btn-ghost sm', title: 'Busca o schema por introspecção, com a mesma URL, headers e autenticação', onclick: () => fetchGqlSchema(tab, () => renderReqEditor()) }, sch ? 'Atualizar schema' : 'Buscar schema'));
  const qEd = window.MonoScripts.codeEditor({ value: g.query || '', placeholder: 'query {\n  campo {\n    subcampo\n  }\n}', label: 'Query GraphQL', highlight: G.highlight,
    complete: (before, force) => G.completions(gqlSchemas.get(gqlKey(tab)), before, force),
    onChange: (v) => { const had = G.operations(g.query || '').length > 1; g.query = v; changed(); if (had !== (G.operations(v).length > 1)) renderReqEditor(); } });
  const vEd = window.MonoScripts.codeEditor({ value: g.variables || '', placeholder: '{\n  "id": "{{id}}"\n}', label: 'Variáveis', highlight: highlightJson, complete: false, onChange: (v) => { g.variables = v; changed(); } });
  ed.append(h('div', { class: 'gql-split' },
    h('div', { class: 'gql-pane' }, h('div', { class: 'gql-label' }, 'Query'), h('div', { class: 'body-code' }, qEd)),
    h('div', { class: 'gql-pane vars' }, h('div', { class: 'gql-label' }, 'Variáveis (JSON)'), h('div', { class: 'body-code' }, vEd))));
}

// ---------- Monitores ----------
// Um monitor roda uma coleção (ou pasta) de tempos em tempos, no Mono deste computador — assim usa o certificado A1
// e os segredos locais, que nunca saem daqui. Em workspace compartilhado, o resultado vai para o servidor e o time vê.
const MON_EVERY = [[5, 'A cada 5 minutos'], [15, 'A cada 15 minutos'], [30, 'A cada 30 minutos'], [60, 'A cada hora'], [360, 'A cada 6 horas'], [1440, 'Uma vez por dia']];
const monRunning = new Set();
const monRemote = new Map(); // sharedId → [run] (resultados vindos do servidor)
let monModal = null;         // redesenha a tela de monitores quando chega resultado
const monLocal = () => (settings().monitorRuns ||= {});    // monitorId → [run] (últimos, deste computador)
const monRunners = () => (settings().monitorRunners ||= {}); // monitorId → true/false (rodar neste computador)
function runsHere(w, m) {
  const v = monRunners()[m.id];
  if (v !== undefined) return v;
  return !w.shared || !m.createdBy || m.createdBy === me()?.username; // padrão: quem criou
}
function lastRun(w, m) {
  const local = (monLocal()[m.id] || [])[0];
  const remote = w.shared ? (monRemote.get(w.shared.id) || []).find((r) => r.monitorId === m.id) : null;
  if (!local) return remote || null;
  if (!remote) return local;
  return new Date(remote.at) > new Date(local.at) ? remote : local;
}
async function runMonitor(w, m, { manual = false } = {}) {
  if (monRunning.has(m.id)) return null;
  const wd = wsData(w);
  const col = (wd.collections || []).find((c) => c.id === m.colId);
  const started = Date.now();
  let run;
  monRunning.add(m.id); monModal?.();
  try {
    if (!col) throw new Error('A coleção deste monitor não existe mais.');
    const env = (wd.environments || []).find((e) => e.id === m.envId) || null;
    const ctxVars = { env: clone(env?.vars || []), col: clone(col.variables || []), glob: clone((wd.globals || {}).vars || []) };
    const list = requestsInOrder(col, m.folderId || null).filter((r) => kindOf(r) === 'http');
    if (!list.length) throw new Error('Não há requisições HTTP para rodar.');
    extraCols.add(wd.collections);
    const recs = [];
    try {
      for (const r of list) {
        const req = clone(r);
        if (!req.auth || req.auth.type === 'inherit') req.auth = clone(inheritedAuth(col, r.folderId).auth);
        const { rec } = await runnerExec(col, req, { w: ctxVars, row: {}, i: 0, n: 1 });
        recs.push(rec);
      }
    } finally { extraCols.delete(wd.collections); }
    const failed = recs.filter(recFailed);
    run = { monitorId: m.id, name: m.name, ok: !failed.length, total: recs.length, failed: failed.length, durationMs: Date.now() - started,
      failures: failed.slice(0, 20).map((x) => {
        const t = (x.tests || []).find((y) => !y.pass && !y.skipped);
        return { name: x.name, error: x.error || (t ? `${t.name}${t.error ? ': ' + t.error : ''}` : 'falhou') + (x.status ? ` (HTTP ${x.status})` : '') };
      }) };
  } catch (e) {
    run = { monitorId: m.id, name: m.name, ok: false, total: 0, failed: 1, durationMs: Date.now() - started, failures: [{ name: m.name, error: e.message }] };
  } finally { monRunning.delete(m.id); }
  run.at = new Date().toISOString();
  run.by = me() ? { username: me().username } : { username: 'você' };
  run.manual = manual;
  const prev = lastRun(w, m);
  const list = monLocal()[m.id] || [];
  list.unshift(run); monLocal()[m.id] = list.slice(0, 30);
  persist();
  if (w.shared && loggedIn()) cloudCall('POST', `/v1/workspaces/${w.shared.id}/monitor-runs`, run).then((r) => { if (r.ok) addRemoteRun(w, r.data.run); });
  monitorNotify(w, m, run, prev);
  monModal?.(); renderMonAlert();
  return run;
}
function addRemoteRun(w, run) {
  const list = monRemote.get(w.shared.id) || [];
  if (!list.some((r) => r.id === run.id)) list.unshift(run);
  monRemote.set(w.shared.id, list.slice(0, 300));
}
function onMonitorRun(w, run) {
  const m = (wsData(w).monitors || []).find((x) => x.id === run.monitorId);
  const prev = m ? lastRun(w, m) : null;
  addRemoteRun(w, run);
  if (m && run.by && run.by.username !== me()?.username) monitorNotify(w, m, run, prev, run.by.username);
  monModal?.(); renderMonAlert();
}
// Avisa quando o monitor muda de estado (ok → falha ou falha → ok), com notificação do Windows.
function monitorNotify(w, m, run, prev, who = null) {
  if (m.notify === false) return;
  const changed = !prev || prev.ok !== run.ok;
  if (!changed && !run.manual) return;
  const title = run.ok ? `✓ ${m.name} voltou a funcionar` : `✗ ${m.name} falhou`;
  const text = run.ok ? `${run.total} requisição(ões) OK${who ? ' · rodado por @' + who : ''}` : `${run.failures[0]?.name || ''}: ${run.failures[0]?.error || ''}${who ? ' · rodado por @' + who : ''}`;
  toast(`${title} — ${text}`, run.ok ? 3500 : 7000);
  if (!run.manual && typeof Notification !== 'undefined' && (Notification.permission === 'granted' || Notification.permission === 'default')) {
    try { const n = new Notification(`Mono · ${title}`, { body: `${w.name}: ${text}`, silent: run.ok }); n.onclick = () => { window.focus(); if (w.id !== data.activeWorkspaceId) switchWorkspace(w.id); openMonitors(); }; } catch { /* sem notificação */ }
  }
}
function monitorTick() {
  if (!data) return;
  for (const w of data.workspaces) {
    for (const m of wsData(w).monitors || []) {
      if (m.enabled === false || !runsHere(w, m) || monRunning.has(m.id)) continue;
      const last = (monLocal()[m.id] || [])[0];
      const every = (Number(m.every) || 15) * 60000;
      if (!last || Date.now() - new Date(last.at).getTime() >= every) runMonitor(w, m);
    }
  }
}
function renderMonAlert() {
  const el = $('#monAlert');
  if (!el || !data) return;
  const w = activeWorkspace();
  const failing = (wsData(w).monitors || []).filter((m) => m.enabled !== false && lastRun(w, m) && !lastRun(w, m).ok);
  el.classList.toggle('hidden', !failing.length);
  el.textContent = failing.length === 1 ? `${failing[0].name} falhando` : `${failing.length} monitores falhando`;
  el.title = failing.map((m) => `${m.name}: ${lastRun(w, m).failures[0]?.error || ''}`).join('\n');
}
async function loadMonitorRuns(w) {
  if (!w.shared || !loggedIn()) return;
  const r = await cloudCall('GET', `/v1/workspaces/${w.shared.id}/monitor-runs`);
  if (r.ok) { monRemote.set(w.shared.id, r.data.runs); monModal?.(); renderMonAlert(); }
}
function openMonitorForm(w, m = null, preset = {}) {
  const wd = wsData(w);
  if (!(wd.collections || []).length) return toast('Crie ou importe uma coleção primeiro.', 2600);
  openModal((body, close) => {
    const cur = m ? clone(m) : { id: uid('mon'), name: preset.name || '', colId: preset.colId || wd.collections[0].id, folderId: preset.folderId || null, envId: wd.activeEnvId || '', every: 15, enabled: true, notify: true, createdBy: me()?.username || '' };
    const name = h('input', { value: cur.name, placeholder: 'Ex.: SEFAZ SP — status do serviço', maxlength: 80 });
    const target = h('select', {});
    for (const c of wd.collections) {
      target.append(h('option', { value: c.id + '|' }, c.name));
      for (const f of foldersOf(c)) target.append(h('option', { value: c.id + '|' + f.id }, `${c.name} / ${folderPath(c, f.id).map((x) => x.name).join(' / ')}`));
    }
    target.value = cur.colId + '|' + (cur.folderId || '');
    const envSel = h('select', {}, h('option', { value: '' }, 'Sem ambiente'), (wd.environments || []).map((e) => h('option', { value: e.id }, e.name + (e.prod ? ' · PRODUÇÃO' : ''))));
    envSel.value = cur.envId || '';
    const every = h('select', {}, MON_EVERY.map(([v, l]) => h('option', { value: String(v) }, l)));
    every.value = String(cur.every);
    const notify = h('input', { type: 'checkbox', checked: cur.notify !== false });
    const err = h('p', { class: 'ws-err hidden' });
    queueMicrotask(() => { customSelect(target); customSelect(envSel); customSelect(every); });
    const save = async () => {
      cur.name = name.value.trim();
      if (!cur.name) { err.textContent = 'Dê um nome ao monitor.'; err.classList.remove('hidden'); return; }
      const [colId, folderId] = target.value.split('|');
      Object.assign(cur, { colId, folderId: folderId || null, envId: envSel.value, every: Number(every.value), notify: notify.checked });
      const col = wd.collections.find((c) => c.id === colId);
      const env = (wd.environments || []).find((e) => e.id === cur.envId);
      const mut = requestsInOrder(col, cur.folderId).filter((r) => isMutating(r.method) && kindOf(r) === 'http');
      if (env && env.prod && mut.length && !(await confirmModal({ title: 'Monitorar em produção?', sub: `${plural(mut.length, 'requisição altera', 'requisições alteram')} dados (${mut.slice(0, 3).map((r) => r.method + ' ' + r.name).join(', ')}) e ${plural(mut.length, 'vai', 'vão')} rodar em “${env.name}” ${MON_EVERY.find(([v]) => v === cur.every)[1].toLowerCase()}.`, ok: 'Monitorar mesmo assim' }))) return openMonitorForm(w, m, preset);
      wd.monitors ||= [];
      const i = wd.monitors.findIndex((x) => x.id === cur.id);
      if (i >= 0) wd.monitors[i] = cur; else { wd.monitors.push(cur); monRunners()[cur.id] = true; }
      persist();
      close();
      openMonitors(w);
      if (i < 0) runMonitor(w, cur, { manual: true });
    };
    body.append(h('h2', {}, m ? 'Editar monitor' : 'Novo monitor'),
      h('p', { class: 'sub' }, 'Roda as requisições no Mono deste computador — com o seu certificado e os seus segredos — e avisa quando algo quebra. Em workspace compartilhado, o time vê os resultados.'),
      h('div', { class: 'field' }, h('label', {}, 'Nome'), name),
      h('div', { class: 'field' }, h('label', {}, 'O que rodar'), target),
      h('div', { class: 'row-gap' }, h('div', { class: 'field grow' }, h('label', {}, 'Ambiente'), envSel), h('div', { class: 'field grow' }, h('label', {}, 'Frequência'), every)),
      h('label', { class: 'check-row' }, notify, h('span', {}, h('b', {}, 'Avisar quando falhar ou voltar'), ' — notificação do Windows')),
      h('p', { class: 'hint' }, 'Falha = erro de rede, erro em script ou teste (pm.test) que não passou. Sem testes, só erros de conexão contam — adicione pm.test na aba Scripts para checar o conteúdo.'),
      err,
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn-ghost', onclick: () => { close(); openMonitors(w); } }, 'Cancelar'), h('button', { class: 'btn-primary', onclick: save }, m ? 'Salvar' : 'Criar e rodar agora')));
    setTimeout(() => name.focus(), 0);
  });
}
function openMonitors(w = activeWorkspace()) {
  if (w.shared) loadMonitorRuns(w);
  openModal((body, close) => {
    body.classList.add('wide');
    const list = h('div', { class: 'mon-list' });
    const open = new Set();
    const draw = () => {
      list.innerHTML = '';
      const wd = wsData(w);
      const mons = wd.monitors || [];
      if (!mons.length) list.append(h('div', { class: 'ex-empty' }, h('b', {}, 'Nenhum monitor'), 'Crie um para rodar uma coleção de tempos em tempos — por exemplo, o status da SEFAZ a cada 15 minutos — e ser avisado quando falhar.'));
      for (const m of mons) {
        const col = (wd.collections || []).find((c) => c.id === m.colId);
        const env = (wd.environments || []).find((e) => e.id === m.envId);
        const last = lastRun(w, m);
        const here = runsHere(w, m);
        const running = monRunning.has(m.id);
        const runs = [...(monLocal()[m.id] || []), ...(w.shared ? (monRemote.get(w.shared.id) || []).filter((r) => r.monitorId === m.id && r.by?.username !== me()?.username) : [])]
          .sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 20);
        const status = running ? h('span', { class: 'mon-badge run' }, 'Rodando…')
          : !last ? h('span', { class: 'mon-badge' }, 'Ainda não rodou')
          : h('span', { class: 'mon-badge ' + (last.ok ? 'ok' : 'fail'), title: last.ok ? '' : last.failures.map((f) => `${f.name}: ${f.error}`).join('\n') }, last.ok ? `✓ ${last.total}/${last.total}` : `✗ ${last.failed} falha${last.failed > 1 ? 's' : ''}`);
        const hereBox = h('input', { type: 'checkbox', checked: here, onchange: (e) => { monRunners()[m.id] = e.target.checked; persist(); draw(); } });
        const enabled = m.enabled !== false;
        const row = h('div', { class: 'mon-row' + (enabled ? '' : ' off') },
          h('div', { class: 'mon-main', onclick: () => { if (open.has(m.id)) open.delete(m.id); else open.add(m.id); draw(); } },
            status,
            h('div', { class: 'mon-info' },
              h('div', { class: 'mon-name' }, m.name, enabled ? null : h('span', { class: 'tag' }, 'pausado')),
              h('div', { class: 'muted small' }, `${col ? col.name + (m.folderId ? ' / ' + (folderById(col, m.folderId)?.name || '?') : '') : 'coleção removida'} · ${env ? env.name : 'sem ambiente'} · ${(MON_EVERY.find(([v]) => v === Number(m.every)) || [, m.every + ' min'])[1].toLowerCase()}`),
              last ? h('div', { class: 'muted small' }, `Última: ${ago(last.at)}${last.by && w.shared ? ' · por @' + last.by.username : ''}${last.ok ? '' : ' — ' + (last.failures[0]?.name || '') + ': ' + (last.failures[0]?.error || '')}`) : null)),
          h('label', { class: 'mon-here', title: 'Este computador roda o monitor no horário (o Mono precisa estar aberto)' }, hereBox, 'Rodar aqui'),
          h('button', { class: 'btn-ghost sm', disabled: running, onclick: () => runMonitor(w, m, { manual: true }) }, 'Rodar agora'),
          h('button', { class: 'btn-ghost sm', title: 'Opções', onclick: (e) => showMenu(e.currentTarget, [
            { label: 'Editar…', run: () => openMonitorForm(w, m) },
            { label: enabled ? 'Pausar' : 'Retomar', run: () => { m.enabled = !enabled; persist(); draw(); renderMonAlert(); } },
            '-',
            { label: 'Excluir', run: async () => { if (await confirmModal({ title: `Excluir “${m.name}”?`, sub: 'O monitor para de rodar em todos os computadores.' })) { wd.monitors.splice(wd.monitors.indexOf(m), 1); persist(); } openMonitors(w); } },
          ]) }, '⋯'));
        if (open.has(m.id)) {
          row.append(h('div', { class: 'mon-runs' }, runs.length ? runs.map((r) => h('div', { class: 'mon-run ' + (r.ok ? 'ok' : 'fail') },
            h('span', { class: 'mon-dot' }), h('span', {}, new Date(r.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })),
            h('span', { class: 'muted small' }, `${r.total - r.failed}/${r.total} ok · ${fmtTime(r.durationMs)}${r.by && w.shared ? ' · @' + r.by.username : ''}${r.manual ? ' · manual' : ''}`),
            r.ok ? null : h('span', { class: 'mon-err' }, r.failures.map((f) => `${f.name}: ${f.error}`).join(' · ')))) : h('p', { class: 'hint' }, 'Nenhuma execução ainda.')));
        }
        list.append(row);
      }
    };
    monModal = () => { if (!$('#modal').classList.contains('hidden') && body.contains(list)) draw(); else monModal = null; };
    draw();
    body.append(h('div', { class: 'ws-head' },
      h('div', {}, h('h2', {}, 'Monitores'), h('p', { class: 'sub' }, `Rodam no Mono aberto${w.shared ? '; o time vê os resultados e é avisado quando algo cai' : ''}. Marque “Rodar aqui” no computador que deve executar.`)),
      canEditWs(w) ? h('button', { class: 'btn-primary', onclick: () => openMonitorForm(w) }, '+ Novo monitor') : null),
      list,
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn-ghost', onclick: () => { monModal = null; close(); } }, 'Fechar')));
  });
}

// ---------- Comparar ambientes ----------
function openCompareMenu(anchor) {
  const cur = activeEnv();
  const others = data.environments.filter((e) => e !== cur);
  if (!cur || !others.length) return toast(cur ? 'Crie outro ambiente para comparar' : 'Ative um ambiente para comparar', 2400);
  showMenu(anchor, others.map((e) => ({ label: `${cur.name}  ⇄  ${e.name}${e.prod ? '  · PROD' : ''}`, run: () => runCompare(e) })));
}
async function runCompare(otherEnv) {
  const tab = activeTab();
  const state = rt(tab);
  if (state.loading) return;
  const req = clone(tab.draft);
  const envA = activeEnv(), envB = otherEnv;
  if (!(await confirmProduction([envA, envB], req))) return;
  if (isMutating(req.method) && !envA.prod && !envB.prod &&
      !(await confirmModal({ title: `Enviar ${req.method} para os dois ambientes?`, sub: `Comparar executa a requisição em "${envA.name}" e em "${envB.name}". Como é um ${req.method}, ela pode alterar dados nos dois.`, ok: 'Enviar e comparar' }))) return;
  state.loading = true; state.compare = null;
  renderResponse();
  const col = tabCol(tab);
  await prepareAuth(tab, req, mergedVars(envA, col));
  const [a, b] = await Promise.all([api.send(req, mergedVars(envA, col)), api.send(req, mergedVars(envB, col))]);
  state.scripts = null;
  await afterResponse(tab, req, a, envA);
  state.loading = false; state.response = a;
  state.compare = { a: { env: envA.name, res: a }, b: { env: envB.name, res: b }, ...diffResponses(a, b) };
  resTab = 'compare';
  addHistory(req, a, envA); addHistory(req, b, envB);
  persist();
  if (side === 'history') renderSidebar();
  if (activeTab() === tab) renderResponse();
}
function diffResponses(a, b) {
  if (!a.ok || !b.ok) return { mode: 'error', diffs: [] };
  const ja = a.body ? Shape.tryJson(a.body) : { ok: false }, jb = b.body ? Shape.tryJson(b.body) : { ok: false };
  if (ja.ok && jb.ok) return { mode: 'json', diffs: Shape.diffJson(ja.value, jb.value) };
  if (a.body != null && b.body != null) return { mode: 'text', diffs: Shape.diffLines(a.body, b.body) };
  return { mode: 'binary', diffs: a.size === b.size && a.bodyBase64 === b.bodyBase64 ? [] : [{ kind: 'changed', path: 'conteúdo binário', a: fmtBytes(a.size), b: fmtBytes(b.size) }] };
}
const DIFF_LABEL = { changed: 'valor', removed: 'só em A', added: 'só em B', type: 'tipo', length: 'tamanho' };
function renderCompare(body, cmp) {
  const ignore = (data.compareIgnore || '').split(',').map((x) => x.trim()).filter(Boolean);
  const lastSeg = (p) => (p.match(/(?:\.|\[")([^."\[\]]+)"?\]?$/) || [, p])[1];
  const visible = cmp.diffs.filter((d) => !ignore.some((ig) => lastSeg(d.path) === ig || d.path.includes('.' + ig + '.') || d.path.includes('.' + ig + '[') || d.path.endsWith('.' + ig)));
  const filter = data.compareFilter || 'all';
  const shown = visible.filter((d) => filter === 'all' || (filter === 'values' ? d.kind === 'changed' : d.kind !== 'changed'));
  const card = (side, x) => {
    const r = x.res;
    return h('div', { class: 'cmp-card' },
      h('div', { class: 'cmp-env' }, h('span', { class: 'cmp-side' }, side), x.env),
      r.ok ? h('div', { class: 'metrics' },
        h('span', { class: `status s${String(r.status)[0]}` }, `${r.status} ${r.statusText || ''}`.trim()),
        h('span', {}, 'Tempo ', h('b', {}, fmtTime(r.time))), h('span', {}, 'Tamanho ', h('b', {}, fmtBytes(r.size))))
        : h('div', { class: 'metrics' }, h('span', { class: 'status err' }, 'ERRO'), h('span', { class: 'cmp-err' }, r.error)));
  };
  const a = cmp.a.res, b = cmp.b.res;
  const notes = [];
  if (a.ok && b.ok) {
    if (a.status !== b.status) notes.push(`Status diferente: ${a.status} × ${b.status}`);
    const ct = (r) => (r.contentType || '').split(';')[0];
    if (ct(a) !== ct(b)) notes.push(`Content-Type diferente: ${ct(a) || '—'} × ${ct(b) || '—'}`);
    const slow = Math.max(a.time, b.time), fast = Math.min(a.time, b.time);
    if (fast > 0 && slow / fast >= 2 && slow - fast > 150) notes.push(`${a.time > b.time ? cmp.a.env : cmp.b.env} foi ${(slow / fast).toFixed(1)}× mais lento`);
  }
  const counts = visible.reduce((m, d) => ((m[d.kind] = (m[d.kind] || 0) + 1), m), {});
  const summary = cmp.mode === 'error' ? 'Um dos ambientes falhou — veja o erro acima.'
    : !visible.length ? (cmp.diffs.length ? 'Iguais (ignorando os campos filtrados).' : 'Corpos idênticos.')
    : `${visible.length}${visible.length >= 500 ? '+' : ''} diferença(s): ` + Object.entries(counts).map(([k, n]) => `${n} ${DIFF_LABEL[k]}`).join(' · ');
  const ignoreInput = h('input', { class: 'input cmp-ignore', placeholder: 'Ignorar campos: requestId, timestamp…', value: data.compareIgnore || '', spellcheck: 'false' });
  ignoreInput.addEventListener('change', () => { data.compareIgnore = ignoreInput.value; persist(); renderResponse(); });
  const chip = (k, label) => h('button', { class: 'chip' + (filter === k ? ' active' : ''), onclick: () => { data.compareFilter = k; persist(); renderResponse(); } }, label);
  const wrap = h('div', { class: 'cmp' },
    h('div', { class: 'cmp-cards' }, card('A', cmp.a), card('B', cmp.b)),
    notes.length ? h('div', { class: 'cmp-notes' }, notes.map((n) => h('div', {}, '• ' + n))) : null,
    h('div', { class: 'cmp-bar' }, h('span', { class: 'cmp-summary' + (visible.length ? '' : ' same') }, summary),
      h('div', { class: 'grow' }),
      cmp.mode === 'json' ? h('div', { class: 'radio-row', style: 'margin:0' }, chip('all', 'Tudo'), chip('structure', 'Estrutura'), chip('values', 'Valores')) : null,
      cmp.mode === 'json' ? ignoreInput : null));
  if (shown.length) {
    wrap.append(h('table', { class: 'cmp-table' },
      h('tr', {}, h('th', {}, ''), h('th', {}, 'Caminho'), h('th', {}, `A · ${cmp.a.env}`), h('th', {}, `B · ${cmp.b.env}`)),
      shown.map((d) => h('tr', { class: 'k-' + d.kind },
        h('td', {}, h('span', { class: 'kbadge k-' + d.kind }, DIFF_LABEL[d.kind])),
        h('td', { class: 'mono-cell' }, d.path),
        h('td', { class: 'mono-cell' }, d.a ?? '—'),
        h('td', { class: 'mono-cell' }, d.b ?? '—')))));
  }
  body.append(wrap);
}

// ---------- Mudanças desde a última vez ----------
const CHANGE_LABEL = { added: 'novo', removed: 'removido', type: 'tipo mudou', nullable: 'nulidade' };
function renderChanges(body, ch) {
  const when = new Date(ch.since).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const wrap = h('div', { class: 'cmp' },
    h('div', { class: 'cmp-bar' }, h('span', { class: 'cmp-summary' + (ch.list.length ? '' : ' same') },
      ch.list.length ? `${ch.list.length} mudança(s) na estrutura desde ${when}` : `Mesma estrutura da resposta de ${when}`)),
    h('p', { class: 'hint', style: 'margin:0 0 10px' }, 'Compara a forma do JSON (campos e tipos) com a última resposta deste endpoint, no mesmo ambiente e status. Valores diferentes não contam — só quebras de contrato.'));
  if (ch.list.length) {
    wrap.append(h('table', { class: 'cmp-table' },
      h('tr', {}, h('th', {}, ''), h('th', {}, 'Campo'), h('th', {}, 'Antes'), h('th', {}, 'Agora')),
      ch.list.map((c) => h('tr', {},
        h('td', {}, h('span', { class: 'kbadge k-' + (c.kind === 'added' ? 'added' : c.kind === 'removed' ? 'removed' : 'type') }, CHANGE_LABEL[c.kind])),
        h('td', { class: 'mono-cell' }, c.path), h('td', { class: 'mono-cell' }, c.from ?? '—'), h('td', { class: 'mono-cell' }, c.to ?? '—')))));
  }
  body.append(wrap);
}

// ---------- Contrato OpenAPI ----------
function renderContract(body, ct) {
  const wrap = h('div', { class: 'cmp' },
    h('div', { class: 'cmp-bar' }, h('span', { class: 'cmp-summary' + (ct.status === 'ok' ? ' same' : '') }, ct.message)));
  if (ct.issues.length) {
    wrap.append(h('table', { class: 'cmp-table' },
      h('tr', {}, h('th', {}, ''), h('th', {}, 'Caminho'), h('th', {}, 'Problema')),
      ct.issues.map((i) => h('tr', {},
        h('td', {}, h('span', { class: 'kbadge ' + (i.level === 'erro' ? 'k-removed' : 'k-changed') }, i.level)),
        h('td', { class: 'mono-cell' }, i.path), h('td', {}, i.msg)))));
  }
  body.append(wrap);
}

// ---------- Gerar tipos ----------
function openTypegen(json) {
  const langs = [['cs', 'C# record'], ['ts', 'TypeScript'], ['zod', 'Zod']];
  let lang = data.typegenLang || 'cs';
  openModal((body, close) => {
    const name = h('input', { class: 'input', value: Typegen.pascal(activeTab().draft.name || 'Resposta'), spellcheck: 'false', style: 'flex:1' });
    const seg = h('div', { class: 'radio-row', style: 'margin:0' });
    const out = h('div', { class: 'res-body tg-out' });
    let code = '';
    const draw = () => {
      seg.innerHTML = '';
      for (const [k, label] of langs) seg.append(h('button', { class: 'chip' + (lang === k ? ' active' : ''), onclick: () => { lang = k; data.typegenLang = k; persist(); draw(); } }, label));
      const n = name.value.trim() || 'Resposta';
      code = lang === 'cs' ? Typegen.toCSharp(json, n) : lang === 'ts' ? Typegen.toTypeScript(json, n) : Typegen.toZod(json, n);
      out.innerHTML = ''; out.append(codeView(code, 'code:' + (lang === 'cs' ? 'cs' : 'ts')));
    };
    name.addEventListener('input', draw);
    body.append(h('h2', {}, 'Gerar tipos'), h('p', { class: 'sub' }, 'A partir desta resposta. Campos que faltam em parte dos itens viram opcionais; datas ISO e GUIDs são detectados.'),
      h('div', { class: 'row-actions' }, name, seg), out,
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn-ghost', onclick: close }, 'Fechar'),
        h('button', { class: 'btn-primary', onclick: () => api.copy(code).then(() => toast('Código copiado')) }, 'Copiar código')));
    draw();
  });
  $('#modalBody').classList.add('wide');
}

// ---------- Importar API (documentação, OpenAPI, apiDoc, Postman, arquivo) ----------
const Docs = window.MonoDocs, Overview = window.MonoOverview, Postman = window.MonoPostman;
async function fetchDoc(url) {
  const res = await api.send({ method: 'GET', url, params: null, headers: [{ key: 'Accept', value: 'application/json, application/yaml;q=0.9, text/html;q=0.8, */*;q=0.5', enabled: true }], body: { type: 'none' }, auth: { type: 'none' } }, envVars());
  if (!res.ok) throw new Error(res.error);
  if (res.status >= 400) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return { body: res.body || '', contentType: res.contentType || '', url: res.url || fill(url, envVars()) };
}
async function modelFromText(text, contentType, url, progress) {
  // WSDL (SOAP): busca também os XSD/WSDL importados.
  if (window.MonoWsdl.isWsdl(text)) {
    const extra = [];
    if (url) {
      let refs = window.MonoWsdl.externalRefs(text, url);
      for (let depth = 0; depth < 2 && refs.length; depth++) {
        const next = [];
        for (const r of refs.slice(0, 12)) {
          try { progress?.(`Lendo ${r}`); const d = await fetchDoc(r); extra.push(d.body); next.push(...window.MonoWsdl.externalRefs(d.body, r)); } catch { /* schema externo indisponível */ }
        }
        refs = next.filter((x) => !refs.includes(x));
      }
    }
    return { model: window.MonoWsdl.fromWsdl(text, url, extra) };
  }
  const p = Docs.parseText(text, contentType);
  if (p.kind !== 'json') return { kind: p.kind, value: p.value };
  const fmt = Docs.detectFormat(p.value);
  if (fmt === 'openapi') return { model: Docs.fromOpenApi(p.value, url, !!p.yaml) };
  if (fmt === 'postman') return { model: Postman.fromPostman(Postman.unwrapCollection(p.value), url) };
  if (fmt === 'mono') return { mono: p.value };
  if (fmt === 'apidoc') {
    let project = {};
    if (url) {
      for (const pu of [Docs.apidocProjectUrl(url), Docs.apidocProjectUrl(url).replace(/\.json$/, '.js')]) {
        try { progress?.(`Lendo ${pu}`); const r = await fetchDoc(pu); const pp = Docs.parseText(r.body); if (pp.kind === 'json') { project = pp.value; break; } } catch { /* sem projeto */ }
      }
    }
    return { model: Docs.fromApiDoc(p.value, project, url) };
  }
  return { kind: 'json-unknown', value: p.value };
}
// Links do postman.com: API oficial (com chave), documentação publicada e, sem chave, o mesmo caminho público que o site usa.
async function httpJson(method, url, headers = [], body = null) {
  const r = await api.send({ method, url, params: null, headers: [{ key: 'Accept', value: 'application/json', enabled: true }, ...headers.map((x) => ({ ...x, enabled: true }))],
    body: body ? { type: 'json', raw: JSON.stringify(body) } : { type: 'none' }, auth: { type: 'none' } }, {});
  if (!r.ok) throw new Error(r.error);
  if (r.status >= 400) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
  return JSON.parse(r.body || 'null');
}
async function discoverPostman(info, url, tried, progress) {
  const key = settings().postman.apiKey;
  const keyH = key ? [{ key: 'X-API-Key', value: key }] : [];
  const step = async (u, why, fn) => {
    const entry = { url: u, why, result: '…' }; tried.push(entry);
    progress?.(`Lendo ${u}`, tried);
    try { const v = await fn(); entry.result = v ? '✓' : 'vazio'; return v; }
    catch (e) { entry.result = e.status ? `HTTP ${e.status}` : 'falhou'; return null; }
  };
  const asModel = (j, src) => {
    const col = Postman.unwrapCollection(j);
    return col && col.info && Array.isArray(col.item) ? Postman.fromPostman(col, src) : null;
  };
  const getCollection = async (uid) => {
    if (key) {
      const m = await step(`https://api.getpostman.com/collections/${uid}`, 'API do Postman', async () => asModel(await httpJson('GET', `https://api.getpostman.com/collections/${uid}`, keyH), url));
      if (m) return m;
    }
    const owner = uid.split('-')[0], cid = uid.slice(owner.length + 1);
    const doc = `https://documenter.gw.postman.com/api/collections/${owner}/${cid}?segregateAuth=true&versionTag=latest`;
    const m2 = await step(doc, 'documentação publicada', async () => asModel(await httpJson('GET', doc), url));
    if (m2) return m2;
    return step(`https://www.postman.com/_api/collection/${uid}`, 'página pública', async () => asModel(await httpJson('GET', `https://www.postman.com/_api/collection/${uid}`), url));
  };
  if (info.kind === 'documenter') {
    const m = await step(info.api, 'documentação publicada', async () => asModel(await httpJson('GET', info.api), url));
    return m ? [m] : [];
  }
  if (info.collectionUid) { const m = await getCollection(info.collectionUid); if (m) return [m]; }
  if (info.kind !== 'workspace' || !info.slug) return [];
  // Workspace inteiro: acha o id e lista as coleções.
  const proxy = 'https://www.postman.com/_api/ws/proxy';
  const ws = await step(`${proxy} · workspace ${info.team || ''}/${info.slug}`, 'workspace público', async () => {
    const j = await httpJson('POST', proxy, [], { service: 'workspaces', method: 'GET', path: `/workspaces?handle=${encodeURIComponent(info.team || '')}&slug=${encodeURIComponent(info.slug)}` });
    return Postman.findWorkspaceId(j, info.slug);
  });
  if (!ws) return [];
  let refs = [];
  if (key) refs = (await step(`https://api.getpostman.com/workspaces/${ws}`, 'API do Postman', async () => Postman.findCollectionRefs(await httpJson('GET', `https://api.getpostman.com/workspaces/${ws}`, keyH)))) || [];
  if (!refs.length) refs = (await step(`${proxy} · coleções do workspace`, 'workspace público', async () => Postman.findCollectionRefs(await httpJson('POST', proxy, [], { service: 'workspaces', method: 'GET', path: `/workspaces/${ws}?include=elements` })))) || [];
  const models = [];
  for (const ref of refs.slice(0, 15)) { const m = await getCollection(ref.uid); if (m) models.push(m); }
  return models;
}
const POSTMAN_HELP = 'Links de workspace do postman.com só entregam o conteúdo para quem está logado. Para importar: cadastre uma chave da API do Postman em Configurações › Postman e tente de novo, ou no Postman abra o ⋯ da coleção › Export › Collection v2.1 e use "Arquivo de spec".';

// Descobre a especificação por trás de uma URL de documentação.
async function discoverApi(url, progress) {
  const tried = [];
  const pmInfo = Postman.parsePostmanUrl(url);
  if (pmInfo) {
    const models = await discoverPostman(pmInfo, url, tried, progress);
    if (models.length) return { model: models[0], more: models.slice(1), tried };
    const e = new Error(POSTMAN_HELP); e.tried = tried; e.postman = true;
    throw e;
  }
  const attempt = async (u, why) => {
    if (tried.some((t) => t.url === u)) return null;
    const entry = { url: u, why, result: '…' }; tried.push(entry);
    progress?.(`Lendo ${u}`, tried);
    try {
      const r = await fetchDoc(u);
      const out = await modelFromText(r.body, r.contentType, r.url, progress);
      entry.result = out.model ? `✓ ${out.model.format}` : out.mono ? '✓ coleção Mono' : out.kind === 'html' ? 'página HTML' : 'sem especificação';
      return { ...out, raw: r };
    } catch (e) { entry.result = e.status ? `HTTP ${e.status}` : 'falhou'; return null; }
  };
  const first = await attempt(url, 'URL informada');
  if (first && (first.model || first.mono)) return { ...first, tried };
  // .asmx / .svc (ASP.NET, WCF): a página é de ajuda; o contrato fica em ?wsdl.
  if (/\.(asmx|svc)(\?|$)/i.test(url) && !/\?(wsdl|singlewsdl)/i.test(url)) {
    const w = await attempt(url.replace(/\?.*$/, '') + '?wsdl', 'WSDL do serviço');
    if (w && w.model) return { ...w, tried };
  }
  const page = first && first.kind === 'html' ? first.raw : null;
  if (page) {
    const cands = Docs.candidatesFromHtml(page.body, page.url);
    for (const c of cands.slice(0, 12)) {
      const r = await attempt(c.url, c.why);
      if (r && (r.model || r.mono)) return { ...r, tried };
      if (r && r.kind === 'text' && /\.js(\?|$)/.test(c.url)) {
        for (const c2 of Docs.candidatesFromHtml(r.raw.body, c.url).slice(0, 4)) {
          const r2 = await attempt(c2.url, 'configuração do Swagger UI');
          if (r2 && (r2.model || r2.mono)) return { ...r2, tried };
        }
      }
    }
  }
  for (const c of Docs.wellKnown(page ? page.url : url)) {
    const r = await attempt(c.url, c.why);
    if (r && (r.model || r.mono)) return { ...r, tried };
  }
  if (page && aiReady()) {
    progress?.('Nenhum formato padrão encontrado — lendo a documentação com IA…', tried);
    const model = await aiExtract(page.body, page.url);
    tried.push({ url: page.url, why: 'IA', result: `✓ ${model.endpoints.length} endpoints` });
    return { model, tried };
  }
  const e = new Error(page
    ? 'Não encontrei uma especificação (OpenAPI, apiDoc ou Postman) por trás dessa página. Configure uma chave de IA em Configurações › IA para ler documentações em formato livre.'
    : 'A URL não respondeu com uma documentação reconhecível.');
  e.tried = tried;
  throw e;
}

// ---------- IA (opcional) ----------
const aiKeyOf = (ai) => (ai.provider === 'openai' ? ai.openaiKey : ai.apiKey);
const aiName = (ai = settings().ai) => (ai.provider === 'openai' ? 'ChatGPT' : 'Claude');
const aiReady = () => !!(settings().ai && aiKeyOf(settings().ai));
function parseAiJson(text) {
  const t = String(text);
  const start = t.indexOf('{'), end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('A IA não devolveu JSON.');
  return JSON.parse(t.slice(start, end + 1));
}
async function aiCall(system, prompt, maxTokens = 6000) {
  const ai = settings().ai;
  const openai = ai.provider === 'openai';
  const r = await api.ai({ provider: openai ? 'openai' : 'anthropic', apiKey: aiKeyOf(ai), model: openai ? ai.openaiModel : ai.model, system, prompt, maxTokens });
  if (!r.ok) throw new Error(r.error);
  return parseAiJson(r.text);
}
async function aiExtract(html, url) {
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<(pre|code)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').slice(0, 90000);
  const j = await aiCall(
    'Você lê documentação de APIs HTTP e devolve SOMENTE um JSON válido, sem comentários. Use português do Brasil nas descrições.',
    `URL da documentação: ${url}\n\nExtraia a API descrita no texto abaixo e responda com este formato:\n{"title":"","version":"","description":"","baseUrl":"https://...","auth":{"type":"none|bearer|basic|apikey|cookie|oauth2","header":"nome do header ou cookie, se houver","tokenEndpoint":"METHOD /caminho, se houver","notes":""},"endpoints":[{"group":"","name":"","method":"GET","path":"/caminho/{{param}}","description":"","headers":[{"key":"","value":""}],"query":[{"key":"","value":""}],"body":null,"needsAuth":false,"returnsToken":false,"tokenField":null}]}\nUse {{nome}} para parâmetros de caminho. body deve ser um objeto JSON de exemplo ou null.\n\nTEXTO:\n${text}`, 12000);
  const kinds = j.auth && j.auth.type && j.auth.type !== 'none' ? [j.auth.type === 'cookie' ? 'cookie-token' : j.auth.type] : [];
  const collectionAuth = !j.auth ? null : j.auth.type === 'bearer' ? { type: 'bearer', token: '{{token}}' } : j.auth.type === 'basic' ? { type: 'basic', username: '{{usuario}}', password: '{{senha}}' } : j.auth.type === 'apikey' ? { type: 'apikey', key: j.auth.header || 'x-api-key', value: '{{apiKey}}', in: 'header' } : null;
  return {
    format: 'Documentação (lida com IA)', source: url, title: j.title || 'API', version: j.version || '', description: j.description || '',
    baseUrl: String(j.baseUrl || '').replace(/\/+$/, ''), authKinds: kinds, collectionAuth,
    endpoints: (j.endpoints || []).map((e) => ({
      name: e.name || `${e.method} ${e.path}`, group: e.group || 'Geral', method: String(e.method || 'GET').toUpperCase(),
      path: e.path || '/', url: '{{baseUrl}}' + (e.path || '/'), description: e.description || '',
      headers: (e.headers || []).map((x) => ({ ...x, enabled: true })), params: (e.query || []).map((x) => ({ ...x, enabled: true })),
      body: e.body ? { type: 'json', raw: JSON.stringify(e.body, null, 2), form: [] } : { type: 'none', raw: '', form: [] },
      auth: e.needsAuth ? null : collectionAuth ? { type: 'none' } : null,
      authHint: e.needsAuth && j.auth && j.auth.type === 'cookie' ? { kind: 'cookie-token' } : null,
      returnsToken: !!e.returnsToken, tokenField: e.tokenField || (e.returnsToken ? 'token' : null),
    })),
  };
}
async function aiEnrichOverview(col) {
  const ov = overviewFor(col);
  const compact = { title: ov.title, baseUrl: ov.baseUrl, docNote: ov.docNote, auth: [ov.authSummary, ...ov.authLines], groups: ov.groups.map((g) => ({ name: g.name, endpoints: g.endpoints.map((e) => `${e.method} ${e.path} — ${e.name}${e.description ? ': ' + e.description.slice(0, 160) : ''}${e.needsAuth ? ' [auth]' : ''}`) })) };
  const j = await aiCall('Você explica APIs para desenvolvedores, em português do Brasil, de forma objetiva. Responda SOMENTE JSON válido.',
    `Com base nesta API, responda {"purpose":"2-4 frases: para que a API serve e que problema resolve","howTo":["passos práticos e curtos para começar a usar, citando os endpoints na ordem certa"],"tips":["armadilhas e boas práticas específicas desta API"]}\n\n${JSON.stringify(compact)}`, 2500);
  col.overviewMeta = { ...(col.overviewMeta || {}), ai: { purpose: j.purpose, howTo: j.howTo, tips: j.tips || [], at: Date.now() } };
  persist();
}

// Modelo a partir da coleção atual — a visão geral reflete o que está no Mono agora.
function modelFromCollection(col) {
  const meta = col.overviewMeta || {};
  const env = activeEnv();
  const base = (env && (env.vars.find((v) => v.key === 'baseUrl') || {}).value) || meta.baseUrl || '';
  return {
    format: meta.format || 'Coleção do Mono', source: meta.source || '', title: col.name.replace(/\s+v?[\d.]+$/, '') || col.name, version: meta.version || '',
    description: meta.docNote || '', baseUrl: base, authKinds: meta.authKinds || [], collectionAuth: null, soap: !!meta.soap,
    endpoints: col.requests.map((r) => {
      const auth = (r.auth && r.auth.type !== 'inherit') ? r.auth : inheritedAuth(col, r.folderId).auth;
      const tm = (r.tests || '').match(/(?:env|pm\.environment)\.set\(\s*['"]token['"]\s*,\s*body\.(\w+)/);
      return {
        name: r.name, method: r.method, soap: r.soap || null, folder: folderPath(col, r.folderId).length ? folderPath(col, r.folderId).map((f) => f.name) : null, group: folderPath(col, r.folderId).map((f) => f.name).join(' / ') || 'Geral',
        path: String(r.url).replace(/^\{\{baseUrl\}\}/, '').replace(/^https?:\/\/[^/]+/, '').split('?')[0] || '/', url: r.url,
        description: r.description || '', auth: auth && auth.type !== 'none' ? auth : null, returnsToken: !!tm, tokenField: tm ? tm[1] : null, responses: [],
      };
    }),
  };
}
function overviewFor(col) {
  const ov = Overview.buildOverview(modelFromCollection(col));
  const meta = col.overviewMeta || {};
  ov.ai = meta.ai || null;
  ov.docNote = meta.docNote || '';
  return ov;
}

function importModel(model, tried, { open = true, quiet = false } = {}) {
  const { collection, vars } = Docs.buildCollection(model, uid);
  collection.overviewMeta = { format: model.format, source: model.source, docNote: model.description || '', authKinds: model.authKinds || [], baseUrl: model.baseUrl, version: model.version, soap: !!model.soap };
  data.collections.push(collection);
  const { note, envName } = applyImportVars(vars, model.title);
  // Relatório da importação: fica guardado para revisitar depois (Visão geral › Importação).
  collection.importReport = {
    at: Date.now(), source: model.source || '', format: model.format, tried: (tried || []).slice(-12),
    envName, vars: vars.map((v) => v.key), folders: collection.folders.length, requests: collection.requests.length,
    collectionVars: (collection.variables || []).map((v) => v.key),
  };
  persist(); side = 'collections'; renderSidebar();
  if (!quiet) toast(`${collection.requests.length} endpoints importados (${model.format})${note}`, 3600);
  if (open) openOverview(collection, { justImported: true, tried });
  if (aiReady()) aiEnrichOverview(collection).then(() => { if ($('#modalBody .ov')?.dataset.col === collection.id) openOverview(collection); }).catch((e) => toast('IA: ' + e.message, 3600));
  return collection;
}
// Variáveis da API: vão para o ambiente ativo se ele ainda não tiver baseUrl; senão, para um ambiente novo.
function applyImportVars(vars, title) {
  if (!vars.length) return { note: '', envName: '' };
  let env = activeEnv();
  const base = vars.find((v) => v.key === 'baseUrl');
  const curBase = env && env.vars.find((v) => v.key === 'baseUrl' && v.value);
  let created = false;
  if (!env || (base && curBase && curBase.value !== base.value)) {
    env = { id: uid('env'), name: title, vars: [] };
    data.environments.push(env); data.activeEnvId = env.id; created = true;
  }
  for (const v of vars) {
    const cur = env.vars.find((x) => x.key === v.key);
    if (!cur) env.vars.push({ key: v.key, value: v.value, enabled: true, secret: !!v.secret });
    else if (!cur.value && v.value) cur.value = v.value;
  }
  renderEnvSelect();
  return { note: created ? ` · ambiente "${env.name}" criado e ativado` : ` · variáveis em "${env.name}"`, envName: env.name };
}

function openImportApi() {
  openModal((body, close) => {
    let mode = 'url';
    const seg = h('div', { class: 'seg' });
    const pane = h('div', { class: 'import-pane' });
    const status = h('div', { class: 'import-status' });
    const err = h('p', { class: 'form-err' });
    const go = h('button', { class: 'btn-primary' }, 'Importar');
    const url = h('input', { class: 'input', placeholder: 'https://api.exemplo.com/docs  ·  swagger.json  ·  …/servico.asmx?wsdl', spellcheck: 'false' });
    const paste = h('textarea', { class: 'code', placeholder: 'Cole aqui OpenAPI (JSON ou YAML), WSDL, coleção Postman, api_data.json do apiDoc ou exportação do Mono', spellcheck: 'false', style: 'height:180px;min-height:0' });
    let file = null;
    const fileBtn = h('button', { class: 'btn-ghost', type: 'button' }, 'Escolher arquivo…');
    const fileName = h('span', { class: 'muted' }, 'Nenhum arquivo escolhido');
    fileBtn.addEventListener('click', async () => {
      const r = await api.openFile({ filters: [{ name: 'Coleções e especificações', extensions: ['json', 'yaml', 'yml', 'wsdl', 'xml'] }] });
      if (r.ok) { file = r; fileName.textContent = r.name; }
    });
    const showTried = (tried) => {
      status.innerHTML = '';
      for (const t of (tried || []).slice(-8)) status.append(h('div', { class: 'tried' }, h('span', { class: 'tr-res' }, t.result), h('span', { class: 'mono' }, t.url), h('span', { class: 'muted' }, t.why)));
    };
    const draw = () => {
      seg.innerHTML = ''; pane.innerHTML = '';
      for (const [k, l] of [['url', 'URL da documentação'], ['file', 'Arquivo de spec'], ['paste', 'Colar JSON / YAML']]) seg.append(h('button', { class: 'seg-btn' + (mode === k ? ' active' : ''), type: 'button', onclick: () => { mode = k; draw(); } }, l));
      if (mode === 'url') pane.append(url, h('p', { class: 'hint' }, 'Funciona com o link da página de documentação (Swagger UI, Redoc, apiDoc), do arquivo da especificação ou do WSDL de um webservice SOAP (…asmx?wsdl). Aceita {{variáveis}} do ambiente.'));
      if (mode === 'file') pane.append(h('div', { class: 'row-actions' }, fileBtn, fileName), h('p', { class: 'hint' }, 'OpenAPI/Swagger (JSON ou YAML), coleção Postman v2.x, api_data.json do apiDoc ou exportação do Mono.'));
      if (mode === 'paste') pane.append(paste, h('p', { class: 'hint' }, 'Cole o conteúdo do arquivo de configuração da API: openapi.json/.yaml, swagger.json, coleção Postman (.json), api_data.json do apiDoc ou exportação do Mono.'));
      setTimeout(() => (mode === 'url' ? url : mode === 'paste' ? paste : fileBtn).focus(), 0);
    };
    go.addEventListener('click', async () => {
      err.textContent = ''; status.innerHTML = '';
      go.disabled = true; go.textContent = 'Analisando…';
      try {
        let out;
        if (mode === 'url') {
          if (!url.value.trim()) throw new Error('Informe a URL da documentação.');
          out = await discoverApi(url.value.trim(), (msg, tried) => { go.textContent = 'Analisando…'; showTried(tried); });
        } else {
          const text = mode === 'file' ? file?.content : paste.value;
          if (!text || !text.trim()) throw new Error(mode === 'file' ? 'Escolha um arquivo.' : 'Cole o conteúdo.');
          out = await modelFromText(text, '', mode === 'file' ? file.name : '');
          if (!out.model && !out.mono) throw new Error(out.kind === 'html' ? 'Isso é uma página HTML — use a aba "URL da documentação".' : 'Formato não reconhecido. Use OpenAPI, Postman, apiDoc ou exportação do Mono.');
        }
        close();
        if (out.mono) {
          const { collection, vars } = Postman.importMono(out.mono, uid);
          data.collections.push(collection);
          const { note } = applyImportVars(vars, collection.name);
          persist(); side = 'collections'; renderSidebar();
          toast(`Coleção "${collection.name}" importada${note}`, 3200);
        } else {
          const first = importModel(out.model, out.tried, { open: !(out.more && out.more.length) });
          for (const m of out.more || []) importModel(m, out.tried, { open: false, quiet: true });
          if (out.more && out.more.length) { toast(`${out.more.length + 1} coleções importadas do workspace`, 3600); openOverview(first, { justImported: true, tried: out.tried }); }
        }
      } catch (e) {
        err.textContent = e.message;
        if (e.tried) showTried(e.tried);
        if (e.postman) err.append(' ', h('button', { class: 'btn-text sm', type: 'button', onclick: () => { close(); openSettings('postman'); } }, 'Abrir Configurações › Postman'));
      } finally { go.disabled = false; go.textContent = 'Importar'; }
    });
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
    body.append(h('h2', {}, 'Importar API'),
      h('p', { class: 'sub' }, 'Cole o link da documentação: o Mono descobre a especificação, monta a coleção com pastas, exemplos e autenticação, e gera um resumo com diagramas.'),
      seg, pane, status, err,
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn-ghost', onclick: close }, 'Cancelar'), go));
    draw();
  });
  $('#modalBody').classList.add('wide');
}

// ---------- Variáveis usadas pela coleção ----------
function collectionVarNames(col) {
  const names = new Set();
  const scan = (v) => { for (const m of JSON.stringify(v ?? '').matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) names.add(m[1]); };
  for (const r of col.requests) scan([r.url, r.headers, r.params, r.body, r.auth]);
  scan([col.auth, ...(col.folders || []).map((f) => f.auth)]);
  for (const v of col.variables || []) names.delete(v.key); // já resolvidas pela coleção
  return [...names].sort((a, b) => (a === 'baseUrl' ? -1 : b === 'baseUrl' ? 1 : a === 'token' ? -1 : b === 'token' ? 1 : a.localeCompare(b)));
}
const defaultVarValue = (col, k) => (k === 'baseUrl' ? col.overviewMeta?.baseUrl || '' : '');
const looksSecret = (k) => /token|secret|senha|password|apikey|api_key/i.test(k);
// Cria no ambiente as variáveis que a coleção usa e ainda não existem. values: valores digitados.
function createCollectionVars(col, env, values = {}) {
  if (!env) {
    env = { id: uid('env'), name: col.name, vars: [] };
    data.environments.push(env); data.activeEnvId = env.id;
  }
  let n = 0;
  for (const k of collectionVarNames(col)) {
    const cur = env.vars.find((v) => v.key === k);
    const val = values[k] ?? defaultVarValue(col, k);
    if (!cur) { env.vars.push({ key: k, value: val, enabled: true, secret: looksSecret(k) }); n++; }
    else if (!cur.value && val) { cur.value = val; n++; }
  }
  persist(); renderEnvSelect();
  if (activeTab()) renderRequest();
  return { env, n };
}
function renderVarsSection(col, redraw) {
  const env = activeEnv();
  const names = collectionVarNames(col);
  const G = listVars(globalsOf().vars);
  const inputs = {};
  const wrap = h('div', {});
  if (!names.length && !(col.variables || []).length) { wrap.append(h('p', { class: 'muted' }, 'Esta coleção não usa {{variáveis}}.')); return wrap; }
  const rows = names.map((k) => {
    const ev = env && env.vars.find((v) => v.key === k && v.enabled !== false);
    const has = ev && ev.value !== '';
    const status = has ? ['ok', `em "${env.name}"`] : ev ? ['warn', 'vazia no ambiente'] : k in G ? ['ok', 'global'] : ['warn', 'faltando'];
    const inp = has || k in G ? null : h('input', { class: 'input sm mono', placeholder: looksSecret(k) ? 'preencha depois, se quiser' : 'valor', value: defaultVarValue(col, k), spellcheck: 'false' });
    if (inp) inputs[k] = inp;
    return h('tr', {},
      h('td', { style: 'width:30%' }, h('code', { class: 'var-chip ' + (status[0] === 'ok' ? 'ok' : 'missing') }, `{{${k}}}`)),
      h('td', {}, inp || h('span', { class: 'mono-cell' }, ev ? (ev.secret ? '••••••••' : ev.value) : G[k])),
      h('td', { style: 'width:150px' }, h('span', { class: 'var-status ' + status[0] }, status[1])));
  });
  for (const v of col.variables || []) rows.push(h('tr', {}, h('td', {}, h('code', { class: 'var-chip ok' }, `{{${v.key}}}`)), h('td', {}, h('span', { class: 'mono-cell' }, v.value)), h('td', {}, h('span', { class: 'var-status ok' }, 'da coleção'))));
  const missing = names.filter((k) => !(env && env.vars.some((v) => v.key === k)) && !(k in G)).length;
  const editable = Object.keys(inputs).length;
  const values = () => Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]));
  wrap.append(h('table', { class: 'data-table ov-vars' }, rows));
  const actions = h('div', { class: 'row-actions', style: 'margin-top:10px' });
  if (editable || !env) {
    actions.append(h('button', { class: 'btn-primary sm', type: 'button', onclick: () => {
      const { env: e, n } = createCollectionVars(col, env, values());
      toast(n ? `${n} variável(is) salva(s) em "${e.name}"` : 'Nada para salvar — preencha um valor.', 2600); redraw();
    } }, !env ? `Criar ambiente "${col.name}" com as variáveis` : missing ? `Criar ${missing} variável(is) em "${env.name}"` : `Salvar valores em "${env.name}"`));
  } else actions.append(h('span', { class: 'var-status ok' }, `✓ Tudo pronto no ambiente "${env.name}"`));
  actions.append(h('button', { class: 'btn-ghost sm', type: 'button', onclick: async () => {
    const o = await promptModal({ title: 'Novo ambiente com as variáveis', label: 'Nome do ambiente', value: `${col.name}${data.environments.some((e) => e.name === col.name) ? ' (2)' : ''}`, ok: 'Criar' });
    if (!o) return;
    const e = { id: uid('env'), name: o.value, vars: [] };
    data.environments.push(e); data.activeEnvId = e.id;
    const { n } = createCollectionVars(col, e, values());
    toast(`Ambiente "${e.name}" criado com ${n} variável(is) e ativado`, 2800);
    openOverview(col);
  } }, 'Criar em novo ambiente…'));
  wrap.append(actions);
  return wrap;
}

// ---------- Visão geral da coleção ----------
function openOverview(col, { justImported = false, tried = null } = {}) {
  const ov = overviewFor(col);
  const purpose = (ov.ai && ov.ai.purpose) || ov.purpose;
  const howTo = (ov.ai && ov.ai.howTo && ov.ai.howTo.length) ? ov.ai.howTo : ov.howTo;
  // Método + caminho viram "GET /caminho" num só bloco; {{variáveis}} soltas viram código (sem quebrar caminhos).
  const fmtText = (t) => h('span', { html: esc(t)
    .replace(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/[^\s,;)]*[^\s,;).])/g, (m, mm, p) => `<span class="ov-ep"><span class="m ${mm}">${mm}</span><code>${p}</code></span>`)
    .split(/(<span class="ov-ep">.*?<\/span><\/span>)/).map((part) => (part.startsWith('<span class="ov-ep">') ? part : part.replace(/\{\{([\w.-]+)\}\}/g, '<code>{{$1}}</code>'))).join('') });
  const reqByPath = (e) => col.requests.find((r) => r.method === e.method && r.name === e.name);
  openModal((body, close) => {
    const aiBtn = h('button', { class: 'btn-ghost sm', type: 'button' }, ov.ai ? 'Refazer resumo com IA' : 'Melhorar resumo com IA');
    aiBtn.addEventListener('click', async () => {
      if (!aiReady()) { close(); openSettings('ai'); return; }
      aiBtn.disabled = true; aiBtn.textContent = 'Gerando…';
      try { await aiEnrichOverview(col); close(); openOverview(col); } catch (e) { toast('IA: ' + e.message, 3600); aiBtn.disabled = false; aiBtn.textContent = 'Melhorar resumo com IA'; }
    });
    const exportBtn = h('button', { class: 'btn-ghost sm', type: 'button', onclick: (e) => showMenu(e.currentTarget, [
      { label: 'Exportar como HTML (com diagramas)', run: () => saveText(`${slug(col.name)}-visao-geral.html`, Overview.toHtml(ov, themeTokens()), [{ name: 'HTML', extensions: ['html'] }]) },
      { label: 'Exportar como Markdown', run: () => saveText(`${slug(col.name)}-visao-geral.md`, Overview.toMarkdown(ov), [{ name: 'Markdown', extensions: ['md'] }]) },
    ]) }, 'Exportar visão geral');
    const diagram = (svg, title) => h('div', { class: 'diagram' }, h('div', { class: 'diagram-scroll', html: svg }), h('div', { class: 'diagram-tools' }, copyButton(svg, `Copiar SVG: ${title}`)));
    const section = (title, ...kids) => h('section', { class: 'ov-sec' }, h('h3', {}, title), ...kids);
    const varsSec = h('div', {});
    const drawVars = () => { varsSec.innerHTML = ''; varsSec.append(renderVarsSection(col, drawVars)); };
    drawVars();
    const rep = col.importReport;
    const importSec = rep ? section('Importação',
      h('table', { class: 'data-table kv-sum' },
        h('tr', {}, h('td', {}, 'Origem'), h('td', {}, rep.source ? h('div', { class: 'ov-src' }, h('span', { class: 'mono-cell' }, rep.source), copyButton(rep.source, 'Copiar URL')) : '—')),
        h('tr', {}, h('td', {}, 'Formato'), h('td', {}, rep.format)),
        h('tr', {}, h('td', {}, 'Importado em'), h('td', {}, new Date(rep.at).toLocaleString('pt-BR'))),
        h('tr', {}, h('td', {}, 'O que foi criado'), h('td', {}, `${rep.requests} requisições em ${rep.folders} pastas`,
          rep.vars.length ? h('div', { class: 'muted small' }, `Variáveis ${rep.vars.map((k) => `{{${k}}}`).join(', ')}${rep.envName ? ` no ambiente "${rep.envName}"` : ''}`) : null,
          rep.collectionVars && rep.collectionVars.length ? h('div', { class: 'muted small' }, `Variáveis da coleção: ${rep.collectionVars.map((k) => `{{${k}}}`).join(', ')}`) : null))),
      rep.tried && rep.tried.length ? h('details', { class: 'ov-tried' }, h('summary', {}, `Onde o Mono procurou (${rep.tried.length})`),
        ...rep.tried.map((t) => h('div', { class: 'tried' }, h('span', { class: 'tr-res' }, t.result), h('span', { class: 'mono' }, t.url), h('span', { class: 'muted' }, t.why)))) : null) : null;
    const wrap = h('div', { class: 'ov', 'data-col': col.id },
      h('div', { class: 'ov-head' },
        h('div', {}, h('h2', {}, ov.title, ov.version ? h('span', { class: 'muted' }, ' ' + ov.version) : null),
          h('div', { class: 'ov-meta' },
            h('span', { class: 'tag' }, ov.format),
            ov.baseUrl ? h('span', { class: 'mono' }, ov.baseUrl) : null,
            h('span', {}, `${ov.counts.endpoints} endpoints · ${ov.counts.groups} grupos`),
            ov.counts.protected ? h('span', { class: 'flag warn' }, `🔒 ${ov.counts.protected} protegidos`) : null)),
        h('div', { class: 'grow' }), aiBtn, exportBtn),
      justImported ? h('div', { class: 'ov-notice' }, '✓ Coleção criada com pastas por grupo, exemplos de body e autenticação configurada.', tried && tried.length > 1 ? h('span', { class: 'muted' }, ` Especificação encontrada em ${tried.filter((t) => t.result.startsWith('✓')).map((t) => t.url).pop()}.`) : null) : null,
      section('Para que serve', h('p', { class: 'ov-lead' }, fmtText(purpose)),
        ov.docNote && !(ov.ai && ov.ai.purpose) ? h('blockquote', {}, ov.docNote) : null,
        ov.capabilities.length ? h('ul', { class: 'ov-list' }, ov.capabilities.map((c) => h('li', {}, fmtText(c)))) : null,
        !ov.ai ? h('p', { class: 'hint' }, aiReady() ? 'Resumo gerado a partir da estrutura da API. Use "Melhorar resumo com IA" para um texto mais completo.' : 'Resumo gerado a partir da estrutura da API. Configure uma chave de IA em Configurações › IA para resumos mais completos.') : null),
      section('Como usar', h('ol', { class: 'ov-steps' }, howTo.map((t) => h('li', {}, fmtText(t)))),
        ov.ai && ov.ai.tips && ov.ai.tips.length ? h('ul', { class: 'ov-list tips' }, ov.ai.tips.map((t) => h('li', {}, fmtText(t)))) : null),
      section('Variáveis', varsSec),
      section('Autenticação', h('p', {}, ov.authSummary), ov.authLines.length ? h('ul', { class: 'ov-list' }, ov.authLines.map((l) => h('li', {}, fmtText(l)))) : null),
      section('Diagrama de comunicação', diagram(Overview.architectureSvg(ov), 'comunicação')),
      section('Fluxo típico', diagram(Overview.sequenceSvg(ov), 'fluxo')),
      section('Endpoints', ...ov.groups.map((g) => h('div', { class: 'ov-group' },
        h('div', { class: 'ov-group-name' }, g.name, h('span', { class: 'muted' }, ` · ${g.endpoints.length}`)),
        h('table', { class: 'data-table ov-table' }, g.endpoints.map((e) => h('tr', { title: 'Abrir requisição', onclick: () => { const r = reqByPath(e); if (r) { close(); openTab(r, { colId: col.id, reqId: r.id }); } } },
          h('td', { style: 'width:72px' }, h('span', { class: 'm ' + methodClass(e.method) }, e.method)),
          h('td', { class: 'mono-cell' }, e.path),
          h('td', {}, e.name, e.description ? h('div', { class: 'muted small' }, e.description.slice(0, 180)) : null),
          h('td', { style: 'width:28px' }, e.needsAuth ? '🔒' : ''))))))),
      importSec,
    );
    body.append(wrap, h('div', { class: 'modal-actions' }, h('button', { class: 'btn-primary', onclick: close }, 'Fechar')));
  });
  $('#modalBody').classList.add('wide', 'xl');
  // abre no topo (o foco automático num campo da seção Variáveis rolava a janela para baixo)
  setTimeout(() => { const m = $('#modalBody'); if (document.activeElement && m.contains(document.activeElement)) document.activeElement.blur(); m.scrollTop = 0; if (m.parentElement) m.parentElement.scrollTop = 0; }, 40);
}
const slug = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'colecao';
function themeTokens() {
  const cs = getComputedStyle(document.documentElement);
  return ['--bg', '--surface', '--surface-2', '--border', '--border-strong', '--text', '--text-2', '--muted', '--invert-bg', '--success', '--warning', '--m-GET', '--m-POST', '--m-PUT', '--m-PATCH', '--m-DELETE']
    .map((k) => `${k}:${cs.getPropertyValue(k).trim()}`).join(';');
}
async function saveText(name, content, filters) {
  const r = await api.saveFile({ name, content, filters });
  if (r.ok) toast(`Salvo em ${r.path}`, 3200);
}

// ---------- Exportar coleção ----------
function exportVars() { const env = activeEnv(); return env ? env.vars.filter((v) => v.key) : []; }
function openExport(col) {
  openModal((body, close) => {
    const opt = (title, text, run) => h('button', { type: 'button', class: 'option-card', onclick: () => { close(); run(); } }, h('span', { class: 'radio-dot' }), h('span', {}, h('b', {}, title), text));
    body.append(h('h2', {}, `Exportar "${col.name}"`), h('p', { class: 'sub' }, 'Segredos do ambiente (marcados com cadeado) nunca são exportados.'),
      h('div', { class: 'option-cards' },
        opt('Mono (.mono.json)', 'Tudo: pastas, autorização, testes, contrato OpenAPI e visão geral. Reimporte no Mono de outra máquina.',
          () => saveText(`${slug(col.name)}.mono.json`, JSON.stringify(Postman.exportMono(col, exportVars()), null, 2), [{ name: 'Coleção Mono', extensions: ['json'] }])),
        opt('Postman Collection v2.1', 'Abre no Postman e no Insomnia. Pastas, headers, body, auth e variáveis.',
          () => saveText(`${slug(col.name)}.postman_collection.json`, JSON.stringify(Postman.toPostman(col, exportVars()), null, 2), [{ name: 'Postman Collection', extensions: ['json'] }])),
        col.spec ? opt('Especificação OpenAPI', 'O contrato original usado para validar as respostas.',
          () => saveText(`${slug(col.name)}.openapi.json`, JSON.stringify(col.spec, null, 2), [{ name: 'OpenAPI', extensions: ['json'] }])) : null,
        opt('Visão geral (HTML)', 'Página com resumo, como usar, diagramas e lista de endpoints — boa para compartilhar com o time.',
          () => saveText(`${slug(col.name)}-visao-geral.html`, Overview.toHtml(overviewFor(col), themeTokens()), [{ name: 'HTML', extensions: ['html'] }]))),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn-ghost', onclick: close }, 'Cancelar')));
  });
}

// ---------- Contrato OpenAPI (atualização) ----------
async function fetchSpec(url) {
  const res = await api.send({ method: 'GET', url, params: null, headers: [{ key: 'Accept', value: 'application/json', enabled: true }], body: { type: 'none' }, auth: { type: 'none' } }, envVars());
  if (!res.ok) throw new Error(res.error);
  if (res.status >= 400) throw new Error(`O servidor respondeu ${res.status} ${res.statusText || ''}`);
  const j = Shape.tryJson(res.body || '');
  if (!j.ok) throw new Error(/^\s*(openapi|swagger)\s*:/m.test(res.body || '') ? 'O arquivo está em YAML. Use a versão JSON (geralmente /swagger/v1/swagger.json).' : 'A resposta não é JSON.');
  return { spec: j.value, finalUrl: res.url || fill(url, envVars()) };
}
// Endpoints do OpenAPI vão para uma pasta por tag (como o Postman faz ao importar).
function tagFolder(col, tag) {
  if (!tag) return null;
  let f = foldersOf(col).find((x) => !x.parentId && x.name === tag);
  if (!f) { f = { id: uid('fld'), name: tag, parentId: null, open: false, auth: { type: 'inherit' } }; col.folders.push(f); }
  return f.id;
}
async function refreshSpec(col) {
  try {
    const { spec, finalUrl } = await fetchSpec(col.specSource);
    const parsed = OpenApi.parseSpec(spec, finalUrl);
    const have = new Set(col.requests.filter((r) => r.contract).map((r) => r.contract.method + ' ' + r.contract.path));
    let added = 0;
    for (const r of parsed.requests) {
      if (have.has(r.contract.method + ' ' + r.contract.path)) continue;
      col.requests.push(newRequest({ name: r.name, method: r.method, url: r.url, params: r.params, headers: r.headers, body: r.body, contract: { ...r.contract, colId: col.id }, folderId: tagFolder(col, r.tag) }));
      added++;
    }
    col.spec = spec;
    const present = new Set(parsed.requests.map((r) => r.contract.method + ' ' + r.contract.path));
    const gone = col.requests.filter((r) => r.contract && !present.has(r.contract.method + ' ' + r.contract.path)).length;
    persist(); renderSidebar();
    toast(`Contrato atualizado${added ? ` · ${added} novo(s) endpoint(s)` : ''}${gone ? ` · ${gone} não existe(m) mais` : ''}`, 3200);
  } catch (e) { toast('Falha ao atualizar: ' + e.message, 3600); }
}


// ---------- Resposta ----------
// Código com números de linha. Realce leve em escala de cinza; desliga em corpos muito grandes.
const BIG_BODY = 400 * 1024;
function highlightMarkupLine(line) {
  return esc(line).replace(/(&lt;!--.*?--&gt;)|(&lt;\/?)([\w:-]+)((?:\s+[\w:@.-]+(?:=(?:&quot;.*?&quot;|&#39;.*?&#39;|[^\s&]+))?)*)(\s*\/?&gt;)?/g,
    (m, comment, open, tag, attrs, close) => {
      if (comment) return `<span class="x-comment">${comment}</span>`;
      const a = (attrs || '').replace(/([\w:@.-]+)(=)?(&quot;.*?&quot;|&#39;.*?&#39;|[^\s&]+)?/g,
        (mm, name, eq, val) => `<span class="x-attr">${name}</span>${eq ? '<span class="j-punc">=</span>' : ''}${val ? `<span class="j-str">${val}</span>` : ''}`);
      return `<span class="j-punc">${open}</span><span class="x-tag">${tag}</span>${a}${close ? `<span class="j-punc">${close}</span>` : ''}`;
    });
}
// Cores para o código gerado (C#, TypeScript, Zod), linha a linha.
const CODE_KW = {
  cs: new Set('using namespace public private internal protected static readonly record class struct enum interface new return get set init required sealed partial abstract override virtual var this base null true false property'.split(' ')),
  ts: new Set('export import from as interface type const let var function return extends implements keyof typeof readonly null undefined true false new'.split(' ')),
};
const CODE_TYPES = {
  cs: new Set('string int long short byte bool double float decimal object char DateTime DateTimeOffset TimeSpan Guid List IList IReadOnlyList IEnumerable Dictionary IDictionary JsonElement'.split(' ')),
  ts: new Set('string number boolean any unknown never void object Array Record Date Partial'.split(' ')),
};
function highlightCodeLine(line, lang) {
  const kw = lang === 'py' ? CODE_KW_PY : CODE_KW[lang] || CODE_KW.ts, types = CODE_TYPES[lang] || CODE_TYPES.ts;
  const re = lang === 'py' ? /(#.*$)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([{}()[\]<>;:,.?=|&]+)/g : /(\/\/.*$|\/\*.*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([{}()[\]<>;:,.?=|&]+)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(line))) {
    out += esc(line.slice(last, m.index));
    const t = m[0];
    if (m[1]) out += `<span class="c-com">${esc(t)}</span>`;
    else if (m[2]) out += `<span class="c-str">${esc(t)}</span>`;
    else if (m[3]) out += `<span class="c-num">${t}</span>`;
    else if (m[4]) {
      if (kw.has(t)) out += `<span class="c-kw">${t}</span>`;
      else if (types.has(t) || (lang === 'cs' && /^[A-Z]/.test(t) && /^\s*[?<\[]?\s*[A-Za-z_]/.test(line.slice(re.lastIndex)) && !/^\s*\(/.test(line.slice(re.lastIndex)))) out += `<span class="c-type">${t}</span>`;
      else if (/^\s*\(/.test(line.slice(re.lastIndex))) out += `<span class="c-fn">${t}</span>`;
      else if (lang !== 'cs' && /^\s*\??:/.test(line.slice(re.lastIndex))) out += `<span class="c-prop-key">${t}</span>`;
      else if (lang === 'cs' && /^[A-Z]/.test(t)) out += `<span class="c-type">${t}</span>`;
      else out += esc(t);
    } else out += `<span class="j-punc">${esc(t)}</span>`;
    last = re.lastIndex;
  }
  return out + esc(line.slice(last));
}
// Cada linha guarda a própria indentação (--ind): quando quebra, continua alinhada, como no Postman.
function codeView(text, kind) {
  const pre = h('pre', { class: 'code-view' });
  const lines = String(text).split('\n');
  const big = text.length > BIG_BODY;
  const hl = big || kind === 'plain' ? esc : kind === 'json' ? highlightJson : kind.startsWith('code:') ? (l) => highlightCodeLine(l, kind.slice(5)) : highlightMarkupLine;
  pre.innerHTML = lines.map((l) => {
    const lead = l.match(/^[ \t]*/)[0];
    const ind = Math.min(lead.replace(/\t/g, '    ').length, 80);
    return `<span class="l" style="--ind:${ind}ch">${hl(l.slice(lead.length)) || ' '}</span>`;
  }).join('');
  pre.style.setProperty('--gutter', `${String(lines.length).length + 2}ch`);
  return pre;
}

const LANG_LABEL = { json: 'JSON', html: 'HTML', xml: 'XML', js: 'JavaScript', css: 'CSS', text: 'Texto' };
function renderTestList(results, error) {
  const list = h('div', { class: 'test-list' });
  if (error) list.append(h('div', { class: 'test-row fail' }, h('span', { class: 'badge' }, 'ERRO'), h('span', {}, scriptErrorText('Após a resposta', error))));
  for (const x of results) {
    list.append(h('div', { class: 'test-row ' + (x.skipped ? 'skip' : x.pass ? 'pass' : 'fail') },
      h('span', { class: 'badge' }, x.skipped ? 'PULADO' : x.pass ? 'PASSOU' : 'FALHOU'),
      h('span', { class: 'test-name' }, x.name),
      x.error ? h('span', { class: 'err' }, x.error) : null,
      x.source && x.source !== 'Requisição' ? h('span', { class: 'src-tag', title: 'Script de origem' }, x.source) : null));
  }
  if (!results.length && !error) list.append(h('div', { class: 'muted' }, 'Nenhum teste registrado. Use pm.test("nome", () => { … }) nos scripts.'));
  return list;
}
function renderConsole(logs) {
  const list = h('div', { class: 'console-list' });
  for (const l of logs) {
    list.append(h('div', { class: 'console-row lv-' + (l.level || 'log') },
      h('span', { class: 'lv' }, { log: '›', info: 'i', warn: '!', error: '✕', debug: '·', net: '⇄' }[l.level] || '›'),
      h('pre', { class: 'console-text' }, l.text),
      l.source && l.source !== 'Requisição' ? h('span', { class: 'src-tag' }, l.source) : null));
  }
  return list;
}

function renderResponse() {
  const pane = $('#responsePane');
  const tab = activeTab();
  const state = rt(tab);
  const sendBtn = $('#sendBtn');
  pane.innerHTML = '';
  if (kindOf(tab.draft) !== 'http') return renderLive(pane, tab);
  sendBtn.classList.remove('danger');
  sendBtn.disabled = !!state.loading; sendBtn.textContent = state.loading ? 'Enviando…' : 'Enviar';
  if (state.loading) {
    pane.append(h('div', { class: 'placeholder' }, h('div', {}, h('div', { class: 'spinner' }), 'Aguardando resposta…')));
    return;
  }
  const res = state.response;
  if (!res) {
    pane.append(h('div', { class: 'placeholder', html: '<div><div class="big">mono</div>Envie uma requisição para ver a resposta.<br><span class="small"><kbd>Ctrl</kbd> + <kbd>Enter</kbd> envia · <kbd>Ctrl</kbd> + <kbd>S</kbd> salva · <kbd>Ctrl</kbd> + <kbd>T</kbd> nova aba</span></div>' }));
    return;
  }
  const sc = state.scripts;
  const allResults = sc ? [...(sc.pre?.results || []), ...(sc.post?.results || [])] : [];
  const allLogs = sc ? [...(sc.pre?.logs || []), ...(sc.post?.logs || [])] : [];
  const postErr = sc?.post?.error || null;
  if (!res.ok) {
    const skipped = res.scriptBlocked && !sc?.pre?.error;
    pane.append(h('div', { class: 'res-head' }, h('div', { class: 'metrics', style: 'padding:8px 0' }, h('span', { class: 'status ' + (skipped ? 's3' : 'err') }, skipped ? 'PULADA' : res.scriptBlocked ? 'ERRO NO SCRIPT' : 'ERRO'), res.time != null ? h('span', {}, 'Tempo ', h('b', {}, fmtTime(res.time))) : null)),
      h('div', { class: 'res-body pad' }, h('pre', { class: 'res-error' }, res.error),
        allResults.length ? renderTestList(allResults, null) : null,
        allLogs.length ? h('div', { class: 'console-block' }, h('div', { class: 'section-label' }, 'Console'), renderConsole(allLogs)) : null));
    return;
  }
  const t = allResults.length || postErr ? { results: allResults, error: postErr } : null;
  const passed = t ? t.results.filter((x) => x.pass && !x.skipped).length : 0;
  const counted = t ? t.results.filter((x) => !x.skipped).length : 0;
  const vis = sc?.post?.visualizer || sc?.pre?.visualizer || null;
  const isImage = /^image\//i.test(res.contentType) && !/svg/i.test(res.contentType) && res.bodyBase64;
  const isHtml = res.body != null && (/html|svg/i.test(res.contentType) || (!/json/i.test(res.contentType) && /^\s*</.test(res.body)));
  const canPreview = isHtml || isImage;
  const cmp = state.compare, ch = state.changes, ct = state.contract;
  const tabs = [];
  if (cmp) tabs.push(['compare', `Comparação${cmp.diffs.length ? ' ' + cmp.diffs.length + (cmp.diffs.length >= 500 ? '+' : '') : ''}`]);
  tabs.push(['body', 'Corpo']);
  if (canPreview) tabs.push(['preview', 'Preview']);
  tabs.push(['headers', `Headers ${res.headers.length}`]);
  if (t) tabs.push(['tests', `Testes ${passed}/${counted}`]);
  if (allLogs.length) tabs.push(['console', `Console ${allLogs.length}`]);
  if (vis) tabs.push(['visualize', 'Visualizar']);
  if (ch) tabs.push(['changes', `Mudanças${ch.list.length ? ' ' + ch.list.length : ''}`]);
  if (ct) tabs.push(['contract', 'Contrato']);
  if (!tabs.some(([k]) => k === resTab)) resTab = 'body';

  const Format = window.MonoFormat;
  const autoLang = res.body != null ? Format.detect(res.contentType, res.body) : 'text';
  const lang = state.lang || autoLang;
  const autoCanPretty = ['json', 'html', 'xml', 'css'].includes(autoLang) && !!res.body && res.body.length <= 3 * 1024 * 1024;
  const isJsonBody = autoLang === 'json' && !!(res.body && Shape.tryJson(res.body).ok);
  if (state.prettyFor !== res || state.prettyLang !== lang) {
    state.prettyFor = res; state.prettyLang = lang;
    state.pretty = res.body ? (res.body.length > 3 * 1024 * 1024 ? null : Format.pretty(lang, res.body)) : null;
  }
  const pretty = state.pretty;

  const head = h('div', { class: 'res-head' },
    h('nav', { class: 'subtabs' }, tabs.map(([k, label]) => h('button', { class: resTab === k ? 'active' : '', onclick: () => { resTab = k; renderResponse(); } }, label))),
    h('div', { class: 'res-tools' },
      res.example == null && res.body != null && !state.compare ? h('button', { class: 'btn-ghost sm', title: 'Guardar esta resposta na requisição (documentação e mock server)', onclick: () => saveExample(tab, res) }, 'Salvar como exemplo') : null,
      resTab === 'preview' && isHtml ? h('span', { class: 'muted small', title: 'Scripts e formulários da página ficam bloqueados no preview' }, 'Scripts desativados') : null,
      null),
    h('div', { class: 'metrics' },
      h('span', { class: `status s${String(res.status)[0]}` }, `${res.status} ${res.statusText || ''}`.trim()),
      res.example != null ? h('span', { class: 'flag', title: 'Exemplo salvo — não é uma resposta ao vivo' }, 'Exemplo · ' + res.example) : h('span', {}, 'Tempo ', h('b', {}, fmtTime(res.time))),
      h('span', {}, 'Tamanho ', h('b', {}, fmtBytes(res.size))),
      ch && ch.list.length ? h('button', { class: 'flag warn', title: 'A estrutura do JSON mudou desde a última resposta', onclick: () => { resTab = 'changes'; renderResponse(); } }, `${ch.list.length} mudança${ch.list.length > 1 ? 's' : ''}`) : null,
      ct ? h('button', { class: 'flag ' + (ct.status === 'ok' ? 'ok' : 'warn'), title: ct.message, onclick: () => { resTab = 'contract'; renderResponse(); } },
        ct.status === 'ok' ? 'Contrato ✓' : ct.status === 'undocumented' ? 'Status não documentado' : `Contrato · ${ct.issues.filter((i) => i.level === 'erro').length || '!'}`) : null));

  const body = h('div', { class: 'res-body' });
  let toolbar = null;
  if (resTab === 'body') {
    const kind = lang === 'json' ? 'json' : lang === 'html' || lang === 'xml' ? 'markup' : 'plain';
    const showPretty = pretty && !resRaw;
    if (res.body != null && res.body !== '') {
      const langSel = h('select', {}, Object.entries(LANG_LABEL).map(([v, l]) => h('option', { value: v }, l)));
      langSel.value = lang;
      langSel.addEventListener('change', () => { state.lang = langSel.value; renderResponse(); });
      const seg = h('div', { class: 'seg sm' },
        h('button', { class: 'seg-btn' + (!resRaw && pretty ? ' active' : ''), disabled: !pretty && !autoCanPretty, title: pretty || autoCanPretty ? '' : 'Sem formatação disponível para este conteúdo', onclick: () => {
          // Pretty sempre formata na linguagem certa: se o seletor estiver em outra, volta para a detectada.
          resRaw = false;
          if (lang !== autoLang) { state.lang = null; if (autoLang !== lang && autoCanPretty) toast(`Linguagem ajustada para ${LANG_LABEL[autoLang] || autoLang}`, 1600); }
          renderResponse();
        } }, 'Pretty'),
        h('button', { class: 'seg-btn' + (resRaw || !pretty ? ' active' : ''), onclick: () => { resRaw = true; renderResponse(); } }, 'Raw'));
      toolbar = h('div', { class: 'body-toolbar' }, langSel, seg, h('div', { class: 'grow' }),
        isJsonBody ? h('button', { class: 'btn-ghost sm', title: 'Gerar C#, TypeScript ou Zod a partir desta resposta', onclick: () => openTypegen(JSON.parse(res.body)) }, 'Gerar tipos') : null,
        copyButton(() => (showPretty ? pretty : res.body), 'Copiar corpo'));
      queueMicrotask(() => customSelect(langSel, { variant: 'compact' }));
    }
    if (res.body == null) body.append(h('div', { class: 'placeholder', style: 'height:100%' }, `Conteúdo binário (${res.contentType || 'desconhecido'}) · ${fmtBytes(res.size)}`));
    else if (!res.body) body.append(h('div', { class: 'placeholder', style: 'height:100%' }, 'Resposta sem corpo.'));
    else body.append(codeView(showPretty ? pretty : res.body, kind));
  } else if (resTab === 'preview') {
    body.classList.add('preview-wrap');
    if (isImage) {
      body.append(h('div', { class: 'img-preview' }, h('img', { src: `data:${res.contentType.split(';')[0]};base64,${res.bodyBase64}`, alt: 'Imagem da resposta' })));
    } else {
      const frame = h('iframe', { class: 'preview-frame', sandbox: '', referrerpolicy: 'no-referrer', title: 'Preview da resposta' });
      body.append(frame);
      const show = (url) => { frame.src = url; };
      if (state.previewFor === res && state.previewUrl) show(state.previewUrl);
      else api.preview(res.body, res.url || res.request?.url).then((url) => { state.previewFor = res; state.previewUrl = url; show(url); });
    }
  } else if (resTab === 'headers') {
    body.append(h('table', { class: 'data-table hdr-table' }, res.headers.map((x) => h('tr', {}, h('td', {}, x.key), h('td', {}, x.value)))));
  } else if (resTab === 'compare') {
    body.classList.add('pad');
    renderCompare(body, cmp);
  } else if (resTab === 'changes') {
    body.classList.add('pad');
    renderChanges(body, ch);
  } else if (resTab === 'contract') {
    body.classList.add('pad');
    renderContract(body, ct);
  } else if (resTab === 'tests') {
    body.classList.add('pad');
    body.append(renderTestList(t.results, t.error));
  } else if (resTab === 'console') {
    body.classList.add('pad');
    body.append(renderConsole(allLogs));
  } else if (resTab === 'visualize') {
    body.classList.add('preview-wrap');
    const frame = h('iframe', { class: 'preview-frame', sandbox: '', referrerpolicy: 'no-referrer', title: 'Visualização do script' });
    body.append(frame);
    if (state.visFor === vis && state.visUrl) frame.src = state.visUrl;
    else api.preview(`<!doctype html><meta charset="utf-8"><style>body{font:13px system-ui,sans-serif;margin:16px;color:#111;background:#fff}</style>${vis.html}`, '').then((url) => { state.visFor = vis; state.visUrl = url; frame.src = url; });
  }
  pane.append(head, toolbar, body);
}

// ---------- Exemplos salvos (respostas de referência) ----------
// Ficam dentro da requisição (sincronizam com o workspace) e alimentam o mock server.
const headerOf = (list, name) => ((list || []).find((x) => String(x.key).toLowerCase() === name) || {}).value || '';
function exampleAsResponse(ex, req) {
  const body = ex.body == null ? '' : String(ex.body);
  return { ok: true, status: Number(ex.status) || 200, statusText: ex.statusText || '', time: 0, size: new TextEncoder().encode(body).length,
    headers: ex.headers || [], contentType: ex.contentType || headerOf(ex.headers, 'content-type'), body, url: req?.url || '', example: ex.name };
}
const KEEP_HEADERS = /^(content-type|location|cache-control|etag|x-[\w-]+|link|retry-after|www-authenticate|set-cookie)$/i;
function exampleFromResponse(res, name) {
  return { id: uid('ex'), name, status: res.status, statusText: res.statusText || '', contentType: res.contentType || '',
    headers: (res.headers || []).filter((x) => KEEP_HEADERS.test(x.key) && !/^x-mono-/i.test(x.key)).map((x) => ({ key: x.key, value: x.value })),
    body: res.body ?? '', savedAt: Date.now() };
}
// Exemplos são documentação: mudam direto na requisição salva (sem precisar de Ctrl+S).
function mutateExamples(tab, fn) {
  const d = tab.draft;
  d.examples ||= [];
  fn(d.examples);
  const found = findRef(tab.ref);
  if (found) { found.req.examples = clone(d.examples); persist(); mockRefresh(); }
  else markDirty();
  updateCounts();
  if (reqTab === 'examples' && activeTab() === tab) renderReqEditor();
}
async function saveExample(tab, res) {
  if (res.body == null) { toast('Respostas binárias não podem virar exemplo.', 2600); return; }
  const n = (tab.draft.examples || []).length;
  const o = await promptModal({ title: 'Salvar como exemplo', sub: 'Fica guardado nesta requisição. O mock server responde com ele.', label: 'Nome', value: `${res.status} ${res.statusText || ''}`.trim() + (n ? ` (${n + 1})` : ''), ok: 'Salvar exemplo' });
  if (!o) return;
  mutateExamples(tab, (list) => list.push(exampleFromResponse(res, o.value)));
  toast(findRef(tab.ref) ? 'Exemplo salvo' : 'Exemplo guardado na aba. Salve a requisição (Ctrl+S) para mantê-lo.', 3200);
}
function showExample(tab, ex) {
  const st = rt(tab);
  st.response = exampleAsResponse(ex, tab.draft);
  st.scripts = null; st.compare = null; st.changes = null; st.contract = null; st.lang = null;
  resTab = 'body';
  renderResponse();
}
const CT_OPTIONS = [['application/json; charset=utf-8', 'JSON'], ['application/xml; charset=utf-8', 'XML'], ['text/plain; charset=utf-8', 'Texto'], ['text/html; charset=utf-8', 'HTML']];
function openExampleEditor(tab, ex = null) {
  const draft = ex ? clone(ex) : { id: uid('ex'), name: 'Exemplo', status: 200, statusText: 'OK', contentType: CT_OPTIONS[0][0], headers: [], body: '{\n  \n}', savedAt: Date.now() };
  draft.headers ||= [];
  openModal((body, close) => {
    body.classList.add('wide');
    const name = h('input', { value: draft.name, spellcheck: 'false' });
    const status = h('input', { value: String(draft.status), inputmode: 'numeric', maxlength: 3, class: 'w-status' });
    const ctSel = h('select', {}, CT_OPTIONS.map(([v, l]) => h('option', { value: v }, l)), h('option', { value: '__other' }, 'Outro…'));
    const known = CT_OPTIONS.find(([v]) => v.split(';')[0] === String(draft.contentType || '').split(';')[0]);
    ctSel.value = known ? known[0] : '__other';
    const ctOther = h('input', { value: known ? '' : draft.contentType || '', placeholder: 'tipo/subtipo', class: known ? 'hidden' : '' });
    ctSel.addEventListener('change', () => ctOther.classList.toggle('hidden', ctSel.value !== '__other'));
    const lang = () => { const ct = ctSel.value === '__other' ? ctOther.value : ctSel.value; return /json/i.test(ct) ? 'json' : /xml|html/i.test(ct) ? 'markup' : 'text'; };
    const editor = window.MonoScripts.codeEditor({ value: draft.body || '', label: 'Corpo do exemplo', complete: false,
      highlight: (v) => (lang() === 'json' ? highlightJson(v) : lang() === 'markup' ? v.split('\n').map(highlightMarkupLine).join('\n') : esc(v)),
      onChange: (v) => { draft.body = v; } });
    const err = h('p', { class: 'ws-err hidden' });
    const save = () => {
      const st = Number(status.value);
      if (!(st >= 100 && st <= 599)) { err.textContent = 'Status precisa ser um número entre 100 e 599.'; err.classList.remove('hidden'); return; }
      draft.name = name.value.trim() || `${st}`;
      draft.status = st; draft.statusText = draft.statusText && ex && ex.status === st ? draft.statusText : '';
      draft.contentType = ctSel.value === '__other' ? ctOther.value.trim() : ctSel.value;
      draft.headers = draft.headers.filter((x) => x.key);
      mutateExamples(tab, (list) => { const i = list.findIndex((x) => x.id === draft.id); if (i >= 0) list[i] = draft; else list.push(draft); });
      close();
      toast(ex ? 'Exemplo atualizado' : 'Exemplo criado');
    };
    body.append(
      h('h2', {}, ex ? 'Editar exemplo' : 'Novo exemplo'),
      h('p', { class: 'sub' }, 'O mock server devolve exatamente isto quando alguém chamar esta rota.'),
      h('div', { class: 'ex-grid' },
        h('div', { class: 'field' }, h('label', {}, 'Nome'), name),
        h('div', { class: 'field' }, h('label', {}, 'Status'), status),
        h('div', { class: 'field' }, h('label', {}, 'Tipo do conteúdo'), h('div', { class: 'row-gap' }, ctSel, ctOther))),
      h('div', { class: 'field' }, h('label', {}, 'Corpo'), h('div', { class: 'body-code ex-body' }, editor)),
      h('details', { class: 'ex-headers', open: draft.headers.length > 0 }, h('summary', {}, `Headers da resposta (${draft.headers.length})`), kvTable(draft.headers, () => {}, { keyPh: 'Header' })),
      err,
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn-ghost', onclick: close }, 'Cancelar'), h('button', { class: 'btn-primary', onclick: save }, ex ? 'Salvar' : 'Criar exemplo')));
    queueMicrotask(() => customSelect(ctSel, { variant: 'compact' }));
  });
}
function renderExamplesTab(ed, tab) {
  const list = tab.draft.examples || [];
  const st = rt(tab);
  const head = h('div', { class: 'body-bar' }, h('span', { class: 'body-bar-label' }, list.length ? plural(list.length, 'exemplo', 'exemplos') : 'Exemplos'), h('div', { class: 'grow' }),
    h('button', { class: 'btn-ghost sm', onclick: () => openExampleEditor(tab) }, '+ Novo exemplo'));
  ed.append(head);
  if (!list.length) {
    ed.append(h('div', { class: 'ex-empty' }, h('b', {}, 'Nenhum exemplo salvo'),
      'Envie a requisição e clique em “Salvar como exemplo” na resposta, ou crie um à mão. Os exemplos documentam a API e alimentam o mock server da coleção.'));
    return;
  }
  const rows = h('div', { class: 'ex-list' });
  for (const ex of list) {
    const showing = st.response && st.response.example === ex.name;
    const def = !!ex.isDefault;
    rows.append(h('div', { class: 'ex-row' + (showing ? ' on' : '') },
      h('span', { class: `status s${String(ex.status)[0]}` }, String(ex.status)),
      h('button', { class: 'ex-name', title: 'Ver na resposta', onclick: () => showExample(tab, ex) }, ex.name),
      def ? h('span', { class: 'tag', title: 'O mock responde com este exemplo por padrão' }, 'padrão do mock') : null,
      h('span', { class: 'muted small' }, fmtBytes(new TextEncoder().encode(ex.body || '').length)),
      h('div', { class: 'grow' }),
      h('button', { class: 'btn-text sm', onclick: () => showExample(tab, ex) }, 'Ver'),
      h('button', { class: 'more', title: 'Opções', onclick: (e) => showMenu(e.currentTarget, [
        { label: 'Editar…', run: () => openExampleEditor(tab, ex) },
        { label: def ? 'Deixar de ser o padrão do mock' : 'Usar como padrão no mock', run: () => mutateExamples(tab, (l) => l.forEach((x) => { x.isDefault = x.id === ex.id ? !def : false; })) },
        { label: 'Duplicar', run: () => mutateExamples(tab, (l) => l.splice(l.indexOf(l.find((x) => x.id === ex.id)) + 1, 0, { ...clone(ex), id: uid('ex'), name: ex.name + ' (cópia)', isDefault: false })) },
        '-',
        { label: 'Excluir', run: async () => { if (await confirmModal({ title: 'Excluir exemplo?', sub: `“${ex.name}” sai da requisição e do mock server.` })) mutateExamples(tab, (l) => l.splice(l.findIndex((x) => x.id === ex.id), 1)); } },
      ]) }, '⋯')));
  }
  ed.append(rows, h('p', { class: 'hint' }, 'No mock server, escolha um exemplo específico com o header x-mono-example: <nome ou status> ou ?__example=<nome>.'));
}

// ---------- Mock server local ----------
const mockState = { running: false, colId: null, url: '', port: 0, hits: [], redraw: null };
const mockRoutesFor = (col) => window.MonoMockRoutes.routesFromCollection(col);
let mockTimer = null;
function mockRefresh() {
  if (!mockState.running || !api.mock) return;
  clearTimeout(mockTimer);
  mockTimer = setTimeout(() => {
    const col = data.collections.find((c) => c.id === mockState.colId);
    api.mock.update({ routes: col ? mockRoutesFor(col) : [] }).catch(() => {});
    mockState.redraw?.();
  }, 300);
}
function mockInit() {
  if (!api.mock) return;
  api.mock.onHit((hit) => { mockState.hits.unshift(hit); mockState.hits.length = Math.min(mockState.hits.length, 60); mockState.redraw?.(); });
  api.mock.status().then((s) => { if (s && s.running) Object.assign(mockState, { running: true, url: s.url, port: s.port }); }).catch(() => {});
}
function openMock(col) {
  if (!api.mock) { toast('O mock server só funciona no app instalado.', 3000); return; }
  openModal((body, close) => {
    body.classList.add('wide');
    const port = h('input', { value: String(data.mockPort || 4010), inputmode: 'numeric', maxlength: 5, class: 'w-port' });
    const delay = h('input', { value: String(data.mockDelay || 0), inputmode: 'numeric', maxlength: 5, class: 'w-port', title: 'Atraso de cada resposta, em milissegundos' });
    const statusEl = h('div', { class: 'mock-status' });
    const routesEl = h('div', {});
    const hitsEl = h('div', { class: 'mock-hits' });
    const thisCol = () => mockState.running && mockState.colId === col.id;
    const draw = () => {
      if (!body.isConnected) { mockState.redraw = null; return; }
      const routes = mockRoutesFor(col);
      statusEl.innerHTML = '';
      const other = mockState.running && mockState.colId !== col.id ? data.collections.find((c) => c.id === mockState.colId) : null;
      statusEl.append(
        h('span', { class: 'cloud-state ' + (thisCol() ? 'online' : 'off') }, h('span', { class: 'dot' }), thisCol() ? 'Rodando' : other ? `Rodando para “${other.name}”` : 'Parado'),
        thisCol() ? h('span', { class: 'mock-url' }, h('code', {}, mockState.url), copyButton(mockState.url, 'Copiar endereço')) : null,
        h('div', { class: 'grow' }),
        h('label', { class: 'mock-field' }, 'Porta', port), h('label', { class: 'mock-field' }, 'Atraso (ms)', delay),
        thisCol()
          ? h('button', { class: 'btn-ghost', onclick: async () => { await api.mock.stop(); mockState.running = false; draw(); renderSidebar(); } }, 'Parar')
          : h('button', { class: 'btn-primary', disabled: !routes.length, onclick: start }, other ? 'Trocar para esta coleção' : 'Iniciar mock'));
      routesEl.innerHTML = '';
      if (!routes.length) {
        routesEl.append(h('div', { class: 'ex-empty' }, h('b', {}, 'Nenhum exemplo salvo nesta coleção'), 'Envie uma requisição e clique em “Salvar como exemplo” na resposta. Cada requisição com exemplo vira uma rota do mock.'));
      } else {
        routesEl.append(h('table', { class: 'data-table mock-routes' },
          h('tr', {}, h('th', {}, 'Método'), h('th', {}, 'Rota'), h('th', {}, 'Requisição'), h('th', {}, 'Responde com')),
          routes.map((r) => { const ex = window.MonoMockRoutes.pickExample(r); return h('tr', {},
            h('td', {}, h('span', { class: 'm ' + methodClass(r.method) }, r.method)), h('td', { class: 'mono' }, r.path), h('td', {}, r.request),
            h('td', {}, h('span', { class: `status s${String(ex.status)[0]}` }, String(ex.status)), ' ', ex.name, r.examples.length > 1 ? h('span', { class: 'muted small' }, ` +${r.examples.length - 1}`) : null)); })));
      }
      hitsEl.innerHTML = '';
      const hits = thisCol() ? mockState.hits : [];
      if (thisCol()) {
        hitsEl.append(h('div', { class: 'section-label' }, 'Chamadas recebidas'));
        if (!hits.length) hitsEl.append(h('p', { class: 'muted small' }, `Aponte o seu front para ${mockState.url} e as chamadas aparecem aqui.`));
        for (const x of hits.slice(0, 30)) hitsEl.append(h('div', { class: 'mock-hit' },
          h('span', { class: 'muted small' }, new Date(x.at).toLocaleTimeString('pt-BR')),
          h('span', { class: 'm ' + methodClass(x.method) }, x.method), h('span', { class: 'mono grow-text' }, x.path),
          h('span', { class: `status s${String(x.status)[0]}` }, String(x.status)),
          h('span', { class: 'muted small' }, x.matched ? `${x.matched.request} › ${x.matched.example}` : 'sem rota')));
      }
    };
    async function start() {
      const p = Number(port.value);
      if (!(p >= 1024 && p <= 65535)) { toast('Use uma porta entre 1024 e 65535.', 2600); return; }
      data.mockPort = p; data.mockDelay = Math.max(0, Number(delay.value) || 0); persist();
      try {
        const r = await api.mock.start({ port: p, delay: data.mockDelay, routes: mockRoutesFor(col) });
        Object.assign(mockState, { running: true, colId: col.id, url: r.url, port: r.port, hits: [] });
        toast(`Mock no ar em ${r.url}`, 2600);
      } catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 4000); }
      draw(); renderSidebar();
    }
    delay.addEventListener('change', () => { data.mockDelay = Math.max(0, Number(delay.value) || 0); persist(); if (thisCol()) api.mock.update({ delay: data.mockDelay }); });
    const mkEnv = h('button', { class: 'btn-ghost sm', title: 'Cria (ou atualiza) um ambiente com baseUrl apontando para o mock', onclick: () => {
      const url = mockState.running ? mockState.url : `http://localhost:${Number(port.value) || 4010}`;
      const name = `Mock · ${col.name}`;
      let env = data.environments.find((e) => e.name === name);
      if (!env) { env = { id: uid('env'), name, vars: clone(activeEnv()?.vars || []).filter((v) => !v.secret) }; data.environments.push(env); }
      const v = env.vars.find((x) => x.key === 'baseUrl');
      if (v) v.value = url; else env.vars.unshift({ key: 'baseUrl', value: url, enabled: true });
      data.activeEnvId = env.id; persist(); renderEnvSelect();
      toast(`Ambiente “${name}” ativo: {{baseUrl}} = ${url}`, 3200);
    } }, 'Usar no Mono (ambiente “Mock”)');
    mockState.redraw = draw;
    draw();
    body.append(
      h('h2', {}, `Mock server · ${col.name}`),
      h('p', { class: 'sub' }, 'Uma API falsa no seu computador, montada com os exemplos salvos. O front pode desenvolver antes do back ficar pronto. Só aceita conexões desta máquina.'),
      statusEl, routesEl, hitsEl,
      h('div', { class: 'modal-actions spread' }, mkEnv, h('button', { class: 'btn-ghost', onclick: () => { mockState.redraw = null; close(); } }, 'Fechar')));
  });
}

// ---------- Salvar ----------
async function saveActive() {
  const tab = activeTab();
  const found = findRef(tab.ref);
  if (found) {
    Object.assign(found.req, clone(tab.draft), { id: found.req.id });
  } else {
    if (!data.collections.length) data.collections.push({ id: uid('col'), name: 'Minha coleção', open: true, requests: [] });
    let sel;
    const out = await promptModal({
      title: 'Salvar requisição', sub: 'Escolha um nome e a coleção de destino.', label: 'Nome', value: tab.draft.name, ok: 'Salvar',
      extra: () => {
        sel = h('select', {}, locationOptions());
        const el = h('div', { class: 'field' }, h('label', {}, 'Salvar em'), sel);
        queueMicrotask(() => customSelect(sel));
        el.getValue = () => sel.value;
        return el;
      },
    });
    if (!out) return;
    const [colId, folderId] = out.extra.split('|');
    const col = data.collections.find((c) => c.id === colId);
    tab.draft.name = out.value;
    tab.draft.folderId = folderId || null;
    const req = clone(tab.draft);
    req.id = uid('req');
    col.requests.push(req); col.open = true;
    for (const f of folderPath(col, req.folderId)) f.open = true;
    tab.ref = { colId: col.id, reqId: req.id };
  }
  tab.dirty = false;
  persist(); renderTabs(); renderRequest(); renderSidebar();
  toast('Salvo');
}

// ---------- Barra lateral ----------
const ICON_FOLDER = '<svg class="ico" viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>';
let dragItem = null;

function locationOptions() {
  const out = [];
  for (const col of data.collections) {
    out.push(h('option', { value: col.id + '|' }, col.name));
    const walk = (pid, prefix) => { for (const f of childFolders(col, pid)) { out.push(h('option', { value: col.id + '|' + f.id }, `${prefix}${f.name}`)); walk(f.id, prefix + f.name + ' / '); } };
    walk(null, col.name + ' / ');
  }
  return out;
}
function retargetTabs(reqId, colId) { session().tabs.forEach((t) => { if (t.ref?.reqId === reqId) t.ref.colId = colId; }); }

function moveRequest(fromCol, req, toCol, folderId) {
  req.folderId = folderId || null;
  if (fromCol !== toCol) {
    fromCol.requests = fromCol.requests.filter((r) => r !== req);
    toCol.requests.push(req);
    retargetTabs(req.id, toCol.id);
  }
}
function moveFolder(fromCol, folder, toCol, parentId) {
  if (fromCol === toCol) {
    if (folderSubtree(fromCol, folder.id).has(parentId)) return toast('Não dá para mover uma pasta para dentro dela mesma', 2600);
    folder.parentId = parentId || null; return true;
  }
  const ids = folderSubtree(fromCol, folder.id);
  const fs = fromCol.folders.filter((f) => ids.has(f.id));
  const rs = fromCol.requests.filter((r) => ids.has(r.folderId));
  fromCol.folders = fromCol.folders.filter((f) => !ids.has(f.id));
  fromCol.requests = fromCol.requests.filter((r) => !ids.has(r.folderId));
  folder.parentId = parentId || null;
  foldersOf(toCol).push(...fs); toCol.requests.push(...rs);
  rs.forEach((r) => retargetTabs(r.id, toCol.id));
  return true;
}
function newFolder(col, parentId) {
  promptModal({ title: 'Nova pasta', label: 'Nome', value: '', ok: 'Criar' }).then((o) => {
    if (!o) return;
    foldersOf(col).push({ id: uid('fld'), name: o.value, parentId: parentId || null, open: true, auth: { type: 'inherit' } });
    col.open = true;
    if (parentId) folderById(col, parentId).open = true;
    persist(); renderSidebar();
  });
}
function newRequestIn(col, folderId) {
  const r = newRequest({ folderId: folderId || null });
  col.requests.push(r); col.open = true;
  for (const f of folderPath(col, folderId)) f.open = true;
  persist(); openTab(r, { colId: col.id, reqId: r.id });
}
function openContainerAuth(col, folder) {
  const target = folder || col;
  target.auth ||= { type: folder ? 'inherit' : 'none' };
  openModal((body, close) => {
    body.append(h('h2', {}, `Autorização · ${target.name}`),
      h('p', { class: 'sub' }, folder ? 'Requisições desta pasta com "Herdar do pai" usam esta autorização.' : 'Vale para todas as requisições da coleção que usam "Herdar do pai".'),
      window.MonoAuth.editor(target.auth, {
        onChange: () => { persist(); }, allowInherit: !!folder, vars: envVars,
        inherited: folder ? inheritedAuth(col, folder.parentId) : null,
      }),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn-primary', onclick: () => { close(); persist(); if (reqTab === 'auth') renderReqEditor(); } }, 'Concluir')));
  });
  $('#modalBody').classList.add('wide');
}
// Scripts de coleção e pasta: rodam em todas as requisições abaixo delas (coleção → pastas → requisição).
function openContainerScripts(col, folder) {
  const target = folder || col;
  target.pre ??= ''; target.tests ??= '';
  openModal((body, close) => {
    body.append(h('h2', {}, `Scripts · ${target.name}`),
      h('p', { class: 'sub' }, folder
        ? 'Rodam em todas as requisições desta pasta e das subpastas — depois dos scripts da coleção e antes dos da requisição.'
        : 'Rodam em todas as requisições da coleção, antes dos scripts das pastas e da requisição. Bom lugar para buscar token ou testes comuns.'),
      h('div', { class: 'container-scripts' }, window.MonoScripts.scriptsPanel(target, { which: String(target.pre || '').trim() || !String(target.tests || '').trim() ? 'pre' : 'post', onChange: persist })),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn-primary', onclick: () => { close(); persist(); renderSidebar(); } }, 'Concluir')));
  });
  $('#modalBody').classList.add('wide', 'xl');
}
function openCollectionVars(col) {
  col.variables ||= [];
  openModal((body, close) => {
    body.append(h('h2', {}, `Variáveis · ${col.name}`),
      h('p', { class: 'sub', html: 'Valem para todas as requisições desta coleção, em qualquer ambiente. Se o ambiente ativo tiver uma variável com o mesmo nome, a do ambiente vence. Nos scripts: <code>pm.collectionVariables</code>.' }),
      kvTable(col.variables, persist, { keyPh: 'Variável' }),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn-primary', onclick: () => { close(); persist(); } }, 'Concluir')));
  });
  $('#modalBody').classList.add('wide');
}
function moveDialog(col, req) {
  promptModal({
    title: 'Mover requisição', label: 'Nome', value: req.name, ok: 'Mover',
    extra: () => {
      const sel = h('select', {}, locationOptions());
      sel.value = col.id + '|' + (req.folderId || '');
      const el = h('div', { class: 'field' }, h('label', {}, 'Para'), sel);
      queueMicrotask(() => customSelect(sel));
      el.getValue = () => sel.value;
      return el;
    },
  }).then((o) => {
    if (!o) return;
    const [colId, fid] = o.extra.split('|');
    req.name = o.value;
    moveRequest(col, req, data.collections.find((c) => c.id === colId), fid);
    persist(); renderSidebar(); renderRequest();
  });
}

function dropTarget(row, col, folderId) {
  row.addEventListener('dragover', (e) => { if (!dragItem) return; e.preventDefault(); row.classList.add('drop'); });
  row.addEventListener('dragleave', () => row.classList.remove('drop'));
  row.addEventListener('drop', (e) => {
    e.preventDefault(); row.classList.remove('drop');
    const it = dragItem; dragItem = null;
    if (!it) return;
    const from = data.collections.find((c) => c.id === it.colId);
    if (it.kind === 'request') { const r = from.requests.find((x) => x.id === it.id); if (r) moveRequest(from, r, col, folderId); }
    else { const f = folderById(from, it.id); if (f && f.id !== folderId) moveFolder(from, f, col, folderId); }
    if (folderId) folderById(col, folderId).open = true;
    col.open = true;
    persist(); renderSidebar(); renderRequest();
  });
}
function draggable(row, item) {
  row.draggable = true;
  row.addEventListener('dragstart', (e) => { dragItem = item; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', item.id); });
  row.addEventListener('dragend', () => { dragItem = null; $$('.tree-row.drop').forEach((x) => x.classList.remove('drop')); });
}

function renderSidebar() { renderSidebarCore(); decorateCollab(); }
function renderSidebarCore() {
  const list = $('#sideList');
  const q = $('#sideSearch').value.trim().toLowerCase();
  list.innerHTML = '';
  $$('.sidebar .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.side === side));
  $('#newCollectionBtn').textContent = side === 'collections' ? '+ Nova coleção' : 'Limpar histórico';
  $('#importSpecBtn').classList.toggle('hidden', side !== 'collections');
  const activeRef = activeTab()?.ref;

  if (side === 'collections') {
    if (!data.collections.length) {
      list.append(h('div', { class: 'empty' }, h('strong', {}, 'Nenhuma coleção'), 'Salve uma requisição com Ctrl S ou crie uma coleção abaixo.'));
      return;
    }
    const matches = (r) => !q || r.name.toLowerCase().includes(q) || r.url.toLowerCase().includes(q);
    const folderHasMatch = (col, fid) => childReqs(col, fid).some(matches) || childFolders(col, fid).some((f) => f.name.toLowerCase().includes(q) || folderHasMatch(col, f.id));

    for (const col of data.collections) {
      foldersOf(col);
      if (q && !col.name.toLowerCase().includes(q) && !folderHasMatch(col, null)) continue;
      const open = q ? true : col.open;
      const more = h('button', { class: 'more', title: 'Opções', onclick: (e) => { e.stopPropagation(); showMenu(e.currentTarget, [
        { label: 'Visão geral', run: () => openOverview(col) },
        { label: 'Executar coleção…', run: () => openRunner(col, null) },
        { label: 'Monitorar…', run: () => openMonitorForm(activeWorkspace(), null, { colId: col.id, name: col.name }) },
        { label: 'Mock server…', run: () => openMock(col) },
        '-',
        { label: 'Nova requisição', run: () => newRequestIn(col, null) },
        { label: 'Nova pasta', run: () => newFolder(col, null) },
        { label: 'Autorização…', run: () => openContainerAuth(col, null) },
        { label: 'Scripts…', run: () => openContainerScripts(col, null) },
        { label: 'Variáveis…', run: () => openCollectionVars(col) },
        { label: 'Criar variáveis no ambiente', run: () => { const { env: e, n } = createCollectionVars(col, activeEnv()); toast(n ? `${n} variável(is) criada(s) em "${e.name}"` : `"${e.name}" já tem todas as variáveis da coleção`, 2600); } },
        { label: 'Renomear', run: async () => { const o = await promptModal({ title: 'Renomear coleção', label: 'Nome', value: col.name }); if (o) { col.name = o.value; persist(); renderSidebar(); renderRequest(); } } },
        ...(col.specSource ? [{ label: 'Atualizar do OpenAPI', run: () => refreshSpec(col) }] : []),
        { label: 'Exportar…', run: () => openExport(col) },
        '-',
        { label: 'Excluir', run: async () => { if (await confirmModal({ title: 'Excluir coleção?', sub: `"${col.name}", suas ${col.folders.length} pastas e ${col.requests.length} requisições serão removidas.` })) { data.collections = data.collections.filter((c) => c !== col); session().tabs.forEach((t) => { if (t.ref?.colId === col.id) t.ref = null; }); persist(); renderSidebar(); renderRequest(); } } },
      ]); } }, '⋯');
      const ovBtn = col.overviewMeta || col.importReport ? h('button', { class: 'row-ic', title: 'Visão geral da API (resumo, diagramas, variáveis e importação)', html: icons.book, onclick: (e) => { e.stopPropagation(); openOverview(col); } }) : null;
      const head = h('div', { class: 'tree-row collection' + (open ? ' open' : ''), style: '--depth:0', onclick: () => { col.open = !col.open; persist(); renderSidebar(); }, html: icons.chev },
        h('span', { class: 'name' }, col.name), ovBtn,
        col.spec ? h('span', { class: 'tag', title: 'Coleção com contrato OpenAPI — respostas são validadas' }, 'API') : null,
        mockState.running && mockState.colId === col.id ? h('button', { class: 'tag mock-tag', title: `Mock server rodando em ${mockState.url}`, onclick: (e) => { e.stopPropagation(); openMock(col); } }, 'MOCK') : null,
        h('span', { class: 'n' }, col.requests.length), more);
      dropTarget(head, col, null);
      list.append(head);
      if (open) renderLevel(col, null, 1);
    }

    function renderLevel(col, fid, depth) {
      for (const f of childFolders(col, fid)) {
        if (q && !f.name.toLowerCase().includes(q) && !folderHasMatch(col, f.id)) continue;
        const fopen = q ? true : f.open;
        const fmore = h('button', { class: 'more', title: 'Opções', onclick: (e) => { e.stopPropagation(); showMenu(e.currentTarget, [
          { label: 'Executar pasta…', run: () => openRunner(col, f) },
          { label: 'Monitorar…', run: () => openMonitorForm(activeWorkspace(), null, { colId: col.id, folderId: f.id, name: `${col.name} / ${f.name}` }) },
          '-',
          { label: 'Nova requisição', run: () => newRequestIn(col, f.id) },
          { label: 'Nova pasta', run: () => newFolder(col, f.id) },
          { label: 'Autorização…', run: () => openContainerAuth(col, f) },
          { label: 'Scripts…', run: () => openContainerScripts(col, f) },
          { label: 'Renomear', run: async () => { const o = await promptModal({ title: 'Renomear pasta', label: 'Nome', value: f.name }); if (o) { f.name = o.value; persist(); renderSidebar(); renderRequest(); } } },
          '-',
          { label: 'Excluir', run: async () => {
            const ids = folderSubtree(col, f.id);
            const n = col.requests.filter((r) => ids.has(r.folderId)).length;
            if (!(await confirmModal({ title: 'Excluir pasta?', sub: `"${f.name}"${ids.size > 1 ? `, ${ids.size - 1} subpasta(s)` : ''} e ${n} requisição(ões) serão removidas.` }))) return;
            const removed = new Set(col.requests.filter((r) => ids.has(r.folderId)).map((r) => r.id));
            col.folders = col.folders.filter((x) => !ids.has(x.id));
            col.requests = col.requests.filter((r) => !ids.has(r.folderId));
            session().tabs.forEach((t) => { if (t.ref && removed.has(t.ref.reqId)) t.ref = null; });
            persist(); renderSidebar(); renderRequest();
          } },
        ]); } }, '⋯');
        const row = h('div', { class: 'tree-row folder' + (fopen ? ' open' : ''), style: `--depth:${depth}`, onclick: () => { f.open = !f.open; persist(); renderSidebar(); }, html: icons.chev + ICON_FOLDER },
          h('span', { class: 'name' }, f.name),
          f.auth && f.auth.type && !['inherit', 'none'].includes(f.auth.type) ? h('span', { class: 'tag', title: 'Autorização definida nesta pasta: ' + window.MonoAuth.describe(f.auth) }, 'AUTH') : null,
          h('span', { class: 'n' }, countInFolder(col, f.id)), fmore);
        draggable(row, { kind: 'folder', colId: col.id, id: f.id });
        dropTarget(row, col, f.id);
        list.append(row);
        if (fopen) renderLevel(col, f.id, depth + 1);
      }
      for (const r of childReqs(col, fid)) {
        if (!matches(r)) continue;
        const rmore = h('button', { class: 'more', title: 'Opções', onclick: (e) => { e.stopPropagation(); showMenu(e.currentTarget, [
          { label: 'Renomear', run: async () => { const o = await promptModal({ title: 'Renomear requisição', label: 'Nome', value: r.name }); if (o) { r.name = o.value; session().tabs.forEach((t) => { if (t.ref?.reqId === r.id) t.draft.name = o.value; }); persist(); renderSidebar(); renderTabs(); renderRequest(); } } },
          { label: 'Duplicar', run: () => { const c = clone(r); c.id = uid('req'); c.name += ' (cópia)'; col.requests.splice(col.requests.indexOf(r) + 1, 0, c); persist(); renderSidebar(); } },
          { label: 'Mover para…', run: () => moveDialog(col, r) },
          ...(activeWorkspace().shared ? [{ label: 'Histórico de alterações…', run: () => openHistory(activeWorkspace(), { itemId: r.id, title: `Histórico de “${r.name}”` }) }] : []),
          '-',
          { label: 'Excluir', run: async () => { if (await confirmModal({ title: 'Excluir requisição?', sub: `"${r.name}" será removida da coleção.` })) { col.requests = col.requests.filter((x) => x !== r); session().tabs.forEach((t) => { if (t.ref?.reqId === r.id) t.ref = null; }); persist(); renderSidebar(); renderRequest(); } } },
        ]); } }, '⋯');
        const row = h('div', { class: 'tree-row request' + (activeRef?.reqId === r.id ? ' active' : ''), 'data-req': r.id, style: `--depth:${depth - 1}`, title: r.url, onclick: () => openTab(r, { colId: col.id, reqId: r.id }) },
          h('span', { class: 'm ' + methodClass(r.method) }, r.method), h('span', { class: 'name' }, r.name), rmore);
        draggable(row, { kind: 'request', colId: col.id, id: r.id });
        list.append(row);
      }
    }
  } else {
    const items = data.history.filter((x) => !q || x.url.toLowerCase().includes(q));
    if (!items.length) { list.append(h('div', { class: 'empty' }, h('strong', {}, 'Histórico vazio'), 'Cada envio aparece aqui.')); return; }
    let lastDay = '';
    for (const it of items) {
      const day = new Date(it.at).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' });
      if (day !== lastDay) { list.append(h('div', { class: 'hist-day' }, day)); lastDay = day; }
      list.append(h('div', { class: 'hist-item', title: new Date(it.at).toLocaleString('pt-BR'), onclick: () => openTab({ ...clone(it.request), id: uid('req') }) },
        h('span', { class: 'm ' + methodClass(it.method) }, it.method), h('span', { class: 'history-url' }, it.url.replace(/^https?:\/\//, '')),
        it.env ? h('span', { class: 'hist-env', title: 'Ambiente' }, it.env) : null,
        h('span', { class: 'hist-status' }, it.status ?? 'ERR')));
    }
  }
}

// ---------- Ambientes ----------
function renderEnvSelect() {
  const sel = $('#envSelect');
  sel.innerHTML = '';
  sel.append(h('option', { value: '' }, 'Sem ambiente'));
  for (const e of data.environments) sel.append(h('option', { value: e.id }, e.name));
  sel.value = data.activeEnvId || '';
  customSelect(sel, { variant: 'ghost' }).sync();
  renderProdBanner();
  window.MonoVars?.refresh();
}
function renderProdBanner() {
  const env = activeEnv();
  const banner = $('#prodBanner');
  const prod = !!(env && env.prod);
  banner.classList.toggle('hidden', !prod);
  document.body.classList.toggle('is-prod', prod);
  banner.innerHTML = '';
  if (prod) banner.append(
    h('span', { class: 'pb-pill' }, h('span', { class: 'pb-dot' }), 'PRODUÇÃO'),
    h('span', { class: 'pb-env' }, env.name),
    h('span', {}, 'POST, PUT, PATCH e DELETE pedem confirmação antes de enviar'));
}
async function openEnvEditor() {
  const secure = await api.secureStorage().catch(() => false);
  let current = data.environments.find((e) => e.id === data.activeEnvId) || data.environments[0];
  openModal((body, close) => {
    const left = h('div', { class: 'env-list' });
    const right = h('div', {});
    const G = globalsOf();
    const draw = () => {
      left.innerHTML = ''; right.innerHTML = '';
      left.append(h('button', { class: 'env-globals' + (current === G ? ' active' : ''), onclick: () => { current = G; draw(); } }, 'Globais'), h('div', { class: 'env-sep' }));
      if (current === G) {
        right.append(h('div', { class: 'row-actions' }, h('b', { class: 'env-g-title' }, 'Variáveis globais')),
          h('p', { class: 'hint', style: 'margin-top:0', html: 'Valem em qualquer ambiente e coleção. Variáveis da coleção e do ambiente com o mesmo nome têm prioridade. Nos scripts: <code>pm.globals</code>.' }),
          kvTable(G.vars, persist, { keyPh: 'Variável' }));
        for (const e of data.environments) left.append(h('button', { onclick: () => { current = e; draw(); } }, e.name, e.prod ? h('span', { class: 'prod-pill' }, 'PROD') : null));
        left.append(h('button', { class: 'muted', onclick: () => { current = { id: uid('env'), name: 'Novo ambiente', vars: [] }; data.environments.push(current); persist(); renderEnvSelect(); draw(); } }, '+ Novo'));
        return;
      }
      for (const e of data.environments) left.append(h('button', { class: e === current ? 'active' : '', onclick: () => { current = e; draw(); } }, e.name, e.prod ? h('span', { class: 'prod-pill' }, 'PROD') : null));
      left.append(h('button', { class: 'muted', onclick: () => { current = { id: uid('env'), name: 'Novo ambiente', vars: [] }; data.environments.push(current); persist(); renderEnvSelect(); draw(); } }, '+ Novo'));
      if (!current) { right.append(h('div', { class: 'empty' }, 'Crie um ambiente para guardar variáveis como baseUrl e token.')); return; }
      const name = h('input', { class: 'input', value: current.name, style: 'flex:1' });
      name.addEventListener('input', () => { current.name = name.value; persist(); renderEnvSelect(); $('.env-list .active', body).textContent = current.name; });
      right.append(
        h('div', { class: 'row-actions' }, name,
          h('button', { class: 'btn-ghost sm', onclick: () => { data.activeEnvId = current.id; persist(); renderEnvSelect(); toast(`Ambiente "${current.name}" ativo`); } }, data.activeEnvId === current.id ? 'Ativo' : 'Ativar'),
          h('button', { class: 'btn-ghost sm', onclick: async () => {
            const env = current;
            close();
            if (await confirmModal({ title: 'Excluir ambiente?', sub: `"${env.name}" e suas variáveis serão removidos.` })) {
              data.environments = data.environments.filter((e) => e !== env);
              if (data.activeEnvId === env.id) data.activeEnvId = data.environments[0]?.id || '';
              persist(); renderEnvSelect();
            }
            openEnvEditor();
          } }, 'Excluir')),
        h('label', { class: 'prod-toggle' },
          h('input', { type: 'checkbox', checked: !!current.prod, onchange: (e) => { current.prod = e.target.checked; persist(); renderProdBanner(); draw(); } }),
          h('span', {}, h('b', {}, 'Ambiente de produção'), ' — mostra uma faixa de aviso e pede confirmação antes de POST, PUT, PATCH e DELETE.')),
        kvTable(current.vars, persist, { keyPh: 'Variável', secret: true }),
        h('p', { class: 'hint', html: secure
          ? 'Use <code>{{nome}}</code> na URL, headers, body e auth. Clique no cadeado para marcar como <b>segredo</b> — o valor é criptografado no disco pelo cofre do sistema (DPAPI/Keychain).'
          : 'Use <code>{{nome}}</code> na URL, headers, body e auth. Aviso: o cofre do sistema não está disponível, então segredos ficam em texto puro no disco.' }));
    };
    body.append(h('h2', {}, 'Ambientes'), h('p', { class: 'sub' }, 'Variáveis por contexto — troque entre local, homologação e produção sem editar requisições.'),
      h('div', { class: 'env-layout' }, left, right),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn-primary', onclick: () => { close(); renderEnvSelect(); } }, 'Concluir')));
    draw();
  });
}

// ---------- Certificados digitais (Configurações › Certificados) ----------
function certCard(c, onChange, onRemove) {
  const info = h('div', { class: 'cert-info' });
  const showInfo = (r) => {
    info.innerHTML = '';
    if (!r) return;
    if (!r.ok) { info.append(h('span', { class: 'cert-bad' }, r.error)); return; }
    const days = r.validTo ? Math.round((new Date(r.validTo) - Date.now()) / 864e5) : null;
    info.append(h('div', { class: 'cert-subj' }, r.subject || 'Certificado válido'),
      r.validTo ? h('div', { class: days < 0 ? 'cert-bad' : days < 30 ? 'cert-warn' : 'muted small' }, days < 0 ? `Vencido em ${new Date(r.validTo).toLocaleDateString('pt-BR')}` : `Válido até ${new Date(r.validTo).toLocaleDateString('pt-BR')}${days < 30 ? ` — vence em ${days} dia(s)` : ''}`) : null);
  };
  const test = async () => { if (!c.path) return showInfo({ ok: false, error: 'Escolha o arquivo .pfx.' }); showInfo(await api.inspectCert({ path: c.path, passphrase: c.passphrase })); };
  const host = h('input', { class: 'input', value: c.host || '', placeholder: '*.fazenda.sp.gov.br  ou  nfe.sefaz.rs.gov.br', spellcheck: 'false' });
  host.addEventListener('input', () => { c.host = host.value.trim(); onChange(); });
  const pass = h('input', { class: 'input', type: 'password', value: c.passphrase || '', placeholder: 'senha do certificado' });
  pass.addEventListener('change', () => { c.passphrase = pass.value; onChange(); test(); });
  const fileRow = (label, nameKey, pathKey, filters) => {
    const wrap = h('div', { class: 'cert-file' });
    const draw = () => {
      wrap.innerHTML = '';
      wrap.append(h('span', { class: c[pathKey] ? 'mono-cell' : 'muted' }, c[pathKey] ? c[nameKey] : 'nenhum arquivo'),
        h('button', { class: 'btn-ghost sm', type: 'button', onclick: async () => {
          const r = await api.pickFile({ filters, title: label });
          if (r && r.ok) { c[pathKey] = r.path; c[nameKey] = r.name; onChange(); draw(); if (pathKey === 'path') test(); }
        } }, c[pathKey] ? 'Trocar' : 'Escolher…'),
        c[pathKey] && pathKey === 'caPath' ? h('button', { class: 'btn-text sm', type: 'button', onclick: () => { c.caPath = ''; c.caName = ''; onChange(); draw(); } }, 'Remover') : null);
    };
    draw();
    return h('div', { class: 'field' }, h('label', {}, label), wrap);
  };
  const enabled = h('label', { class: 'check-row', style: 'margin:0' }, h('input', { type: 'checkbox', checked: c.enabled !== false, onchange: (e) => { c.enabled = e.target.checked; onChange(); } }), h('span', {}, 'Ativo'));
  const card = h('div', { class: 'cert-card' },
    h('div', { class: 'field' }, h('label', {}, 'Host'), host),
    h('div', { class: 'field-row' }, fileRow('Certificado (.pfx / .p12)', 'name', 'path', [{ name: 'Certificado', extensions: ['pfx', 'p12'] }]), h('div', { class: 'field' }, h('label', {}, 'Senha'), pass)),
    fileRow('CA do servidor (opcional)', 'caName', 'caPath', [{ name: 'Certificado da CA', extensions: ['pem', 'cer', 'crt'] }]),
    info,
    h('div', { class: 'row-actions' }, enabled, h('div', { class: 'grow' }), h('button', { class: 'btn-ghost sm', type: 'button', onclick: test }, 'Testar certificado'), h('button', { class: 'btn-text sm', type: 'button', onclick: onRemove }, 'Remover')));
  if (c.path) test();
  return card;
}

// ---------- Atualização automática ----------
let lastUpdate = { state: 'idle' };
const updateListeners = new Set();
function updateText(u) {
  return { dev: 'Rodando pelo npm run dev — as atualizações automáticas só funcionam no app instalado.', idle: 'Nenhuma verificação ainda.', checking: 'Procurando atualizações…', latest: `Você está na versão mais recente (${u.current || ''}).`,
    downloading: `Baixando a versão ${u.version || ''}… ${u.percent || 0}%`, ready: `A versão ${u.version} foi baixada. Reinicie para instalar.${u.notes ? '\n\n' + u.notes : ''}`, error: `Não foi possível verificar: ${u.error || ''}` }[u.state] || '';
}
function initUpdates() {
  if (!api.onUpdate) return;
  const btn = $('#updateBtn');
  const apply = (u) => {
    const prev = lastUpdate.state;
    lastUpdate = u;
    btn.classList.toggle('hidden', u.state !== 'ready');
    if (u.state === 'ready') { $('#updateLabel').textContent = `Atualizar para ${u.version}`; if (prev !== 'ready') toast(`Versão ${u.version} pronta — clique em "Atualizar" no topo para reiniciar.`, 6000); }
    for (const fn of updateListeners) { try { fn(u); } catch { updateListeners.delete(fn); } }
  };
  api.updateStatus().then(apply).catch(() => {});
  api.onUpdate(apply);
  btn.addEventListener('click', () => api.installUpdate());
}

// ---------- Configurações (globais do usuário) ----------
const SETTINGS_DEFAULTS = {
  proxy: { mode: 'system', protocol: 'http', host: '', port: '', auth: false, username: '', password: '', bypass: 'localhost, 127.0.0.1, <local>' },
  request: { timeoutMs: 30000, followRedirects: true, sslVerify: true },
  ai: { provider: 'anthropic', apiKey: '', model: 'claude-sonnet-5-5', openaiKey: '', openaiModel: 'gpt-5-mini' },
  postman: { apiKey: '' },
};
function settings() {
  data.settings ||= {};
  data.settings.proxy = { ...SETTINGS_DEFAULTS.proxy, ...data.settings.proxy };
  data.settings.request = { ...SETTINGS_DEFAULTS.request, ...data.settings.request };
  data.settings.ai = { ...SETTINGS_DEFAULTS.ai, ...data.settings.ai };
  data.settings.postman = { ...SETTINGS_DEFAULTS.postman, ...data.settings.postman };
  if (!Array.isArray(data.settings.certs)) data.settings.certs = [];
  return data.settings;
}
let applyTimer;
function applySettingsSoon() {
  clearTimeout(applyTimer);
  applyTimer = setTimeout(() => api.applySettings?.(clone(settings())), 300);
  persist();
}
function openSettings(section = 'proxy') {
  const st = settings();
  openModal((body, close) => {
    const nav = h('div', { class: 'settings-nav' });
    const pane = h('div', { class: 'settings-section' });
    const sections = [['proxy', 'Proxy'], ['request', 'Requisições'], ['certs', 'Certificados'], ['ai', 'IA'], ['postman', 'Postman'], ['about', 'Sobre']];
    const field = (obj, key, label, { type = 'text', ph = '', cls = '' } = {}) => {
      const inp = h('input', { class: 'input ' + cls, type, value: obj[key] ?? '', placeholder: ph, spellcheck: 'false' });
      inp.addEventListener('input', () => { obj[key] = type === 'number' ? Number(inp.value) : inp.value; applySettingsSoon(); });
      return h('div', { class: 'field' }, h('label', {}, label), inp);
    };
    const check = (obj, key, title, text, redraw) => h('label', { class: 'check-row' },
      h('input', { type: 'checkbox', checked: !!obj[key], onchange: (e) => { obj[key] = e.target.checked; applySettingsSoon(); if (redraw) redraw(); } }),
      h('span', {}, h('b', {}, title), text ? ' — ' + text : ''));
    const draw = () => {
      nav.innerHTML = ''; pane.innerHTML = '';
      for (const [k, l] of sections) nav.append(h('button', { class: section === k ? 'active' : '', onclick: () => { section = k; draw(); } }, l));
      if (section === 'proxy') {
        const p = st.proxy;
        const card = (mode, title, text) => h('button', { type: 'button', class: 'option-card' + (p.mode === mode ? ' active' : ''), onclick: () => { p.mode = mode; applySettingsSoon(); draw(); } },
          h('span', { class: 'radio-dot' }), h('span', {}, h('b', {}, title), text));
        pane.append(h('h3', {}, 'Proxy'), h('p', { class: 'hint' }, 'Vale para todas as requisições do Mono, em qualquer ambiente.'),
          h('div', { class: 'option-cards' },
            card('system', 'Usar o proxy do sistema', 'Segue as configurações de proxy do Windows (inclui PAC/WPAD corporativo).'),
            card('custom', 'Proxy personalizado', 'Informe host e porta — HTTP, HTTPS ou SOCKS5.'),
            card('none', 'Sem proxy', 'Conecta direto, ignorando qualquer proxy.')));
        if (p.mode === 'custom') {
          const proto = h('select', {}, [['http', 'HTTP'], ['https', 'HTTPS'], ['socks5', 'SOCKS5']].map(([v, l]) => h('option', { value: v }, l)));
          proto.value = p.protocol;
          proto.addEventListener('change', () => { p.protocol = proto.value; applySettingsSoon(); });
          pane.append(h('div', { class: 'field-row proxy' }, h('div', { class: 'field' }, h('label', {}, 'Protocolo'), proto),
            field(p, 'host', 'Host', { ph: 'proxy.empresa.com.br' }), field(p, 'port', 'Porta', { ph: '8080' })));
          queueMicrotask(() => customSelect(proto));
          pane.append(check(p, 'auth', 'Proxy exige autenticação', 'usuário e senha enviados quando o proxy responder 407', draw));
          if (p.auth) pane.append(h('div', { class: 'field-row' }, field(p, 'username', 'Usuário', { ph: 'DOMINIO\\usuario' }), field(p, 'password', 'Senha', { type: 'password' })),
            h('p', { class: 'hint', style: 'margin-top:-4px' }, 'A senha é criptografada no disco pelo cofre do Windows.'));
          pane.append(field(p, 'bypass', 'Não usar proxy para', { ph: 'localhost, 127.0.0.1, *.interno.com.br' }));
        }
        const url = h('input', { class: 'input', value: 'https://www.google.com', spellcheck: 'false', style: 'flex:1' });
        const out = h('div', { class: 'test-result' });
        const testBtn = h('button', { class: 'btn-ghost', type: 'button' }, 'Testar conexão');
        testBtn.addEventListener('click', async () => {
          testBtn.disabled = true; out.textContent = 'Testando…';
          await api.applySettings?.(clone(st));
          const via = await api.resolveProxy?.(url.value);
          const res = await api.send({ method: 'GET', url: url.value, params: null, headers: [], body: { type: 'none' }, auth: { type: 'none' } }, {});
          out.textContent = `Rota: ${via?.ok ? (via.proxy === 'DIRECT' ? 'direto, sem proxy' : via.proxy) : '—'}\n` + (res.ok ? `Resposta: ${res.status} ${res.statusText || ''} em ${fmtTime(res.time)}` : `Falhou: ${res.error}`);
          testBtn.disabled = false;
        });
        pane.append(h('div', { class: 'label', style: 'margin-top:8px' }, 'Testar'), h('div', { class: 'row-actions', style: 'margin-top:6px' }, url, testBtn), out);
      } else if (section === 'ai') {
        const ai = st.ai;
        const out = h('div', { class: 'test-result' });
        const testBtn = h('button', { class: 'btn-ghost', type: 'button' }, 'Testar chave');
        testBtn.addEventListener('click', async () => {
          testBtn.disabled = true; out.textContent = 'Testando…';
          try { const j = await aiCall('Responda só JSON.', 'Responda exatamente {"ok":true}', 50); out.textContent = j.ok ? '✓ Chave funcionando' : 'Resposta inesperada'; }
          catch (e) { out.textContent = 'Falhou: ' + e.message; }
          testBtn.disabled = false;
        });
        const openai = ai.provider === 'openai';
        const card = (val, title, text) => h('button', { type: 'button', class: 'option-card' + ((ai.provider || 'anthropic') === val ? ' active' : ''), onclick: () => { ai.provider = val; applySettingsSoon(); draw(); } },
          h('span', { class: 'radio-dot' }), h('span', {}, h('b', {}, title), text));
        pane.append(h('h3', {}, 'IA (opcional)'),
          h('p', { class: 'hint' }, 'Com uma chave de IA, o Mono escreve resumos mais completos das APIs importadas e consegue ler documentações em formato livre (páginas que não são OpenAPI, apiDoc nem Postman).'),
          h('div', { class: 'option-cards two' },
            card('anthropic', 'Claude', 'Anthropic · chave sk-ant-…'),
            card('openai', 'ChatGPT', 'OpenAI · chave sk-…')),
          openai ? field(ai, 'openaiKey', 'Chave da API (OpenAI)', { type: 'password', ph: 'sk-…' }) : field(ai, 'apiKey', 'Chave da API (Anthropic)', { type: 'password', ph: 'sk-ant-…' }),
          openai ? field(ai, 'openaiModel', 'Modelo', { ph: 'gpt-5-mini' }) : field(ai, 'model', 'Modelo', { ph: 'claude-sonnet-5-5' }),
          h('div', { class: 'row-actions' }, testBtn), out,
          h('p', { class: 'hint' }, `As chaves ficam criptografadas no disco. Ao usar a IA, o texto da documentação e a lista de endpoints são enviados para a ${openai ? 'OpenAI' : 'Anthropic'} — os valores das suas variáveis e segredos não.`));
      } else if (section === 'about') {
        const status = h('div', { class: 'test-result' });
        const actions = h('div', { class: 'row-actions', style: 'margin-top:12px' });
        const show = (u) => {
          if (!status.isConnected && status.textContent) { updateListeners.delete(show); return; }
          status.textContent = updateText(u);
          actions.innerHTML = '';
          if (u.state === 'ready') actions.append(h('button', { class: 'btn-primary', type: 'button', onclick: () => api.installUpdate() }, `Reiniciar e instalar ${u.version}`));
          else if (u.state !== 'dev') actions.append(h('button', { class: 'btn-ghost', type: 'button', onclick: async () => { status.textContent = 'Procurando…'; const r = await api.checkUpdate(); if (!r.ok) status.textContent = r.error; } }, 'Procurar atualizações'));
        };
        pane.append(h('div', { class: 'about-head' }, h('div', { class: 'about-logo' }, 'mono'), h('div', {}, h('b', {}, `Versão ${lastUpdate.current || '—'}`), h('div', { class: 'muted small' }, 'Cliente de APIs REST e SOAP'))),
          h('h3', {}, 'Atualizações'), h('p', { class: 'hint' }, 'O Mono instalado procura versões novas no GitHub Releases ao abrir e a cada 4 horas, baixa em segundo plano e instala quando você reiniciar.'),
          status, actions);
        show(lastUpdate);
        updateListeners.add(show);
      } else if (section === 'certs') {
        const list = st.certs;
        pane.append(h('h3', {}, 'Certificados digitais (mTLS)'),
          h('p', { class: 'hint' }, 'Certificado do cliente em arquivo .pfx/.p12 (ex.: A1 da empresa) usado automaticamente nas requisições HTTPS para o host indicado — como os webservices da SEFAZ. A senha fica criptografada no disco.'));
        list.forEach((c, i) => pane.append(certCard(c, () => { applySettingsSoon(); }, () => { list.splice(i, 1); applySettingsSoon(); draw(); })));
        pane.append(h('div', { class: 'row-actions' }, h('button', { class: 'btn-ghost', type: 'button', onclick: () => { list.push({ host: '', path: '', name: '', passphrase: '', caPath: '', caName: '', enabled: true }); applySettingsSoon(); draw(); } }, '+ Adicionar certificado')),
          h('p', { class: 'hint' }, 'Servidores ICP-Brasil (SEFAZ) às vezes não são reconhecidos como confiáveis: nesse caso, informe a cadeia (CA) em "CA do servidor" ou desative a verificação SSL em Requisições. Proxy HTTP do sistema/personalizado é respeitado; proxy SOCKS não.'));
      } else if (section === 'postman') {
        const pmSt = st.postman;
        const out = h('div', { class: 'test-result' });
        const testBtn = h('button', { class: 'btn-ghost', type: 'button' }, 'Testar chave');
        testBtn.addEventListener('click', async () => {
          testBtn.disabled = true; out.textContent = 'Testando…';
          const r = await api.send({ method: 'GET', url: 'https://api.getpostman.com/me', params: null, headers: [{ key: 'X-API-Key', value: pmSt.apiKey, enabled: true }], body: { type: 'none' }, auth: { type: 'none' } }, {});
          let who = ''; try { const j = JSON.parse(r.body || '{}'); who = j.user ? ` (${j.user.username || j.user.fullName})` : ''; } catch { /* */ }
          out.textContent = r.ok && r.status === 200 ? '✓ Chave funcionando' + who : `Falhou: ${r.ok ? 'HTTP ' + r.status : r.error}`;
          testBtn.disabled = false;
        });
        pane.append(h('h3', {}, 'Postman'),
          h('p', { class: 'hint', html: 'Para importar direto de links do postman.com (<code>/workspace/…/collection/…</code>), o Mono usa a API oficial do Postman, que pede uma chave. Crie em <b>Postman › Settings › API Keys</b> (qualquer conta gratuita serve para coleções públicas).' }),
          field(pmSt, 'apiKey', 'Chave da API do Postman', { type: 'password', ph: 'PMAK-…' }),
          h('div', { class: 'row-actions' }, testBtn), out,
          h('p', { class: 'hint' }, 'A chave fica criptografada no disco e só é enviada para api.getpostman.com.'));
      } else {
        const r = st.request;
        const tm = h('input', { class: 'input', type: 'number', min: '1', value: Math.round(r.timeoutMs / 1000), style: 'width:120px' });
        tm.addEventListener('input', () => { r.timeoutMs = Math.max(1, Number(tm.value) || 30) * 1000; applySettingsSoon(); });
        pane.append(h('h3', {}, 'Requisições'), h('p', { class: 'hint' }, 'Comportamento padrão de todas as requisições.'),
          h('div', { class: 'field' }, h('label', {}, 'Tempo limite (segundos)'), tm),
          check(r, 'followRedirects', 'Seguir redirecionamentos', 'segue 301/302/307 automaticamente'),
          check(r, 'sslVerify', 'Verificar certificados SSL', 'desative só para ambientes internos com certificado próprio (HOM, DEV)'));
      }
    };
    body.append(h('h2', {}, 'Configurações'), h('p', { class: 'sub' }, 'Preferências globais — valem para todas as coleções e ambientes.'),
      h('div', { class: 'settings-layout' }, nav, pane),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn-primary', onclick: () => { close(); api.applySettings?.(clone(st)); } }, 'Concluir')));
    draw();
  });
  $('#modalBody').classList.add('wide');
}

// ---------- Layout: orientação e divisor ----------
// 'stack' = resposta embaixo · 'side' = resposta ao lado. Cada orientação guarda seu próprio tamanho.
const isSide = () => data.layout === 'side';
function applyLayout() {
  const ws = $('#workspace'), pane = $('#requestPane'), div = $('#divider');
  ws.classList.toggle('side', isSide());
  pane.style.height = isSide() ? '' : (data.split || 46) + '%';
  pane.style.width = isSide() ? (data.splitSide || 50) + '%' : '';
  div.title = 'Arraste para redimensionar · duplo clique para alternar a orientação';
  const btn = $('#layoutBtn');
  btn.title = isSide() ? 'Resposta embaixo (Ctrl Alt L)' : 'Resposta ao lado (Ctrl Alt L)';
  btn.classList.toggle('on', isSide());
}
function toggleLayout() {
  data.layout = isSide() ? 'stack' : 'side';
  applyLayout(); persist();
}
function initDivider() {
  const div = $('#divider'), pane = $('#requestPane'), ws = $('#workspace');
  applyLayout();
  div.addEventListener('dblclick', toggleLayout);
  div.addEventListener('mousedown', (e) => {
    e.preventDefault(); div.classList.add('drag');
    document.body.classList.add(isSide() ? 'resizing-x' : 'resizing-y');
    const rect = ws.getBoundingClientRect();
    const move = (ev) => {
      if (isSide()) {
        const pct = Math.min(75, Math.max(25, ((ev.clientX - rect.left) / rect.width) * 100));
        pane.style.width = pct + '%'; data.splitSide = Math.round(pct);
      } else {
        const pct = Math.min(80, Math.max(20, ((ev.clientY - rect.top) / rect.height) * 100));
        pane.style.height = pct + '%'; data.split = Math.round(pct);
      }
    };
    const up = () => { div.classList.remove('drag'); document.body.classList.remove('resizing-x', 'resizing-y'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); persist(); };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  });
}

// ---------- Eventos ----------
function bind() {
  $('#reqName').addEventListener('input', (e) => { activeTab().draft.name = e.target.value || 'Sem nome'; markDirty(); });
  initMethodMenu();
  $('#url').addEventListener('input', (e) => {
    const r = activeTab().draft;
    r.url = e.target.value; syncParamsFromUrl(r); markDirty(); updateCounts();
    if (reqTab === 'params') renderReqEditor();
  });
  $('#url').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  $('#url').addEventListener('paste', (e) => {
    const text = e.clipboardData.getData('text');
    if (/^\s*curl\s/i.test(text)) { e.preventDefault(); importCurl(text); }
  });
  $('#sendBtn').addEventListener('click', send);
  $('#wsBtn').addEventListener('click', (e) => openWorkspaceMenu(e.currentTarget));
  initVarFields();
  initUpdates();
  $('#saveBtn').addEventListener('click', saveActive);
  $('#curlBtn').addEventListener('click', () => openCodegen());
  $$('#reqTabs button').forEach((b) => b.addEventListener('click', () => { reqTab = b.dataset.rt; renderRequest(); }));
  $$('.sidebar .seg-btn').forEach((b) => b.addEventListener('click', () => { side = b.dataset.side; renderSidebar(); }));
  $('#sideSearch').addEventListener('input', renderSidebar);
  $('#newCollectionBtn').addEventListener('click', async () => {
    if (side === 'history') {
      if (data.history.length && await confirmModal({ title: 'Limpar histórico?', sub: `${data.history.length} envios serão apagados.`, ok: 'Limpar' })) { data.history = []; persist(); renderSidebar(); }
      return;
    }
    const o = await promptModal({ title: 'Nova coleção', label: 'Nome', value: '', ok: 'Criar' });
    if (o) { data.collections.push({ id: uid('col'), name: o.value, open: true, requests: [] }); persist(); renderSidebar(); }
  });
  $('#envSelect').addEventListener('change', (e) => { data.activeEnvId = e.target.value; persist(); renderProdBanner(); });
  $('#compareBtn').addEventListener('click', (e) => openCompareMenu(e.currentTarget));
  $('#settingsBtn').addEventListener('click', () => openSettings());
  $('#importSpecBtn').addEventListener('click', openImportApi);
  $('#envEditBtn').addEventListener('click', openEnvEditor);
  $('#layoutBtn').addEventListener('click', toggleLayout);
  $('#themeBtn').addEventListener('click', (e) => {
    const cur = data.theme || 'dark';
    showMenu(e.currentTarget, THEMES.map(([id, label]) => ({
      label: `${id === cur ? '✓' : '\u2002'}  ${label}`,
      run: () => { data.theme = id; applyTheme(); persist(); },
    })));
  });
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || !$('#modal').classList.contains('hidden')) return;
    const k = e.key.toLowerCase();
    if (e.altKey && k === 'l') { e.preventDefault(); toggleLayout(); }
    else if (k === 'enter') { e.preventDefault(); send(); }
    else if (k === 's') { e.preventDefault(); saveActive(); }
    else if (k === 't') { e.preventDefault(); openTab(newRequest()); }
    else if (k === 'w') { e.preventDefault(); closeTab(session().active); }
  });
}

// Importa um comando cURL colado na barra de URL (casos comuns: -X, -H, -d/--data*, -u).
function importCurl(cmd) {
  const tokens = [];
  const re = /'((?:[^'\\]|\\.|'\\'')*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  const src = cmd.replace(/\\\r?\n/g, ' ');
  while ((m = re.exec(src))) tokens.push(m[1] != null ? m[1].replace(/'\\''/g, "'") : m[2] != null ? m[2].replace(/\\"/g, '"') : m[3]);
  const r = activeTab().draft;
  r.headers = []; r.body = { type: 'none', raw: '', form: [] };
  let method = null;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-X' || t === '--request') method = tokens[++i];
    else if (t === '-H' || t === '--header') { const v = tokens[++i]; const j = v.indexOf(':'); r.headers.push({ key: v.slice(0, j).trim(), value: v.slice(j + 1).trim(), enabled: true }); }
    else if (/^(-d|--data|--data-raw|--data-binary)$/.test(t)) { const v = tokens[++i]; r.body.raw = v; r.body.type = /^\s*[\[{]/.test(v) ? 'json' : 'text'; }
    else if (t === '-u' || t === '--user') { const [u, ...p] = tokens[++i].split(':'); r.auth = { type: 'basic', username: u, password: p.join(':') }; }
    else if (!t.startsWith('-') && /^(https?:\/\/|[\w.-]+\.\w)/.test(t)) r.url = t;
  }
  r.method = (method || (r.body.raw ? 'POST' : 'GET')).toUpperCase();
  if (r.headers.some((x) => /^content-type$/i.test(x.key) && /json/i.test(x.value)) && r.body.raw) r.body.type = 'json';
  syncParamsFromUrl(r);
  markDirty(); renderTabs(); renderRequest();
  toast('cURL importado');
}

const THEMES = [['dark', 'Escuro'], ['light', 'Claro'], ['blue', 'Azul']];
function applyTheme() {
  if (!THEMES.some(([id]) => id === data.theme)) data.theme = 'dark';
  document.documentElement.dataset.theme = data.theme || 'dark';
  api.setTheme?.(data.theme || 'dark');
}

// ---------- {{variáveis}} em destaque com balão de edição ----------
function initVarFields() {
  const V = window.MonoVars;
  V.setProvider({
    resolve(name) {
      if (name[0] === '$') { const d = window.MonoSandbox?.dynamicVar(name); if (d !== undefined) return { scope: 'dynamic', value: d }; }
      const env = activeEnv(), col = tabCol(activeTab());
      const on = (v) => v.key === name && v.enabled !== false;
      const ev = env?.vars.find(on);
      if (ev) return { scope: 'environment', value: ev.value ?? '', holder: env.name, secret: !!ev.secret };
      const cv = col?.variables?.find(on);
      if (cv) return { scope: 'collection', value: cv.value ?? '', holder: col.name };
      const gv = globalsOf().vars.find(on);
      if (gv) return { scope: 'globals', value: gv.value ?? '', holder: '' };
      return { scope: null };
    },
    save(name, value, scope) {
      let list;
      if (scope === 'collection' && tabCol(activeTab())) { const col = tabCol(activeTab()); list = (col.variables ||= []); }
      else if (scope === 'globals') list = globalsOf().vars;
      else {
        let env = activeEnv();
        if (!env) { env = { id: uid('env'), name: 'Local', vars: [] }; data.environments.push(env); data.activeEnvId = env.id; renderEnvSelect(); }
        list = env.vars;
      }
      const v = list.find((x) => x.key === name);
      if (v) { v.value = value; v.enabled = true; } else list.push({ key: name, value, enabled: true, ...(scope === 'environment' && looksSecret(name) ? { secret: true } : {}) });
      persist();
    },
    scopes() {
      const env = activeEnv(), col = tabCol(activeTab());
      return [['environment', env ? `Ambiente "${env.name}"` : 'Novo ambiente "Local"'], ...(col ? [['collection', `Coleção "${col.name}"`]] : []), ['globals', 'Globais']];
    },
    openEnvironments: () => openEnvEditor(),
    // Lista para o autocompletar de {{ — ambiente vence coleção, que vence globais.
    list() {
      const env = activeEnv(), col = tabCol(activeTab());
      const seen = new Set(), out = [];
      const add = (vars, scope, holder) => { for (const v of vars || []) if (v.key && v.enabled !== false && !seen.has(v.key)) { seen.add(v.key); out.push({ name: v.key, value: v.value, scope, holder, secret: !!v.secret }); } };
      add(env?.vars, 'environment', env?.name);
      add(col?.variables, 'collection', col?.name);
      add(globalsOf().vars, 'globals', '');
      for (const n of window.MonoSandbox?.DYNAMIC_NAMES || []) out.push({ name: n, value: 'gerado a cada envio', scope: 'dynamic', holder: '' });
      return out;
    },
  });
  V.enhance($('#url'));
  V.watch($('#reqEditor'), '.kv input[type=text]');
}

// ---------- Início ----------
(async function init() {
  data = await api.load();
  ensureWorkspaces();
  if (!session().tabs.some((t) => t && t.draft)) session().tabs.push({ id: uid('tab'), ref: null, draft: newRequest({ name: 'Exemplo', url: '{{baseUrl}}/get?ola=mundo', params: [{ key: 'ola', value: 'mundo', enabled: true }] }), dirty: false });
  normalizeWorkspace();
  document.body.classList.add('platform-' + (api.platform || 'web'));
  applyTheme();
  renderEnvSelect();
  renderWorkspaceBtn();
  bind();
  cloudInit();
  liveInit();
  setInterval(monitorTick, 30000); setTimeout(monitorTick, 8000);
  $('#monAlert').addEventListener('click', () => openMonitors());
  renderMonAlert();
  mockInit();
  initDivider();
  renderTabs(); renderRequest(); renderResponse(); renderSidebar();
})();
})();
