// Aba Scripts no padrão do Postman: "Antes da requisição" e "Após a resposta",
// editor com números de linha, cores de sintaxe, autocompletar de pm.* e Snippets.
(() => {
'use strict';
const { h, esc, openModal } = window.UI;

// ---------- Cores de sintaxe (JavaScript) ----------
const KW = new Set('const let var function return if else for while do new try catch finally throw typeof instanceof in of async await class extends break continue switch case default delete void yield import export from'.split(' '));
const LIT = new Set(['true', 'false', 'null', 'undefined', 'this', 'NaN', 'Infinity']);
const GLOBALS = new Set(['pm', 'console', 'JSON', 'postman', 'Math', 'Date', 'Object', 'Array', 'String', 'Number', 'Promise', 'crypto', 'require']);
const TOKEN_RE = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|(`(?:\\[\s\S]|[^`\\])*`?|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)|(\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|([A-Za-z_$][\w$]*)/g;
function highlightJs(src) {
  let out = '', last = 0, m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(src))) {
    out += esc(src.slice(last, m.index));
    const [t] = m;
    if (m[1]) out += `<span class="c-com">${esc(t)}</span>`;
    else if (m[2]) out += `<span class="c-str">${esc(t)}</span>`;
    else if (m[3]) out += `<span class="c-num">${t}</span>`;
    else if (KW.has(t)) out += `<span class="c-kw">${t}</span>`;
    else if (LIT.has(t)) out += `<span class="c-lit">${t}</span>`;
    else if (GLOBALS.has(t)) out += `<span class="c-glob">${t}</span>`;
    else if (/^\s*\(/.test(src.slice(TOKEN_RE.lastIndex, TOKEN_RE.lastIndex + 4))) out += `<span class="c-fn">${t}</span>`;
    else if (src[m.index - 1] === '.') out += `<span class="c-prop">${t}</span>`;
    else out += esc(t);
    last = TOKEN_RE.lastIndex;
  }
  return out + esc(src.slice(last));
}

// ---------- Autocompletar ----------
const SCOPE = { get: 'get(nome)', set: 'set(nome, valor)', unset: 'unset(nome)', has: 'has(nome)', clear: 'clear()', toObject: 'toObject()', replaceIn: 'replaceIn(texto)' };
const PLIST = { get: 'get(nome)', has: 'has(nome)', add: 'add({ key, value })', upsert: 'upsert({ key, value })', remove: 'remove(nome)', toObject: 'toObject()', each: 'each(fn)', all: 'all()', count: 'count()' };
const ASSERT = {
  be: 'cadeia', have: 'cadeia', not: 'nega', equal: 'equal(valor)', eql: 'eql(valor)', include: 'include(valor)', property: 'property(nome[, valor])', lengthOf: 'lengthOf(n)',
  above: 'above(n)', below: 'below(n)', least: 'least(n)', most: 'most(n)', within: 'within(min, max)', a: "a('tipo')", an: "an('tipo')", oneOf: 'oneOf([...])',
  match: 'match(/regex/)', keys: 'keys(...)', members: 'members([...])', contain: 'contain(valor)', string: 'string(trecho)', jsonSchema: 'jsonSchema(schema)', closeTo: 'closeTo(v, delta)', satisfy: 'satisfy(fn)', throw: 'throw()',
  ok: 'truthy', true: 'true', false: 'false', null: 'null', undefined: 'undefined', exist: 'não nulo', empty: 'vazio',
  to: 'cadeia', deep: 'comparação profunda', nested: 'caminho a.b', own: 'própria', any: 'qualquer', all: 'todas', is: 'cadeia', that: 'cadeia', which: 'cadeia', and: 'cadeia', has: 'cadeia', with: 'cadeia', been: 'cadeia',
};
const RES_HAVE = { status: 'status(200)', header: "header('Nome'[, valor])", body: 'body(texto)', jsonBody: "jsonBody('caminho'[, valor])", jsonSchema: 'jsonSchema(schema)' };
const RES_BE = { ok: '200', success: '2xx', error: '4xx/5xx', clientError: '4xx', serverError: '5xx', notFound: '404', unauthorized: '401', forbidden: '403', badRequest: '400', json: 'JSON', html: 'HTML', xml: 'XML', withBody: 'tem corpo' };
const RES_TO = { have: RES_HAVE, be: RES_BE, not: { have: RES_HAVE, be: RES_BE } };
const TREE = {
  pm: {
    environment: SCOPE, globals: SCOPE, collectionVariables: SCOPE,
    variables: { get: 'get(nome)', set: 'set(nome, valor) — só nesta execução', has: 'has(nome)', unset: 'unset(nome)', replaceIn: 'replaceIn(texto)', toObject: 'toObject()' },
    request: { url: { toString: 'toString()', getHost: 'getHost()', getPath: 'getPath()', getQueryString: 'getQueryString()', query: PLIST, update: 'update(url)', addQueryParams: 'addQueryParams(...)', removeQueryParams: 'removeQueryParams(nomes)' },
      method: 'GET, POST…', name: 'nome', headers: PLIST, body: { raw: 'texto', mode: "'raw' | 'urlencoded'", update: 'update(texto | objeto)', urlencoded: PLIST, toString: 'toString()' },
      addHeader: 'addHeader({ key, value })', removeHeader: 'removeHeader(nome)', upsertHeader: 'upsertHeader({ key, value })', addQueryParams: 'addQueryParams(...)', removeQueryParams: 'removeQueryParams(nomes)' },
    response: { code: 'status numérico', status: "texto ('OK')", responseTime: 'ms', responseSize: 'bytes', headers: PLIST, cookies: { get: 'get(nome)', has: 'has(nome)', toObject: 'toObject()' }, json: 'json()', text: 'text()', to: RES_TO },
    test: "test('nome', () => {…})", expect: 'expect(valor)', sendRequest: 'sendRequest(req, (err, res) => {…})',
    info: { eventName: "'prerequest' | 'test'", requestName: 'nome', requestId: 'id', iteration: '0' },
    cookies: { get: 'get(nome)', has: 'has(nome)', toObject: 'toObject()' },
    visualizer: { set: 'set(template, dados)', clear: 'clear()' },
    execution: { skipRequest: 'skipRequest() — só antes da requisição', setNextRequest: 'setNextRequest(nome) — no Runner' },
    xml: { sign: "await sign(xml, 'infNFe', { alg: 'sha1' })" },
  },
  console: { log: 'log(...)', info: 'info(...)', warn: 'warn(...)', error: 'error(...)' },
  JSON: { parse: 'parse(texto)', stringify: 'stringify(valor, null, 2)' },
};
// Monta o caminho antes do cursor: "pm.response.to.have." → ['pm','response','to','have']
function pathBefore(text) {
  const pm = text.match(/[\w$]*$/);
  const prefix = pm[0];
  let i = text.length - prefix.length;
  if (text[i - 1] !== '.') return { prefix, path: [] };
  const path = [];
  i--;
  while (i > 0) {
    let j = i;
    if (text[j - 1] === ')') {
      let depth = 0;
      for (j = j - 1; j >= 0; j--) { if (text[j] === ')') depth++; else if (text[j] === '(') { depth--; if (depth === 0) break; } }
      if (j < 0) return null;
      const id = text.slice(0, j).match(/[\w$]+$/);
      if (!id) return null;
      path.unshift(id[0] + '()');
      i = j - id[0].length;
    } else {
      const id = text.slice(0, j).match(/[\w$]+$/);
      if (!id) return null;
      path.unshift(id[0]);
      i = j - id[0].length;
    }
    if (text[i - 1] !== '.') break;
    i--;
  }
  return { prefix, path };
}
function nodeFor(path) {
  let node = TREE;
  for (const seg of path) {
    if (seg === 'expect()' || seg === 'pm.expect()') { node = ASSERT; continue; }
    if (node === ASSERT) { if (seg.endsWith('()') || seg in ASSERT) { node = ASSERT; continue; } return null; }
    const k = seg.replace(/\(\)$/, '');
    if (seg.endsWith('()') && k === 'expect') { node = ASSERT; continue; }
    if (!node || typeof node !== 'object' || !(k in node)) return null;
    node = node[k];
    if (seg.endsWith('()') && typeof node === 'string') return null;
  }
  return node && typeof node === 'object' ? node : null;
}
function suggestions(text) {
  const p = pathBefore(text);
  if (!p) return null;
  let node;
  if (!p.path.length) { if (p.prefix.length < 2) return null; node = { pm: 'API do Postman', console: 'console', JSON: 'JSON' }; }
  else node = nodeFor(p.path);
  if (!node) return null;
  const q = p.prefix.toLowerCase();
  const items = Object.entries(node).filter(([k]) => k.toLowerCase().startsWith(q) && k !== p.prefix)
    .map(([k, v]) => ({ label: k, detail: typeof v === 'string' ? v : 'objeto', call: typeof v === 'string' && /\(/.test(v) && v.startsWith(k + '(') }));
  return items.length ? { prefix: p.prefix, items: items.slice(0, 40) } : null;
}

// ---------- Editor ----------
function insertText(ta, text, start = ta.selectionStart, end = ta.selectionEnd) {
  ta.focus();
  ta.setSelectionRange(start, end);
  if (!document.execCommand || !document.execCommand('insertText', false, text)) {
    ta.setRangeText(text, start, end, 'end');
    ta.dispatchEvent(new Event('input'));
  }
}
const PAIRS = { '(': ')', '[': ']', '{': '}' };
// highlight(texto) → html: troca as cores (JSON, XML…); complete: autocompletar de pm.* (só nos scripts).
function codeEditor({ value = '', placeholder = '', onChange, label = 'Código', highlight = null, complete = true }) {
  const wrap = h('div', { class: 'code-editor' });
  const gutter = h('div', { class: 'ce-gutter', 'aria-hidden': 'true' });
  const gutterInner = h('div', { class: 'ce-gutter-inner' });
  gutter.append(gutterInner);
  const area = h('div', { class: 'ce-area' });
  const hl = h('pre', { class: 'ce-hl', 'aria-hidden': 'true' });
  const ta = h('textarea', { class: 'ce-input', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off', placeholder, 'aria-label': label });
  ta.value = value;
  const menu = h('div', { class: 'ce-suggest hidden', role: 'listbox' });
  area.append(hl, ta, menu);
  wrap.append(gutter, area);

  let lastLines = -1;
  function paint() {
    const v = ta.value;
    hl.innerHTML = (highlight || highlightJs)(v) + '\n';
    const lines = v.split('\n').length;
    if (lines !== lastLines) {
      lastLines = lines;
      gutterInner.innerHTML = Array.from({ length: lines }, (_, i) => `<div>${i + 1}</div>`).join('');
    }
    markActive();
    sync();
  }
  function markActive() {
    const line = ta.value.slice(0, ta.selectionStart).split('\n').length - 1;
    const prev = gutterInner.querySelector('.on');
    if (prev) prev.classList.remove('on');
    const cur = gutterInner.children[line];
    if (cur) cur.classList.add('on');
  }
  function sync() {
    hl.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
    gutterInner.style.transform = `translateY(${-ta.scrollTop}px)`;
  }

  // autocompletar
  let sug = null, sel = 0;
  const charW = () => { const s = h('span', { class: 'ce-measure' }, 'MMMMMMMMMM'); area.append(s); const w = s.getBoundingClientRect().width / 10; s.remove(); return w || 7.5; };
  function openSuggest(force) {
    const before = ta.value.slice(0, ta.selectionStart);
    if (ta.selectionStart !== ta.selectionEnd) return closeSuggest();
    const lineText = before.slice(before.lastIndexOf('\n') + 1);
    if (/\/\//.test(lineText) && !force) return closeSuggest();
    const s = typeof complete === 'function' ? complete(before, force) : suggestions(before);
    if (!s) return closeSuggest();
    sug = s; sel = 0;
    menu.innerHTML = '';
    s.items.forEach((it, i) => {
      const row = h('div', { class: 'ce-opt' + (i === 0 ? ' active' : ''), role: 'option', onmousedown: (e) => { e.preventDefault(); sel = i; accept(); } },
        h('span', { class: 'ce-opt-k' }, it.label), h('span', { class: 'ce-opt-d' }, it.detail));
      menu.append(row);
    });
    const line = before.split('\n').length - 1;
    const col = lineText.length - s.prefix.length;
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    const padT = parseFloat(getComputedStyle(ta).paddingTop) || 0;
    const padL = parseFloat(getComputedStyle(ta).paddingLeft) || 0;
    let top = padT + (line + 1) * lh - ta.scrollTop + 2;
    const left = Math.max(4, padL + col * charW() - ta.scrollLeft);
    menu.classList.remove('hidden');
    const mh = menu.offsetHeight;
    if (top + mh > area.clientHeight && top - lh - mh - 4 > 0) top = top - lh - mh - 4;
    menu.style.top = top + 'px';
    menu.style.left = Math.min(left, Math.max(4, area.clientWidth - menu.offsetWidth - 8)) + 'px';
  }
  function closeSuggest() { sug = null; menu.classList.add('hidden'); }
  function move(d) {
    if (!sug) return;
    sel = (sel + d + sug.items.length) % sug.items.length;
    [...menu.children].forEach((c, i) => c.classList.toggle('active', i === sel));
    menu.children[sel].scrollIntoView({ block: 'nearest' });
  }
  function accept() {
    if (!sug) return;
    const it = sug.items[sel];
    const start = ta.selectionStart - sug.prefix.length;
    const text = it.insert != null ? it.insert : it.call ? it.label + '()' : it.label;
    insertText(ta, text, start, ta.selectionStart);
    if (it.call) ta.setSelectionRange(ta.selectionStart - 1, ta.selectionStart - 1);
    closeSuggest();
  }

  // edição
  const lineStart = (pos) => ta.value.lastIndexOf('\n', pos - 1) + 1;
  function indentLines(out) {
    const s = ta.selectionStart, e = ta.selectionEnd;
    const ls = lineStart(s);
    const le = ta.value.indexOf('\n', e - (e > s && ta.value[e - 1] === '\n' ? 1 : 0));
    const end = le === -1 ? ta.value.length : le;
    const block = ta.value.slice(ls, end);
    const lines = block.split('\n');
    const next = lines.map((l) => (out ? l.replace(/^ {1,2}/, '') : '  ' + l)).join('\n');
    insertText(ta, next, ls, end);
    ta.setSelectionRange(ls, ls + next.length);
  }
  function toggleComment() {
    const s = ta.selectionStart, e = ta.selectionEnd;
    const ls = lineStart(s);
    const le = ta.value.indexOf('\n', Math.max(s, e - 1));
    const end = le === -1 ? ta.value.length : le;
    const lines = ta.value.slice(ls, end).split('\n');
    const all = lines.filter((l) => l.trim()).every((l) => /^\s*\/\//.test(l));
    const next = lines.map((l) => (all ? l.replace(/^(\s*)\/\/ ?/, '$1') : l.trim() ? l.replace(/^(\s*)/, '$1// ') : l)).join('\n');
    insertText(ta, next, ls, end);
    ta.setSelectionRange(ls, ls + next.length);
  }
  ta.addEventListener('keydown', (e) => {
    if (sug) {
      if (e.key === 'ArrowDown') { e.preventDefault(); return move(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); return move(-1); }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return accept(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return closeSuggest(); }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === ' ') { e.preventDefault(); return openSuggest(true); }
    if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); return toggleComment(); }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey || ta.selectionStart !== ta.selectionEnd && ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n')) return indentLines(e.shiftKey);
      return insertText(ta, '  ');
    }
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const pos = ta.selectionStart;
      const line = ta.value.slice(lineStart(pos), pos);
      const ind = line.match(/^\s*/)[0];
      const prev = ta.value[pos - 1], next = ta.value[pos];
      if (PAIRS[prev] && next === PAIRS[prev]) {
        insertText(ta, '\n' + ind + '  ' + '\n' + ind);
        const c = pos + 1 + ind.length + 2;
        ta.setSelectionRange(c, c);
      } else insertText(ta, '\n' + ind + (/[{([]\s*$/.test(line) ? '  ' : ''));
      return;
    }
    if (PAIRS[e.key] && ta.selectionStart === ta.selectionEnd) {
      const next = ta.value[ta.selectionStart];
      if (!next || /[\s)\]};,]/.test(next)) { e.preventDefault(); const p = ta.selectionStart; insertText(ta, e.key + PAIRS[e.key]); ta.setSelectionRange(p + 1, p + 1); return; }
    }
    if ([')', ']', '}'].includes(e.key) && ta.value[ta.selectionStart] === e.key && ta.selectionStart === ta.selectionEnd) {
      e.preventDefault(); ta.setSelectionRange(ta.selectionStart + 1, ta.selectionStart + 1); return;
    }
    if (e.key === 'Backspace' && ta.selectionStart === ta.selectionEnd) {
      const p = ta.selectionStart;
      if (PAIRS[ta.value[p - 1]] && ta.value[p] === PAIRS[ta.value[p - 1]]) { e.preventDefault(); insertText(ta, '', p - 1, p + 1); }
    }
  });
  ta.addEventListener('input', (e) => {
    paint();
    onChange && onChange(ta.value);
    const ch = ta.value[ta.selectionStart - 1];
    if (!complete) closeSuggest();
    else if (typeof complete === 'function') { if (e.inputType === 'insertText' && /[\w$@]/.test(ch || '')) openSuggest(); else closeSuggest(); }
    else if (e.inputType === 'insertText' && (ch === '.' || (sug && /[\w$]/.test(ch)))) openSuggest();
    else if (e.inputType === 'insertText' && /[\w$]/.test(ch || '')) { const before = ta.value.slice(0, ta.selectionStart); if (/(^|[^\w$.])[\w$]{2,}$/.test(before) && /^(pm|co|JS)/i.test(before.match(/[\w$]+$/)[0])) openSuggest(); else closeSuggest(); }
    else closeSuggest();
  });
  ta.addEventListener('scroll', () => { sync(); if (sug) closeSuggest(); });
  ta.addEventListener('click', () => { markActive(); closeSuggest(); });
  ta.addEventListener('keyup', (e) => { if (/Arrow|Home|End|Page/.test(e.key) && !sug) markActive(); });
  ta.addEventListener('blur', () => setTimeout(closeSuggest, 120));
  paint();

  wrap.textarea = ta;
  wrap.focus = () => ta.focus();
  wrap.getValue = () => ta.value;
  wrap.setValue = (v) => { ta.value = v; paint(); };
  wrap.insert = (snippet) => {
    const pos = ta.selectionStart;
    const atLineStart = pos === 0 || ta.value[pos - 1] === '\n';
    const needBreak = !atLineStart ? '\n' : '';
    const sep = ta.value.trim() && atLineStart && pos === ta.value.length && !ta.value.endsWith('\n\n') ? (ta.value.endsWith('\n') ? '\n' : '\n\n') : '';
    insertText(ta, (sep || needBreak) + snippet + '\n');
  };
  return wrap;
}

// ---------- Snippets ----------
const S_ENV = [
  ['Obter variável de ambiente', 'pm.environment.get("variable_key");'],
  ['Obter variável global', 'pm.globals.get("variable_key");'],
  ['Obter variável (qualquer escopo)', 'pm.variables.get("variable_key");'],
  ['Obter variável da coleção', 'pm.collectionVariables.get("variable_key");'],
  ['Definir variável de ambiente', 'pm.environment.set("variable_key", "variable_value");'],
  ['Definir variável global', 'pm.globals.set("variable_key", "variable_value");'],
  ['Definir variável da coleção', 'pm.collectionVariables.set("variable_key", "variable_value");'],
  ['Remover variável de ambiente', 'pm.environment.unset("variable_key");'],
  ['Remover variável global', 'pm.globals.unset("variable_key");'],
  ['Remover variável da coleção', 'pm.collectionVariables.unset("variable_key");'],
];
const S_SEND = ['Enviar uma requisição', `pm.sendRequest("https://postman-echo.com/get", function (err, response) {
  console.log(response.json());
});`];
const SNIPPETS = {
  pre: [
    ...S_ENV,
    S_SEND,
    ['Buscar token antes de enviar', `pm.sendRequest({
  url: pm.environment.get("baseUrl") + "/auth",
  method: "POST",
  header: { "Content-Type": "application/json" },
  body: { mode: "raw", raw: JSON.stringify({ username: "admin", password: "password123" }) }
}, function (err, res) {
  if (err) return console.error(err);
  pm.environment.set("token", res.json().token);
});`],
    ['Adicionar header na requisição', 'pm.request.headers.upsert({ key: "X-Request-Id", value: pm.variables.replaceIn("{{$guid}}") });'],
    ['Adicionar parâmetro de query', 'pm.request.url.query.add({ key: "page", value: "1" });'],
    ['Gerar timestamp em variável', 'pm.variables.set("timestamp", Date.now());'],
    ['Assinar com HMAC SHA-256', `const secret = pm.environment.get("secret");
const payload = pm.request.body.raw || "";
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
pm.request.headers.upsert({ key: "X-Signature", value: hex });`],
    ['Assinar o XML do corpo (certificado A1)', `// Usa o certificado configurado para o host (Configurações › Certificados).
// Troque 'infEvento' por infNFe, infInut… — ou '' para assinar o documento inteiro.
const assinado = await pm.xml.sign(pm.request.body.raw, 'infEvento');
pm.request.body.update(assinado);`],
    ['Pular a requisição', `if (!pm.environment.get("token")) {
  pm.execution.skipRequest();
}`],
    ['Registrar no console', 'console.log(pm.request.url.toString());'],
  ],
  post: [
    ['Status: código é 200', `pm.test("Status code é 200", function () {
  pm.response.to.have.status(200);
});`],
    ['Status: POST bem-sucedido', `pm.test("Requisição criada", function () {
  pm.expect(pm.response.code).to.be.oneOf([201, 202]);
});`],
    ['Status: nome do status', `pm.test("Status é \\"Created\\"", function () {
  pm.response.to.have.status("Created");
});`],
    ['Corpo: contém texto', `pm.test("Corpo contém texto", function () {
  pm.expect(pm.response.text()).to.include("texto_procurado");
});`],
    ['Corpo: valor do JSON', `pm.test("Valor do JSON", function () {
  const jsonData = pm.response.json();
  pm.expect(jsonData.value).to.eql(100);
});`],
    ['Corpo: igual a texto', `pm.test("Corpo é igual ao esperado", function () {
  pm.response.to.have.body("response_body_string");
});`],
    ['Header Content-Type presente', `pm.test("Content-Type presente", function () {
  pm.response.to.have.header("Content-Type");
});`],
    ['Tempo de resposta menor que 200 ms', `pm.test("Tempo de resposta < 200 ms", function () {
  pm.expect(pm.response.responseTime).to.be.below(200);
});`],
    ['Validar JSON Schema', `const schema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "number" }
  }
};

pm.test("Schema é válido", function () {
  pm.response.to.have.jsonSchema(schema);
});`],
    ['Salvar token da resposta no ambiente', `const jsonData = pm.response.json();
pm.environment.set("token", jsonData.token);`],
    ['Visualizar resposta em tabela', `const template = \`
<style>table{border-collapse:collapse;font:13px system-ui}td,th{border:1px solid #ccc;padding:6px 10px;text-align:left}</style>
<table>
  <tr><th>Campo</th><th>Valor</th></tr>
  {{#each rows}}
  <tr><td>{{key}}</td><td>{{value}}</td></tr>
  {{/each}}
</table>\`;

const body = pm.response.json();
const first = Array.isArray(body) ? body[0] || {} : body;
const rows = Object.entries(first).map(([key, value]) => ({ key, value: JSON.stringify(value) }));
pm.visualizer.set(template, { rows });`],
    ...S_ENV,
    S_SEND,
  ],
};

// ---------- Painel Scripts ----------
// target: objeto com .pre (antes da requisição) e .tests (após a resposta)
function scriptsPanel(target, { onChange, which = 'pre', onWhich, scope = 'requisição' } = {}) {
  const root = h('div', { class: 'scripts-pane' });
  const nav = h('nav', { class: 'scripts-nav' });
  const main = h('div', { class: 'scripts-main' });
  root.append(nav, main);
  const KEYS = { pre: 'pre', post: 'tests' };
  let editor, panelRef = null, btnRef = null;
  const onDoc = (e) => {
    if (!root.isConnected) { document.removeEventListener('mousedown', onDoc); return; }
    if (panelRef && !panelRef.contains(e.target) && !btnRef.contains(e.target)) panelRef.classList.add('hidden');
  };
  document.addEventListener('mousedown', onDoc);
  const draw = () => {
    nav.innerHTML = ''; main.innerHTML = '';
    for (const [k, label] of [['pre', 'Antes da requisição'], ['post', 'Após a resposta']]) {
      const has = !!String(target[KEYS[k]] || '').trim();
      nav.append(h('button', { class: which === k ? 'active' : '', type: 'button', onclick: () => { which = k; onWhich && onWhich(k); draw(); setTimeout(() => editor.focus(), 0); } },
        h('span', {}, label), has ? h('span', { class: 'dot-ind', title: 'Tem script' }) : null));
    }
    editor = codeEditor({
      value: target[KEYS[which]] || '',
      label: which === 'pre' ? 'Script antes da requisição' : 'Script após a resposta',
      placeholder: which === 'pre'
        ? 'Use JavaScript para preparar a requisição: variáveis, headers, token…'
        : 'Use JavaScript para escrever testes, visualizar a resposta e mais.',
      onChange: (v) => {
        const before = !!String(target[KEYS[which]] || '').trim();
        target[KEYS[which]] = v;
        if (before !== !!v.trim()) { const b = nav.querySelector('.active'); const dot = b.querySelector('.dot-ind'); if (v.trim() && !dot) b.append(h('span', { class: 'dot-ind' })); else if (!v.trim() && dot) dot.remove(); }
        onChange && onChange();
      },
    });
    const snipBtn = h('button', { class: 'ce-float-btn', type: 'button', title: 'Trechos prontos', onclick: (e) => { e.stopPropagation(); toggleSnippets(); } }, h('span', { class: 'ce-float-ic', html: '&lt;/&gt;' }), 'Snippets');
    const refBtn = h('button', { class: 'ce-float-btn', type: 'button', title: 'O que dá para usar nos scripts', onclick: () => openReference() }, h('span', { class: 'ce-float-ic', html: '?' }), 'Referência');
    const floats = h('div', { class: 'ce-floats' }, refBtn, snipBtn);
    const panel = h('div', { class: 'snip-panel hidden' });
    function toggleSnippets() {
      if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
      panel.innerHTML = '';
      const search = h('input', { class: 'input sm', placeholder: 'Buscar snippet', spellcheck: 'false' });
      const list = h('div', { class: 'snip-list' });
      const fill = () => {
        list.innerHTML = '';
        const q = search.value.trim().toLowerCase();
        for (const [name, code] of SNIPPETS[which]) {
          if (q && !name.toLowerCase().includes(q) && !code.toLowerCase().includes(q)) continue;
          list.append(h('button', { class: 'snip-item', type: 'button', title: code, onclick: () => { editor.insert(code); panel.classList.add('hidden'); } }, name));
        }
        if (!list.children.length) list.append(h('div', { class: 'muted small', style: 'padding:8px 10px' }, 'Nada encontrado.'));
      };
      search.addEventListener('input', fill);
      search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); panel.classList.add('hidden'); editor.focus(); } });
      panel.append(h('div', { class: 'snip-head' }, h('b', {}, 'Snippets'), h('span', { class: 'muted small' }, which === 'pre' ? 'antes da requisição' : 'após a resposta')), search, list);
      fill();
      panel.classList.remove('hidden');
      // Posição fixa na janela: o painel não fica espremido quando o editor é baixo.
      const r = snipBtn.getBoundingClientRect();
      const spaceAbove = r.top - 16, spaceBelow = innerHeight - r.bottom - 16;
      panel.style.right = Math.max(8, innerWidth - r.right) + 'px';
      if (spaceAbove >= 260 || spaceAbove >= spaceBelow) { panel.style.bottom = (innerHeight - r.top + 6) + 'px'; panel.style.top = 'auto'; panel.style.maxHeight = Math.min(440, spaceAbove) + 'px'; }
      else { panel.style.top = (r.bottom + 6) + 'px'; panel.style.bottom = 'auto'; panel.style.maxHeight = Math.min(440, spaceBelow) + 'px'; }
      setTimeout(() => search.focus(), 0);
    }
    panelRef = panel; btnRef = snipBtn;
    main.append(editor, floats, panel);
  };
  draw();
  root.focusEditor = () => editor && editor.focus();
  return root;
}

// ---------- Referência ----------
function openReference() {
  const row = (code, txt) => h('tr', {}, h('td', {}, h('code', {}, code)), h('td', {}, txt));
  const sec = (title, rows) => h('div', { class: 'ref-sec' }, h('h3', {}, title), h('table', { class: 'data-table ref-table' }, rows.map(([c, t]) => row(c, t))));
  openModal((body, close) => {
    body.append(
      h('h2', {}, 'Scripts · referência'),
      h('p', { class: 'sub' }, 'Mesma API do Postman (pm.*). Os scripts rodam isolados, sem acesso ao app. Ordem: coleção → pastas → requisição, antes do envio e depois da resposta.'),
      h('div', { class: 'ref-body' },
        sec('Variáveis', [
          ['pm.environment.get / set / unset / has', 'ambiente ativo (gravado no disco)'],
          ['pm.collectionVariables.get / set', 'variáveis da coleção'],
          ['pm.globals.get / set', 'variáveis globais (Ambientes › Globais)'],
          ['pm.variables.get(nome)', 'busca em todos os escopos (local › ambiente › coleção › globais)'],
          ['pm.variables.set(nome, valor)', 'só nesta execução'],
          ['pm.variables.replaceIn("{{x}}")', 'resolve {{variáveis}} e dinâmicas ({{$guid}}, {{$timestamp}}, {{$randomInt}}…)'],
        ]),
        sec('Requisição (antes do envio)', [
          ['pm.request.method / url / headers / body', 'pode alterar antes de enviar'],
          ['pm.request.headers.upsert({ key, value })', 'adiciona ou troca um header'],
          ['pm.request.url.query.add({ key, value })', 'adiciona parâmetro'],
          ['pm.request.body.update(texto)', 'troca o corpo'],
          ['pm.execution.skipRequest()', 'não envia a requisição'],
          ['pm.sendRequest(req, (err, res) => {…})', 'outra requisição (também funciona com await)'],
        ]),
        sec('Resposta e testes', [
          ['pm.test(nome, fn)', 'registra um teste (fn pode ser async ou usar done)'],
          ['pm.expect(valor).to…', 'asserções no estilo Chai: equal, eql, include, property, lengthOf, above, below, a/an, match, oneOf, jsonSchema…'],
          ['pm.response.code / status / responseTime', 'status e tempo'],
          ['pm.response.json() / text()', 'corpo'],
          ['pm.response.headers.get(nome)', 'header da resposta'],
          ['pm.response.to.have.status(200)', 'também: header, body, jsonBody, jsonSchema; to.be.ok / success / json'],
          ['pm.cookies.get(nome)', 'cookies da resposta'],
          ['pm.visualizer.set(template, dados)', 'mostra HTML na aba Visualizar (template estilo Handlebars)'],
          ['console.log(...)', 'aparece na aba Console da resposta'],
        ]),
        sec('Também disponível', [
          ['crypto, atob/btoa, JSON, Date, setTimeout', 'nativos do JavaScript'],
          ['require("chai") / require("uuid")', 'pacotes incluídos'],
          ['postman.setEnvironmentVariable, tests["nome"]', 'sintaxe antiga do Postman'],
        ])),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn-primary', onclick: close }, 'Fechar')));
  });
  document.querySelector('#modalBody')?.classList.add('wide');
}

window.MonoScripts = { codeEditor, scriptsPanel, highlightJs, suggestions, SNIPPETS, openReference };
})();
