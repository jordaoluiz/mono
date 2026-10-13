// Autorização no padrão Postman: seletor de tipo à esquerda, campos à direita.
// Usado na aba Auth da requisição e no modal de autorização de pastas e coleções.
(() => {
'use strict';
const { h, toast } = window.UI;

const I = {
  inherit: '<svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
  none: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="m6 18 12-12"/></svg>',
  bearer: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M10 8h3a2 2 0 0 1 0 4h-3zm0 4h3.5a2 2 0 0 1 0 4H10z"/></svg>',
  basic: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>',
  apikey: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.2-8.2M16 7l2.5 2.5M14 9l2 2"/></svg>',
  oauth2: '<svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.5 3 8.4 7 10 4-1.6 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/></svg>',
  chev: '<svg class="cs-chev" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
};

const TYPES = [
  { id: 'inherit', label: 'Herdar do pai', desc: 'Usa a autorização definida na pasta ou na coleção.' },
  { id: 'none', label: 'Sem autenticação', desc: 'Nenhum header de autorização é enviado.' },
  { id: 'bearer', label: 'Bearer Token', desc: 'Envia "Authorization: Bearer <token>".' },
  { id: 'basic', label: 'Basic Auth', desc: 'Envia usuário e senha codificados em Base64.' },
  { id: 'apikey', label: 'API Key', desc: 'Envia uma chave num header ou na query string.' },
  { id: 'oauth2', label: 'OAuth 2.0', desc: 'Obtém um access token no servidor de autorização e o envia como Bearer.' },
];
const byId = (id) => TYPES.find((t) => t.id === id) || TYPES[1];
const describe = (auth) => byId(auth?.type || 'none').label;

function normalize(a) {
  a.type ||= 'none';
  if (a.type === 'apikey') { a.in ||= 'header'; a.key ??= ''; a.value ??= ''; }
  if (a.type === 'oauth2') {
    a.oauth2 ||= {};
    const o = a.oauth2;
    o.grant ||= 'client_credentials'; o.clientAuth ||= 'body';
    for (const k of ['tokenUrl', 'clientId', 'clientSecret', 'scope', 'username', 'password']) o[k] ??= '';
  }
  return a;
}

// ---------- Seletor de tipo ----------
function openPicker(anchor, current, allowInherit, inheritedLabel, onPick) {
  document.querySelector('.auth-menu')?.remove();
  const menu = h('div', { class: 'method-menu auth-menu', role: 'listbox', tabindex: '-1' });
  const items = [];
  const add = (t) => {
    const el = h('div', { class: 'mm-item' + (t.id === current ? ' selected' : ''), role: 'option',
      onmousedown: (e) => e.preventDefault(), onclick: () => { close(); onPick(t.id); } },
    h('span', { class: 'mm-icon', html: I[t.id] }),
    h('span', { class: 'cs-text' }, t.label),
    t.id === 'inherit' && inheritedLabel ? h('span', { class: 'mm-desc', style: 'flex:none' }, inheritedLabel) : null,
    h('span', { class: 'mm-check', html: I.check }));
    items.push(el); menu.append(el);
  };
  if (allowInherit) { menu.append(h('div', { class: 'mm-group' }, 'Herança')); add(TYPES[0]); menu.append(h('div', { class: 'mm-sep' })); }
  add(TYPES[1]);
  menu.append(h('div', { class: 'mm-sep' }), h('div', { class: 'mm-group' }, 'Tipos'));
  for (const t of TYPES.slice(2)) add(t);
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.width = Math.max(r.width, 300) + 'px';
  menu.style.left = r.left + 'px';
  menu.style.top = Math.min(r.bottom + 6, innerHeight - menu.offsetHeight - 8) + 'px';
  let idx = Math.max(0, items.findIndex((el) => el.classList.contains('selected')));
  const hl = (i) => { idx = (i + items.length) % items.length; items.forEach((el, j) => el.classList.toggle('kb', j === idx)); };
  hl(idx);
  menu.focus();
  const close = () => { menu.remove(); document.removeEventListener('mousedown', out, true); anchor.classList.remove('open'); anchor.focus(); };
  const out = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(); };
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); hl(idx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hl(idx - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); items[idx].click(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  anchor.classList.add('open');
  setTimeout(() => document.addEventListener('mousedown', out, true), 0);
}

// ---------- OAuth 2.0 ----------
function tokenStatus(o) {
  if (!o.accessToken) return { cls: 'none', text: 'Nenhum token obtido ainda' };
  if (!o.expiresAt) return { cls: 'ok', text: 'Token ativo (sem prazo informado)' };
  const ms = o.expiresAt - Date.now();
  if (ms <= 0) return { cls: 'bad', text: 'Token expirado' };
  const min = Math.round(ms / 60000);
  return { cls: ms < 120000 ? 'warn' : 'ok', text: min >= 60 ? `Expira em ${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}` : `Expira em ${Math.max(1, min)} min` };
}
async function fetchToken(o, vars) {
  if (!o.tokenUrl) throw new Error('Informe a URL do token.');
  const form = [{ key: 'grant_type', value: o.grant, enabled: true }];
  if (o.scope) form.push({ key: 'scope', value: o.scope, enabled: true });
  if (o.grant === 'password') form.push({ key: 'username', value: o.username, enabled: true }, { key: 'password', value: o.password, enabled: true });
  const headers = [{ key: 'Accept', value: 'application/json', enabled: true }];
  let auth = { type: 'none' };
  if (o.clientAuth === 'header') auth = { type: 'basic', username: o.clientId, password: o.clientSecret };
  else form.push({ key: 'client_id', value: o.clientId, enabled: true }, { key: 'client_secret', value: o.clientSecret, enabled: true });
  const res = await window.mono.send({ method: 'POST', url: o.tokenUrl, params: null, headers, body: { type: 'form', form }, auth }, vars);
  if (!res.ok) throw new Error(res.error);
  let j;
  try { j = JSON.parse(res.body || ''); } catch { throw new Error(`Resposta ${res.status} sem JSON do servidor de token.`); }
  if (res.status >= 400 || !j.access_token) throw new Error(j.error_description || j.error || `O servidor respondeu ${res.status} sem access_token.`);
  o.accessToken = j.access_token;
  o.tokenType = /^bearer$/i.test(j.token_type || '') || !j.token_type ? 'Bearer' : j.token_type;
  o.expiresAt = j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : null;
  if (j.refresh_token) o.refreshToken = j.refresh_token;
  return o;
}
// Antes de enviar: renova o token OAuth se estiver ausente ou expirado (quando dá para fazer sem interação).
async function ensureFresh(auth, vars) {
  if (!auth || auth.type !== 'oauth2') return false;
  const o = normalize(auth).oauth2;
  const expired = !o.accessToken || (o.expiresAt && o.expiresAt - Date.now() < 15000);
  if (!expired || !o.tokenUrl || !o.clientId) return false;
  try { await fetchToken(o, vars); toast('Token OAuth renovado'); return true; }
  catch (e) { toast('Não foi possível renovar o token: ' + e.message, 3600); return false; }
}

// ---------- Editor ----------
// opts: { onChange, allowInherit, inherited: { auth, fromName } | null, vars: () => obj, onEditParent }
function editor(auth, opts) {
  normalize(auth);
  const root = h('div', { class: 'auth-layout' });
  const draw = () => {
    root.innerHTML = '';
    const t = byId(auth.type);
    const inhLabel = opts.inherited ? describe(opts.inherited.auth) : null;
    const btn = h('button', { class: 'cs-btn cs-field auth-type', type: 'button', onclick: () => openPicker(btn, auth.type, opts.allowInherit, inhLabel, (id) => { auth.type = id; normalize(auth); opts.onChange(); draw(); }) },
      h('span', { class: 'mm-icon', html: I[t.id] }), h('span', { class: 'cs-label' }, t.label), h('span', { html: I.chev, style: 'display:contents' }));
    const left = h('div', { class: 'auth-side' }, h('div', { class: 'label' }, 'Tipo de autenticação'), btn, h('p', { class: 'hint' }, t.desc));
    root.append(left, h('div', { class: 'auth-main' }, fields(t.id)));
  };
  const input = (obj, key, label, { type = 'text', ph = '' } = {}) => {
    const inp = h('input', { class: 'input mono', type, value: obj[key] || '', placeholder: ph, spellcheck: 'false' });
    inp.addEventListener('input', () => { obj[key] = inp.value; opts.onChange(); });
    return h('div', { class: 'field' }, h('label', {}, label), inp);
  };
  const seg = (obj, key, options, redraw) => h('div', { class: 'seg sm' }, options.map(([v, l]) =>
    h('button', { class: 'seg-btn' + (obj[key] === v ? ' active' : ''), type: 'button', onclick: () => { obj[key] = v; opts.onChange(); redraw(); } }, l)));
  const empty = (icon, title, text, extra) => h('div', { class: 'empty-state' }, h('div', { class: 'es-icon', html: icon }), h('strong', {}, title), h('span', {}, text), extra);

  function fields(type) {
    if (type === 'none') return empty(I.none, 'Sem autenticação', 'Esta requisição não usa autorização.');
    if (type === 'inherit') {
      const inh = opts.inherited;
      if (!inh) return empty(I.inherit, 'Nada para herdar', 'Salve a requisição numa coleção para herdar a autorização dela.');
      const resolved = inh.auth && inh.auth.type !== 'none';
      return empty(I[inh.auth?.type] || I.inherit, resolved ? `Herdando ${describe(inh.auth)}` : 'O pai não usa autenticação',
        h('span', {}, 'Definido em ', h('b', {}, inh.fromName), '.'),
        opts.onEditParent ? h('button', { class: 'btn-ghost sm', type: 'button', style: 'margin-top:6px', onclick: opts.onEditParent }, `Editar em ${inh.fromName}`) : null);
    }
    const box = h('div', { class: 'auth-fields' });
    if (type === 'bearer') box.append(input(auth, 'token', 'Token', { ph: '{{token}}' }));
    if (type === 'basic') box.append(input(auth, 'username', 'Usuário', { ph: '{{usuario}}' }), input(auth, 'password', 'Senha', { type: 'password', ph: '{{senha}}' }));
    if (type === 'apikey') {
      const redraw = () => { box.replaceWith(fields('apikey')); };
      box.append(input(auth, 'key', 'Chave', { ph: 'x-api-key' }), input(auth, 'value', 'Valor', { ph: '{{apiKey}}' }),
        h('div', { class: 'field' }, h('label', {}, 'Adicionar em'), seg(auth, 'in', [['header', 'Header'], ['query', 'Query params']], redraw)));
    }
    if (type === 'oauth2') {
      const o = auth.oauth2;
      const redraw = () => { const n = fields('oauth2'); box.replaceWith(n); };
      const st = tokenStatus(o);
      const getBtn = h('button', { class: 'btn-primary', type: 'button', style: 'height:32px' }, 'Obter novo token');
      getBtn.addEventListener('click', async () => {
        getBtn.disabled = true; getBtn.textContent = 'Obtendo…';
        try { await fetchToken(o, opts.vars()); opts.onChange(); toast('Token obtido'); redraw(); }
        catch (e) { toast(e.message, 4200); getBtn.disabled = false; getBtn.textContent = 'Obter novo token'; }
      });
      box.append(
        h('div', { class: 'token-box ' + st.cls },
          h('div', { class: 'token-head' }, h('span', { class: 'flag ' + (st.cls === 'none' ? '' : st.cls) }, st.text), h('div', { class: 'grow' }),
            o.accessToken ? h('button', { class: 'btn-text', type: 'button', onclick: () => { delete o.accessToken; delete o.expiresAt; delete o.refreshToken; opts.onChange(); redraw(); } }, 'Limpar') : null, getBtn),
          o.accessToken ? h('code', { class: 'token-value', title: 'Clique para copiar', onclick: () => window.mono.copy(o.accessToken).then(() => toast('Token copiado')) }, o.accessToken) : null),
        h('div', { class: 'field' }, h('label', {}, 'Tipo de concessão'), seg(o, 'grant', [['client_credentials', 'Client Credentials'], ['password', 'Password']], redraw)),
        input(o, 'tokenUrl', 'URL do token', { ph: 'https://auth.exemplo.com/oauth/token' }),
        h('div', { class: 'field-row' }, input(o, 'clientId', 'Client ID', { ph: '{{clientId}}' }), input(o, 'clientSecret', 'Client Secret', { type: 'password', ph: '{{clientSecret}}' })),
        o.grant === 'password' ? h('div', { class: 'field-row' }, input(o, 'username', 'Usuário'), input(o, 'password', 'Senha', { type: 'password' })) : null,
        input(o, 'scope', 'Escopo', { ph: 'opcional · ex.: api.read api.write' }),
        h('div', { class: 'field' }, h('label', {}, 'Credenciais do cliente'), seg(o, 'clientAuth', [['body', 'No corpo'], ['header', 'Header Basic']], redraw)),
        h('p', { class: 'hint' }, 'Tokens expirados são renovados automaticamente antes do envio. Guarde o Client Secret como segredo num ambiente e use {{clientSecret}}.'));
    }
    if (type !== 'oauth2') box.append(h('p', { class: 'hint', html: 'Dica: use variáveis como <code>{{token}}</code> e marque-as como <b>segredo</b> no ambiente — elas são criptografadas no disco.' }));
    return box;
  }
  draw();
  return root;
}

window.MonoAuth = { editor, describe, normalize, ensureFresh, fetchToken, TYPES };
})();
