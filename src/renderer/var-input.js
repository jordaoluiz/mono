// {{variáveis}} em destaque nos campos (URL, params, headers…), como no Postman:
// azul quando resolvida, vermelho quando não existe. Passar o mouse ou clicar abre um balão para ver e editar o valor.
(() => {
'use strict';
const { h, esc } = window.UI;
const VAR_RE = /\{\{\s*(\$?[\w.-]+)\s*\}\}/g;
const fields = new Set();
let provider = null; // { resolve(name), save(name, value, scope), scopes(), openEnvironments() }
let pop = null, popFor = null, hideTimer = null, showTimer = null;

const measureCtx = document.createElement('canvas').getContext('2d');
function charIndexAt(input, clientX) {
  const cs = getComputedStyle(input);
  const r = input.getBoundingClientRect();
  const x = clientX - r.left - parseFloat(cs.paddingLeft) - parseFloat(cs.borderLeftWidth) + input.scrollLeft;
  measureCtx.font = cs.font;
  const v = input.value;
  let lo = 0, hi = v.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (measureCtx.measureText(v.slice(0, mid + 1)).width <= x) lo = mid + 1; else hi = mid; }
  return lo;
}
function tokenAt(value, idx) {
  VAR_RE.lastIndex = 0;
  let m;
  while ((m = VAR_RE.exec(value))) if (idx >= m.index && idx < m.index + m[0].length) return { name: m[1], start: m.index, end: m.index + m[0].length };
  return null;
}
function stateOf(name) {
  if (!provider) return 'missing';
  const r = provider.resolve(name);
  return r.scope === 'dynamic' ? 'dyn' : r.scope ? 'ok' : 'missing';
}

function paint(f) {
  const v = f.input.value;
  let html = '', last = 0, m;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(v))) {
    html += esc(v.slice(last, m.index));
    html += `<span class="var-tok ${stateOf(m[1])}">${esc(m[0])}</span>`;
    last = VAR_RE.lastIndex;
  }
  html += esc(v.slice(last));
  f.inner.innerHTML = html;
  f.input.classList.toggle('has-vars', last > 0);
  sync(f);
}
const sync = (f) => { f.inner.style.transform = `translateX(${-f.input.scrollLeft}px)`; };

function enhance(input) {
  if (!input || input._monoVars || input.type === 'password' || input.style.webkitTextSecurity) return;
  input._monoVars = true;
  const focused = document.activeElement === input;
  const sel = focused ? [input.selectionStart, input.selectionEnd] : null;
  const cs = getComputedStyle(input);
  const wrap = h('div', { class: 'var-field' });
  if (parseFloat(cs.flexGrow) > 0) wrap.style.flex = '1 1 0';
  const back = h('div', { class: 'var-back', 'aria-hidden': 'true' });
  const inner = h('span', { class: 'var-inner' });
  back.append(inner);
  back.style.paddingLeft = `${parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth)}px`;
  back.style.font = cs.font;
  input.parentNode.insertBefore(wrap, input);
  wrap.append(back, input);
  input.classList.add('var-input');
  if (focused) { input.focus(); input.setSelectionRange(sel[0], sel[1]); }
  const f = { input, inner, wrap };
  fields.add(f);
  const repaint = () => paint(f);
  input.addEventListener('input', repaint);
  for (const ev of ['scroll', 'keyup', 'click', 'select', 'focus', 'blur']) input.addEventListener(ev, () => requestAnimationFrame(() => sync(f)));
  input.addEventListener('mousemove', (e) => {
    const t = tokenAt(input.value, charIndexAt(input, e.clientX));
    input.classList.toggle('over-var', !!t);
    if (pop && pop.pinned) return;
    clearTimeout(showTimer);
    if (t) { clearTimeout(hideTimer); if (!popFor || popFor.name !== t.name || popFor.input !== input) showTimer = setTimeout(() => open(input, t, false), 320); }
    else scheduleHide();
  });
  input.addEventListener('mouseleave', () => { clearTimeout(showTimer); input.classList.remove('over-var'); if (pop && !pop.pinned) scheduleHide(); });
  input.addEventListener('mouseup', (e) => {
    if (input.selectionStart !== input.selectionEnd) return;
    const t = tokenAt(input.value, charIndexAt(input, e.clientX));
    if (t) open(input, t, true);
  });
  attachComplete(input);
  repaint();
  return f;
}

// ---------- Autocompletar ao digitar {{ (como no Postman) ----------
let ac = null; // { input, el, items, sel, start }
function acClose() { if (ac) { ac.el.remove(); ac.detail.remove(); } ac = null; }
function acMatch(input) {
  const pos = input.selectionStart;
  if (pos !== input.selectionEnd) return null;
  const m = input.value.slice(0, pos).match(/\{\{\s*(\$?[\w.-]*)$/);
  return m ? { prefix: m[1], start: pos - m[0].length, pos } : null;
}
function acItems(prefix) {
  if (!provider || !provider.list) return [];
  const q = prefix.toLowerCase();
  const all = provider.list().filter((v) => (q.startsWith('$') ? v.scope === 'dynamic' : v.scope !== 'dynamic'));
  return all.filter((v) => v.name.toLowerCase().includes(q))
    .sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)) || (a.scope === 'dynamic') - (b.scope === 'dynamic') || a.name.localeCompare(b.name))
    .slice(0, 60);
}
const preview = (v) => (v.secret ? '••••••••' : v.value == null || v.value === '' ? '(vazio)' : String(v.value));
function acRender() {
  const { el, items } = ac;
  el.innerHTML = '';
  items.forEach((v, i) => {
    const [letter] = SCOPE_INFO[v.scope] || ['?'];
    el.append(h('div', { class: 'vac-opt' + (i === ac.sel ? ' active' : ''), role: 'option', onmousedown: (e) => { e.preventDefault(); ac.sel = i; acAccept(); }, onmousemove: () => { if (ac.sel !== i) { ac.sel = i; acHighlight(); } } },
      h('span', { class: 'vac-letter s-' + v.scope }, letter),
      h('span', { class: 'vac-text' }, h('span', { class: 'vac-name' }, v.name), h('span', { class: 'vac-val' }, preview(v)))));
  });
  acHighlight();
}
function acHighlight() {
  const { el, items, detail } = ac;
  [...el.children].forEach((c, i) => c.classList.toggle('active', i === ac.sel));
  const cur = el.children[ac.sel];
  if (cur) cur.scrollIntoView({ block: 'nearest' });
  const v = items[ac.sel];
  detail.innerHTML = '';
  if (!v) { detail.classList.add('hidden'); return; }
  const [, label] = SCOPE_INFO[v.scope] || ['', ''];
  detail.append(h('div', { class: 'vac-dval mono' }, preview(v)), h('div', { class: 'vac-dscope' }, label + (v.holder ? ' · ' + v.holder : '')));
  detail.classList.remove('hidden');
  const r = el.getBoundingClientRect();
  const cr = cur ? cur.getBoundingClientRect() : r;
  const left = r.right + 6 + 280 > innerWidth ? r.left - 286 : r.right + 6;
  detail.style.left = Math.max(8, left) + 'px';
  detail.style.top = Math.min(cr.top, innerHeight - detail.offsetHeight - 8) + 'px';
}
function acAccept() {
  if (!ac) return;
  const v = ac.items[ac.sel];
  const input = ac.input;
  if (!v) return acClose();
  const after = input.value.slice(ac.pos).match(/^[\w.$-]*\s*(\}\})?/)[0];
  const text = `{{${v.name}}}`;
  const end = ac.pos + after.length;
  input.focus();
  input.setSelectionRange(ac.start, end);
  if (!document.execCommand || !document.execCommand('insertText', false, text)) {
    input.setRangeText(text, ac.start, end, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  acClose();
}
function acOpen(input) {
  const m = acMatch(input);
  if (!m) return acClose();
  const items = acItems(m.prefix);
  if (!items.length) return acClose();
  if (!ac || ac.input !== input) {
    acClose();
    const el = h('div', { class: 'var-ac', role: 'listbox' });
    const detail = h('div', { class: 'var-ac-detail hidden' });
    document.body.append(el, detail);
    ac = { input, el, detail, items: [], sel: 0 };
  }
  const keep = ac.items[ac.sel] && items.findIndex((x) => x.name === ac.items[ac.sel].name && x.scope === ac.items[ac.sel].scope);
  Object.assign(ac, { items, start: m.start, pos: m.pos, sel: keep > 0 ? keep : 0 });
  close();
  // posição: abaixo do "{{"
  const cs = getComputedStyle(input);
  measureCtx.font = cs.font;
  const ir = input.getBoundingClientRect();
  const x = ir.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth) + measureCtx.measureText(input.value.slice(0, m.start)).width - input.scrollLeft;
  ac.el.style.left = Math.max(8, Math.min(x - 6, innerWidth - 300)) + 'px';
  const below = ir.bottom + 4;
  ac.el.style.top = below + 'px';
  ac.el.style.maxHeight = Math.max(140, Math.min(300, innerHeight - below - 12)) + 'px';
  acRender();
}
function attachComplete(input) {
  input.addEventListener('input', () => acOpen(input));
  input.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === ' ') { e.preventDefault(); const p = input.selectionStart; if (!acMatch(input)) { input.setRangeText('{{', p, p, 'end'); input.dispatchEvent(new Event('input', { bubbles: true })); } else acOpen(input); return; }
    if (!ac || ac.input !== input) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); ac.sel = (ac.sel + (e.key === 'ArrowDown' ? 1 : -1) + ac.items.length) % ac.items.length; acHighlight(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); acAccept(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); acClose(); }
  }, true);
  input.addEventListener('keyup', (e) => { if (/^Arrow(Left|Right)$|^Home$|^End$/.test(e.key)) { if (acMatch(input)) acOpen(input); else acClose(); } });
  input.addEventListener('click', () => { if (ac && ac.input === input && !acMatch(input)) acClose(); });
  input.addEventListener('blur', () => setTimeout(() => { if (ac && ac.input === input && document.activeElement !== input) acClose(); }, 120));
}
addEventListener('resize', () => acClose());

function scheduleHide() { clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (pop && !pop.pinned && !pop.el.matches(':hover')) close(); }, 220); }
function close() { if (pop) { pop.el.remove(); document.removeEventListener('mousedown', pop.outside, true); document.removeEventListener('keydown', pop.esc, true); } pop = null; popFor = null; }

const SCOPE_INFO = { environment: ['E', 'Ambiente'], collection: ['C', 'Coleção'], globals: ['G', 'Global'], dynamic: ['$', 'Dinâmica'] };
function open(input, tok, pinned) {
  if (!provider) return;
  if (pop && popFor && popFor.name === tok.name && popFor.input === input) {
    if (pinned) { pop.pinned = true; const vi = pop.el.querySelector('.vp-input'); if (vi) setTimeout(() => { vi.focus(); vi.select(); }, 0); }
    return;
  }
  close();
  const r = provider.resolve(tok.name);
  const el = h('div', { class: 'var-pop', role: 'dialog' });
  const refresh = () => { for (const f of [...fields]) { if (!f.input.isConnected) fields.delete(f); else paint(f); } };
  const head = h('div', { class: 'vp-head' }, h('code', { class: 'vp-name ' + (r.scope ? (r.scope === 'dynamic' ? 'dyn' : 'ok') : 'missing') }, `{{${tok.name}}}`));
  el.append(head);
  if (r.scope === 'dynamic') {
    el.append(h('p', { class: 'vp-text' }, 'Variável dinâmica: o Mono gera um valor novo a cada envio.'), h('div', { class: 'vp-sample mono' }, 'ex.: ' + r.value));
  } else if (r.scope) {
    const val = h('input', { class: 'input sm mono vp-input', value: r.value ?? '', spellcheck: 'false', type: r.secret ? 'password' : 'text' });
    const saved = h('span', { class: 'vp-saved' });
    const save = () => {
      if (val.value === (provider.resolve(tok.name).value ?? '')) return;
      provider.save(tok.name, val.value, r.scope);
      saved.textContent = '✓ salvo'; setTimeout(() => { saved.textContent = ''; }, 1400);
      refresh();
    };
    val.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); close(); input.focus(); } });
    val.addEventListener('change', save);
    val.addEventListener('focus', () => { if (pop) pop.pinned = true; });
    const [letter, label] = SCOPE_INFO[r.scope];
    el.append(h('div', { class: 'vp-row' }, val, r.secret ? h('button', { class: 'btn-text sm', type: 'button', title: 'Mostrar/ocultar', onclick: () => { val.type = val.type === 'password' ? 'text' : 'password'; } }, '👁') : null),
      h('div', { class: 'vp-foot' }, h('span', { class: 'vp-scope s-' + r.scope }, h('b', {}, letter), `${label}${r.holder ? ' · ' + r.holder : ''}`), saved,
        h('button', { class: 'btn-text sm', type: 'button', onclick: () => { close(); provider.openEnvironments(); } }, 'Ambientes →')));
    if (pinned) setTimeout(() => { val.focus(); val.select(); }, 0);
  } else {
    const scopes = provider.scopes();
    let scope = scopes[0] && scopes[0][0];
    const val = h('input', { class: 'input sm mono vp-input', placeholder: 'valor', spellcheck: 'false' });
    const chips = h('div', { class: 'vp-chips' });
    const drawChips = () => { chips.innerHTML = ''; for (const [k, l] of scopes) chips.append(h('button', { type: 'button', class: 'chip' + (scope === k ? ' active' : ''), onclick: () => { scope = k; drawChips(); } }, l)); };
    drawChips();
    const create = () => { provider.save(tok.name, val.value, scope, true); refresh(); close(); input.focus(); };
    val.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
    val.addEventListener('focus', () => { if (pop) pop.pinned = true; });
    el.append(h('p', { class: 'vp-text warn' }, 'Variável não definida — o texto vai literal na requisição.'),
      h('div', { class: 'vp-label' }, 'Criar em'), chips,
      h('div', { class: 'vp-row' }, val, h('button', { class: 'btn-primary sm', type: 'button', onclick: create }, 'Criar')));
    if (pinned) setTimeout(() => val.focus(), 0);
  }
  document.body.append(el);
  // posição: logo abaixo da variável
  const cs = getComputedStyle(input);
  measureCtx.font = cs.font;
  const ir = input.getBoundingClientRect();
  const x = ir.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth) + measureCtx.measureText(input.value.slice(0, tok.start)).width - input.scrollLeft;
  const w = el.offsetWidth;
  el.style.left = Math.max(8, Math.min(x - 8, innerWidth - w - 8)) + 'px';
  const below = ir.bottom + 6;
  el.style.top = (below + el.offsetHeight > innerHeight - 8 ? ir.top - el.offsetHeight - 6 : below) + 'px';
  el.addEventListener('mouseleave', () => { if (pop && !pop.pinned) scheduleHide(); });
  el.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  const outside = (e) => { if (!el.contains(e.target) && e.target !== input) close(); };
  const escK = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); input.focus(); } };
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', escK, true);
  pop = { el, pinned, outside, esc: escK };
  popFor = { name: tok.name, input };
}

function refreshAll() { for (const f of [...fields]) { if (!f.input.isConnected) fields.delete(f); else paint(f); } }
// Observa um container e realça os campos que aparecerem (as tabelas se redesenham sozinhas).
function watch(root, selector) {
  const run = () => root.querySelectorAll(selector).forEach(enhance);
  new MutationObserver(run).observe(root, { childList: true, subtree: true });
  run();
}

window.MonoVars = { enhance, watch, refresh: refreshAll, setProvider: (p) => { provider = p; refreshAll(); }, close };
})();
