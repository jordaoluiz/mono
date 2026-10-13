// Utilitários de interface (sem dependências).
(() => {
'use strict';

// Nunca renderizar "null"/"undefined"/"false" como texto: append/prepend ignoram valores vazios.
// (Corrige casos como `body.append(cond ? h(...) : null)` em qualquer tela.)
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  for (const fn of ['append', 'prepend']) {
    const orig = proto[fn];
    proto[fn] = function (...nodes) { return orig.apply(this, nodes.filter((n) => n != null && n !== false)); };
  }
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = (p = 'id') => `${p}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}

const icons = {
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.5"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
};

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
function fmtTime(ms) { return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`; }

// Realce de JSON em tons de cinza (trabalha sobre texto já formatado).
function highlightJson(text) {
  return esc(text).replace(
    /(&quot;(?:\\.|[^\\])*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}\[\],])/g,
    (m, str, colon, lit, num, punc) => {
      if (str) return colon ? `<span class="j-key">${str}</span><span class="j-punc">${colon}</span>` : `<span class="j-str">${str}</span>`;
      if (lit) return `<span class="j-lit">${lit}</span>`;
      if (num) return `<span class="j-num">${num}</span>`;
      return `<span class="j-punc">${punc}</span>`;
    });
}

// Tabela chave/valor editável; sempre mantém uma linha vazia no fim.
function kvTable(rows, onChange, { keyPh = 'Chave', valPh = 'Valor', secret = false } = {}) {
  const ensureTail = () => {
    const last = rows[rows.length - 1];
    if (!last || last.key || last.value) rows.push({ key: '', value: '', enabled: true });
  };
  ensureTail();
  const table = h('table', { class: 'kv' });
  const render = () => {
    table.innerHTML = '';
    table.append(h('tr', {}, h('th', {}), h('th', {}, keyPh), h('th', {}, valPh), secret ? h('th', {}) : null, h('th', {})));
    rows.forEach((r, i) => {
      const isTail = i === rows.length - 1;
      const tr = h('tr', { class: r.enabled === false ? 'off' : '' });
      const chk = h('input', { type: 'checkbox', checked: r.enabled !== false, disabled: isTail, onchange: (e) => { r.enabled = e.target.checked; tr.className = r.enabled ? '' : 'off'; onChange(); } });
      const k = h('input', { type: 'text', value: r.key, placeholder: isTail ? `+ ${keyPh}` : '', spellcheck: 'false' });
      const v = h('input', { type: 'text', value: r.value, placeholder: isTail ? valPh : '', spellcheck: 'false' });
      if (r.secret) v.style.webkitTextSecurity = 'disc';
      const onInput = () => {
        r.key = k.value; r.value = v.value;
        if (isTail && (r.key || r.value)) {
          const inVal = document.activeElement === v, caret = (inVal ? v : k).selectionStart;
          ensureTail(); onChange(); render();
          const el = $$('input[type=text]', table)[i * 2 + (inVal ? 1 : 0)];
          if (el) { el.focus(); el.setSelectionRange(caret, caret); el.dispatchEvent(new Event('input', { bubbles: false })); }
          return;
        }
        onChange();
      };
      k.addEventListener('input', onInput); v.addEventListener('input', onInput);
      tr.append(h('td', { class: 'chk' }, chk), h('td', {}, k), h('td', {}, v));
      if (secret) {
        const lockBtn = h('button', { class: 'lock' + (r.secret ? ' on' : ''), title: 'Segredo: criptografado no disco pelo sistema', html: icons.lock, onclick: () => { r.secret = !r.secret; onChange(); render(); } });
        tr.append(h('td', { class: 'act' }, isTail ? null : lockBtn));
      }
      tr.append(h('td', { class: 'act' }, isTail ? null : h('button', { class: 'del', title: 'Remover', html: icons.x, onclick: () => { rows.splice(i, 1); ensureTail(); onChange(); render(); } })));
      table.append(tr);
    });
  };
  render();
  return table;
}

// Select personalizado: mantém o <select> nativo escondido como fonte da verdade
// (value e evento 'change' continuam funcionando) e desenha um menu no estilo do app.
const CHEV = '<svg class="cs-chev" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
let openSelect = null;
function customSelect(sel, { variant = 'field' } = {}) {
  if (sel._cs) return sel._cs;
  sel.classList.add('cs-native');
  sel.tabIndex = -1;
  const label = h('span', { class: 'cs-label' });
  const btn = h('button', { type: 'button', class: `cs-btn cs-${variant}`, 'aria-haspopup': 'listbox', 'aria-expanded': 'false', html: CHEV });
  btn.prepend(label);
  sel.after(btn);
  // Remove menus de selects que já saíram da tela (a resposta é redesenhada a cada envio).
  for (const m of document.querySelectorAll('.cs-menu')) if (m._owner && !m._owner.isConnected) m.remove();
  const menu = h('div', { class: 'method-menu cs-menu hidden', role: 'listbox', tabindex: '-1' });
  menu._owner = sel;
  document.body.append(menu);
  let items = [], idx = 0;

  const sync = () => {
    const o = sel.options[sel.selectedIndex];
    label.textContent = o ? o.textContent : '';
    btn.title = label.textContent;
  };
  const close = (focus = true) => {
    menu.classList.add('hidden'); btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', outside, true);
    if (openSelect === api) openSelect = null;
    if (focus) btn.focus();
  };
  const outside = (e) => { if (!menu.contains(e.target) && !btn.contains(e.target)) close(false); };
  const hl = (i) => {
    if (!items.length) return;
    idx = (i + items.length) % items.length;
    items.forEach((el, j) => el.classList.toggle('kb', j === idx));
    items[idx].scrollIntoView({ block: 'nearest' });
  };
  const pick = (i) => {
    const o = sel.options[i];
    if (!o) return;
    if (sel.selectedIndex !== i) { sel.selectedIndex = i; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    sync(); close();
  };
  const open = () => {
    if (openSelect && openSelect !== api) openSelect.close(false);
    menu.innerHTML = '';
    items = [...sel.options].map((o, i) => h('div', {
      class: 'mm-item cs-item' + (i === sel.selectedIndex ? ' selected' : '') + (o.value === '' ? ' cs-empty' : ''),
      role: 'option', 'aria-selected': String(i === sel.selectedIndex),
      onmousedown: (e) => e.preventDefault(), onclick: () => pick(i), onmousemove: () => hl(i),
    }, h('span', { class: 'cs-text' }, o.textContent), h('span', { class: 'mm-check', html: CHECK })));
    if (!items.length) menu.append(h('div', { class: 'cs-none' }, 'Nenhuma opção'));
    menu.append(...items);
    const r = btn.getBoundingClientRect();
    menu.style.minWidth = Math.max(r.width, 180) + 'px';
    menu.style.width = 'auto';
    menu.classList.remove('hidden');
    const w = menu.offsetWidth, hgt = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
    menu.style.top = (r.bottom + 6 + hgt > innerHeight - 8 ? Math.max(8, r.top - hgt - 6) : r.bottom + 6) + 'px';
    btn.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
    hl(Math.max(0, sel.selectedIndex));
    menu.focus();
    openSelect = api;
    document.addEventListener('mousedown', outside, true);
  };
  btn.addEventListener('click', () => (menu.classList.contains('hidden') ? open() : close()));
  btn.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key) && menu.classList.contains('hidden')) { e.preventDefault(); open(); }
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); hl(idx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hl(idx - 1); }
    else if (e.key === 'Home') { e.preventDefault(); hl(0); }
    else if (e.key === 'End') { e.preventDefault(); hl(items.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(idx); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      const L = e.key.toLowerCase();
      for (let k = 1; k <= items.length; k++) { const j = (idx + k) % items.length; if (sel.options[j].textContent.trim().toLowerCase().startsWith(L)) { hl(j); break; } }
    }
  });
  sel.addEventListener('change', sync);
  new MutationObserver(sync).observe(sel, { childList: true, subtree: true, characterData: true });
  addEventListener('resize', () => { if (!menu.classList.contains('hidden')) close(false); });
  const api = { sync, open, close, button: btn };
  sel._cs = api;
  sync();
  return api;
}

// Botão só com ícone de copiar; troca para ✓ por um instante ao copiar.
function copyButton(getText, title = 'Copiar') {
  const btn = h('button', { class: 'icon-btn copy-btn', type: 'button', title, 'aria-label': title, html: icons.copy });
  btn.addEventListener('click', async () => {
    await window.mono.copy(typeof getText === 'function' ? getText() : getText);
    btn.innerHTML = icons.check; btn.classList.add('done');
    setTimeout(() => { btn.innerHTML = icons.copy; btn.classList.remove('done'); }, 1200);
  });
  return btn;
}

function toast(msg, ms = 1800) {
  const t = h('div', { class: 'toast' }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

function openModal(build) {
  const back = $('#modal'), body = $('#modalBody');
  body.innerHTML = '';
  body.className = 'modal';
  const close = () => { back.classList.add('hidden'); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  build(body, close);
  back.classList.remove('hidden');
  back.onclick = (e) => { if (e.target === back) close(); };
  document.addEventListener('keydown', onKey);
  setTimeout(() => $('input, textarea, select', body)?.focus(), 0);
  return close;
}

function promptModal({ title, sub, label, value = '', ok = 'Confirmar', extra }) {
  return new Promise((resolve) => {
    openModal((body, close) => {
      const input = h('input', { value, spellcheck: 'false' });
      const extraEl = extra ? extra() : null;
      const done = (val) => { close(); resolve(val); };
      const submit = () => { const v = input.value.trim(); if (v) done({ value: v, extra: extraEl?.getValue?.() }); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      body.append(
        h('h2', {}, title), sub ? h('p', { class: 'sub' }, sub) : null,
        h('div', { class: 'field' }, h('label', {}, label), input),
        extraEl,
        h('div', { class: 'modal-actions' },
          h('button', { class: 'btn-ghost', onclick: () => done(null) }, 'Cancelar'),
          h('button', { class: 'btn-primary', onclick: submit }, ok)),
      );
      setTimeout(() => { input.focus(); input.select(); }, 0);
    });
  });
}

function confirmModal({ title, sub, ok = 'Excluir' }) {
  return new Promise((resolve) => {
    openModal((body, close) => {
      const done = (v) => { close(); resolve(v); };
      body.append(h('h2', {}, title), h('p', { class: 'sub' }, sub),
        h('div', { class: 'modal-actions' },
          h('button', { class: 'btn-ghost', onclick: () => done(false) }, 'Cancelar'),
          h('button', { class: 'btn-primary', onclick: () => done(true) }, ok)));
    });
  });
}

function showMenu(anchor, items) {
  const menu = $('#menu');
  menu.innerHTML = '';
  for (const it of items) menu.append(it === '-' ? h('hr') : h('button', { onclick: () => { hide(); it.run(); } }, it.label));
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.min(r.left, innerWidth - 180) + 'px';
  menu.style.top = r.bottom + 4 + 'px';
  menu.classList.remove('hidden');
  const hide = () => { menu.classList.add('hidden'); document.removeEventListener('mousedown', out); };
  const out = (e) => { if (!menu.contains(e.target)) hide(); };
  setTimeout(() => document.addEventListener('mousedown', out), 0);
}

window.UI = { $, $$, uid, esc, h, icons, fmtBytes, fmtTime, highlightJson, kvTable, toast, openModal, promptModal, confirmModal, showMenu, customSelect, copyButton };
})();
