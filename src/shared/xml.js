// XML mínimo e sem dependências: parser em árvore (com namespaces), serialização e
// canonicalização C14N 1.0 inclusiva (usada na assinatura XMLDSig da NF-e e na leitura de WSDL).
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.MonoXml = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
  function decode(s) {
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => {
      if (e[0] === '#') { const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return String.fromCodePoint(n); }
      return Object.prototype.hasOwnProperty.call(ENT, e) ? ENT[e] : m;
    });
  }
  const splitName = (n) => { const i = n.indexOf(':'); return i < 0 ? ['', n] : [n.slice(0, i), n.slice(i + 1)]; };

  // ---------- Parser ----------
  function parse(input) {
    const src = String(input).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const doc = { type: 'doc', children: [], decl: null };
    const stack = [doc];
    let i = 0;
    const top = () => stack[stack.length - 1];
    const err = (msg) => { const line = src.slice(0, i).split('\n').length; throw new Error(`XML inválido (linha ${line}): ${msg}`); };
    while (i < src.length) {
      const lt = src.indexOf('<', i);
      if (lt < 0) { const t = src.slice(i); if (stack.length > 1) top().children.push({ type: 'text', value: decode(t) }); else if (t.trim()) err('texto fora do elemento raiz'); break; }
      if (lt > i) {
        const t = src.slice(i, lt);
        if (stack.length > 1) top().children.push({ type: 'text', value: decode(t) });
        else if (t.trim()) err('texto fora do elemento raiz');
      }
      i = lt;
      if (src.startsWith('<!--', i)) {
        const e = src.indexOf('-->', i + 4); if (e < 0) err('comentário sem fim');
        top().children.push({ type: 'comment', value: src.slice(i + 4, e) });
        i = e + 3;
      } else if (src.startsWith('<![CDATA[', i)) {
        const e = src.indexOf(']]>', i + 9); if (e < 0) err('CDATA sem fim');
        top().children.push({ type: 'text', value: src.slice(i + 9, e), cdata: true });
        i = e + 3;
      } else if (src.startsWith('<?', i)) {
        const e = src.indexOf('?>', i + 2); if (e < 0) err('instrução sem fim');
        const body = src.slice(i + 2, e);
        if (/^xml\s/i.test(body) && stack.length === 1) doc.decl = '<?' + body + '?>';
        else top().children.push({ type: 'pi', value: body });
        i = e + 2;
      } else if (src.startsWith('<!', i)) {
        // DOCTYPE (com subconjunto interno opcional)
        let depth = 0, j = i + 2;
        for (; j < src.length; j++) { if (src[j] === '[') depth++; else if (src[j] === ']') depth--; else if (src[j] === '>' && depth <= 0) break; }
        i = j + 1;
      } else if (src[i + 1] === '/') {
        const e = src.indexOf('>', i); if (e < 0) err('tag de fechamento sem fim');
        const name = src.slice(i + 2, e).trim();
        const el = stack.pop();
        if (!el || el.type !== 'el' || el.name !== name) err(`esperado </${el && el.name}>, encontrado </${name}>`);
        i = e + 1;
      } else {
        const m = /^<([^\s/>]+)/.exec(src.slice(i, i + 300));
        if (!m) err('tag inválida');
        const el = { type: 'el', name: m[1], attrs: [], children: [], parent: top() === doc ? null : top() };
        [el.prefix, el.local] = splitName(el.name);
        let j = i + m[0].length;
        const attrRe = /\s*([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')|\s*(\/?)>/y;
        for (;;) {
          attrRe.lastIndex = j;
          const a = attrRe.exec(src);
          if (!a) err(`atributo inválido em <${el.name}>`);
          j = attrRe.lastIndex;
          if (a[1]) {
            const raw = a[3] != null ? a[3] : a[4];
            el.attrs.push({ name: a[1], value: decode(raw.replace(/[\t\n\r]/g, ' ')) });
          } else {
            top().children.push(el);
            if (a[5] !== '/') stack.push(el);
            break;
          }
        }
        i = j;
      }
    }
    if (stack.length > 1) err(`<${top().name}> não foi fechado`);
    const rootEl = doc.children.find((c) => c.type === 'el');
    if (!rootEl) throw new Error('XML vazio.');
    doc.root = rootEl;
    return doc;
  }

  // ---------- Namespaces e navegação ----------
  const attr = (el, name) => { const a = el.attrs.find((x) => x.name === name); return a ? a.value : undefined; };
  function nsDecls(el) {
    const out = {};
    for (const a of el.attrs) {
      if (a.name === 'xmlns') out[''] = a.value;
      else if (a.name.startsWith('xmlns:')) out[a.name.slice(6)] = a.value;
    }
    return out;
  }
  function inScope(el, stopAt) {
    const chain = [];
    for (let e = el; e && e !== stopAt; e = e.parent) chain.unshift(e);
    const out = {};
    for (const e of chain) Object.assign(out, nsDecls(e));
    return out;
  }
  const nsUri = (el, prefix = el.prefix) => inScope(el)[prefix] || '';
  const elements = (el) => el.children.filter((c) => c.type === 'el');
  function* walk(el) { yield el; for (const c of elements(el)) yield* walk(c); }
  const findAll = (el, local) => [...walk(el)].filter((e) => e.local === local);
  const find = (el, local) => findAll(el, local)[0] || null;
  const children = (el, local) => elements(el).filter((e) => !local || e.local === local);
  const text = (el) => el.children.map((c) => (c.type === 'text' ? c.value : c.type === 'el' ? text(c) : '')).join('');

  // ---------- Serialização ----------
  const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  function serialize(node) {
    if (node.type === 'doc') return (node.decl ? node.decl : '') + node.children.map(serialize).join('');
    if (node.type === 'text') return escText(node.value);
    if (node.type === 'comment') return `<!--${node.value}-->`;
    if (node.type === 'pi') return `<?${node.value}?>`;
    const a = node.attrs.map((x) => ` ${x.name}="${escAttr(x.value)}"`).join('');
    return node.children.length ? `<${node.name}${a}>${node.children.map(serialize).join('')}</${node.name}>` : `<${node.name}${a}/>`;
  }
  // Remove espaços de formatação entre tags (a SEFAZ rejeita "caracteres de edição").
  function minify(node) {
    if (node.type !== 'el' && node.type !== 'doc') return;
    const hasEl = node.children.some((c) => c.type === 'el');
    if (hasEl) node.children = node.children.filter((c) => !(c.type === 'text' && !c.value.trim()) && c.type !== 'comment');
    node.children.forEach(minify);
  }

  // ---------- C14N 1.0 inclusiva, sem comentários ----------
  // http://www.w3.org/TR/2001/REC-xml-c14n-20010315 — subconjunto = subárvore de `el`.
  // boundary: ancestral a partir do qual os namespaces NÃO são herdados (ex.: o envelope SOAP).
  const c14nAttr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');
  const c14nText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
  function c14n(el, { boundary = null } = {}) {
    const startScope = el.parent ? inScope(el.parent, boundary) : {};
    const render = (e, parentScope, rendered) => {
      const scope = { ...parentScope, ...nsDecls(e) };
      const out = [];
      const keys = Object.keys(scope).filter((p) => p !== 'xml').sort();
      for (const p of keys) {
        const v = scope[p];
        if (p === '') {
          if (v === '' ? (rendered[''] || '') !== '' : rendered[''] !== v) out.push(v === '' ? ' xmlns=""' : ` xmlns="${c14nAttr(v)}"`);
        } else if (rendered[p] !== v) out.push(` xmlns:${p}="${c14nAttr(v)}"`);
      }
      const nowRendered = { ...rendered };
      for (const p of keys) nowRendered[p] = scope[p];
      const attrs = e.attrs.filter((a) => a.name !== 'xmlns' && !a.name.startsWith('xmlns:')).map((a) => {
        const [pf, local] = splitName(a.name);
        return { a, uri: pf ? (pf === 'xml' ? 'http://www.w3.org/XML/1998/namespace' : scope[pf] || '') : '', local };
      }).sort((x, y) => (x.uri < y.uri ? -1 : x.uri > y.uri ? 1 : x.local < y.local ? -1 : x.local > y.local ? 1 : 0));
      let s = `<${e.name}${out.join('')}${attrs.map((x) => ` ${x.a.name}="${c14nAttr(x.a.value)}"`).join('')}>`;
      for (const c of e.children) {
        if (c.type === 'el') s += render(c, scope, nowRendered);
        else if (c.type === 'text') s += c14nText(c.value);
        else if (c.type === 'pi') s += `<?${c.value}?>`;
      }
      return s + `</${e.name}>`;
    };
    return render(el, startScope, {});
  }

  // Constrói um elemento a partir de XML (para inserir nós novos, como a <Signature>).
  function fragment(xmlText, parent) {
    const d = parse(xmlText);
    const r = d.root;
    const fix = (e, p) => { e.parent = p; elements(e).forEach((c) => fix(c, e)); };
    fix(r, parent);
    return r;
  }

  // Formata (indenta) — só para exibição.
  function pretty(node, ind = '') {
    if (node.type === 'doc') return (node.decl ? node.decl + '\n' : '') + node.children.filter((c) => c.type !== 'text').map((c) => pretty(c, '')).join('\n');
    if (node.type === 'text') return escText(node.value.trim());
    if (node.type === 'comment') return `${ind}<!--${node.value}-->`;
    if (node.type === 'pi') return `${ind}<?${node.value}?>`;
    const a = node.attrs.map((x) => ` ${x.name}="${escAttr(x.value)}"`).join('');
    const kids = node.children.filter((c) => !(c.type === 'text' && !c.value.trim()));
    if (!kids.length) return `${ind}<${node.name}${a}/>`;
    if (kids.every((c) => c.type === 'text')) return `${ind}<${node.name}${a}>${kids.map((c) => escText(c.value)).join('')}</${node.name}>`;
    return `${ind}<${node.name}${a}>\n${kids.map((c) => (c.type === 'text' ? ind + '  ' + escText(c.value.trim()) : pretty(c, ind + '  '))).join('\n')}\n${ind}</${node.name}>`;
  }

  return { parse, serialize, minify, c14n, inScope, nsUri, nsDecls, attr, elements, children, find, findAll, walk, text, fragment, pretty, decode };
});
