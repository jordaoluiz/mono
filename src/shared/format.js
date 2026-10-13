// Formatação "Pretty" de respostas: HTML/XML indentado e CSS de <style> organizado.
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.MonoFormat = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', '!doctype']);
  const RAW = new Set(['script', 'style', 'textarea', 'pre']);
  const IND = '    ';

  // Olha o conteúdo: quando ele é claramente JSON, HTML ou XML, isso vale mais que o Content-Type.
  function sniff(body) {
    const s = String(body || '').trimStart();
    if (!s) return null;
    if (/^[[{]/.test(s)) { try { JSON.parse(s); return 'json'; } catch { /* segue */ } }
    const head = s.slice(0, 400).toLowerCase();
    if (head.startsWith('<?xml')) return /<html[\s>]/.test(s.slice(0, 3000).toLowerCase()) ? 'html' : 'xml';
    if (head.startsWith('<!doctype html') || /^<html[\s>]/.test(head)) return 'html';
    if (/^<!--/.test(head) && /<html[\s>]/.test(s.slice(0, 3000).toLowerCase())) return 'html';
    return null;
  }
  function detect(contentType, body) {
    const sniffed = sniff(body);
    if (sniffed) return sniffed;
    const ct = String(contentType || '').toLowerCase();
    const head = String(body || '').trimStart().slice(0, 200).toLowerCase();
    if (head.startsWith('<')) return /xml|svg/.test(ct) ? 'xml' : 'html'; // inclui página de erro HTML com Content-Type JSON
    if (/json/.test(ct) || /^[[{]/.test(head)) return 'json';
    if (/html/.test(ct)) return 'html';
    if (/xml|svg/.test(ct)) return 'xml';
    if (/javascript|ecmascript/.test(ct)) return 'js';
    if (/css/.test(ct)) return 'css';
    if (head.startsWith('<')) return 'html';
    return 'text';
  }

  // Lê uma tag inteira respeitando aspas (atributos podem conter ">").
  function readTag(s, i) {
    let q = null;
    for (let j = i + 1; j < s.length; j++) {
      const c = s[j];
      if (q) { if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (c === '>') return j + 1;
    }
    return s.length;
  }

  function tokenize(s, isXml) {
    const out = [];
    let i = 0;
    while (i < s.length) {
      if (s.startsWith('<!--', i)) {
        const e = s.indexOf('-->', i + 4);
        const end = e === -1 ? s.length : e + 3;
        out.push({ t: 'comment', v: s.slice(i, end) }); i = end; continue;
      }
      if (s.startsWith('<![CDATA[', i)) {
        const e = s.indexOf(']]>', i);
        const end = e === -1 ? s.length : e + 3;
        out.push({ t: 'text', v: s.slice(i, end) }); i = end; continue;
      }
      if (s[i] === '<' && /[A-Za-z!?\/]/.test(s[i + 1] || '')) {
        const end = readTag(s, i);
        const raw = s.slice(i, end);
        const m = raw.match(/^<\s*(\/)?\s*([!?]?[A-Za-z][\w:.-]*)/);
        const name = m ? m[2].toLowerCase() : '';
        const closing = !!(m && m[1]);
        const self = /\/\s*>$/.test(raw) || name.startsWith('?') || (!isXml && VOID.has(name));
        out.push({ t: closing ? 'close' : 'open', name, v: raw, self });
        i = end;
        if (!closing && !self && !isXml && RAW.has(name)) {
          const re = new RegExp('<\\/\\s*' + name + '\\s*>', 'i');
          const rest = s.slice(i);
          const mm = rest.match(re);
          const stop = mm ? i + mm.index : s.length;
          out.push({ t: 'raw', name, v: s.slice(i, stop) });
          i = stop;
        }
        continue;
      }
      const next = s.indexOf('<', i + 1);
      const end = next === -1 ? s.length : next;
      out.push({ t: 'text', v: s.slice(i, end) });
      i = end;
    }
    return out;
  }

  function formatCss(css, base) {
    let out = '', depth = 0, buf = '', q = null;
    const flush = (kind) => {
      let t = buf.trim().replace(/\s+/g, ' ');
      if (t && kind === 'decl') t = t.replace(/^([\w-]+)\s*:\s*/, '$1: ');
      if (t && kind === 'sel') t = t.replace(/\s*,\s*/g, ', ');
      if (t) out += base + IND.repeat(depth) + t;
      buf = ''; return !!t;
    };
    for (let i = 0; i < css.length; i++) {
      const c = css[i];
      if (q) { buf += c; if (c === q && css[i - 1] !== '\\') q = null; continue; }
      if (c === '"' || c === "'") { q = c; buf += c; continue; }
      if (c === '/' && css[i + 1] === '*') { const e = css.indexOf('*/', i + 2); const end = e === -1 ? css.length : e + 2; flush(); out += base + IND.repeat(depth) + css.slice(i, end).trim() + '\n'; i = end - 1; continue; }
      if (c === '{') { flush('sel'); out += ' {\n'; depth++; continue; }
      if (c === ';') { if (flush('decl')) out += ';\n'; continue; }
      if (c === '}') { if (flush('decl')) out += ';\n'; depth = Math.max(0, depth - 1); out += base + IND.repeat(depth) + '}\n\n'; continue; }
      buf += c;
    }
    if (flush()) out += '\n';
    return out.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '');
  }

  function formatMarkup(src, { xml = false } = {}) {
    const toks = tokenize(String(src), xml);
    const lines = [];
    let depth = 0;
    const push = (text, d = depth) => lines.push(IND.repeat(Math.max(0, d)) + text);
    for (let k = 0; k < toks.length; k++) {
      const tk = toks[k];
      if (tk.t === 'text') {
        const v = tk.v.replace(/\s+/g, ' ').trim();
        if (v) push(v);
      } else if (tk.t === 'comment') {
        push(tk.v.trim());
      } else if (tk.t === 'open') {
        // <tag>texto curto</tag> numa linha só, como no Postman.
        const a = toks[k + 1], b = toks[k + 2];
        if (!tk.self && a && b && a.t === 'text' && b.t === 'close' && b.name === tk.name) {
          const txt = a.v.replace(/\s+/g, ' ').trim();
          if (txt.length + tk.v.length < 120) { push(tk.v + txt + b.v); k += 2; continue; }
        }
        if (!tk.self && a && a.t === 'close' && a.name === tk.name) { push(tk.v + a.v); k += 1; continue; }
        if (!tk.self && a && a.t === 'raw' && b && b.t === 'close' && !a.v.trim()) { push(tk.v + b.v); k += 2; continue; }
        push(tk.v);
        if (!tk.self) depth++;
      } else if (tk.t === 'raw') {
        const body = tk.v.replace(/^\s*\n/, '').replace(/\s+$/, '');
        if (!body.trim()) continue;
        if (tk.name === 'style') {
          lines.push(formatCss(body, IND.repeat(depth)));
        } else if (tk.name === 'pre' || tk.name === 'textarea') {
          lines.push(body);
        } else {
          // Scripts: mantém o código, só reindenta as linhas em relação à tag.
          const ls = body.split('\n');
          const minIndent = Math.min(...ls.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
          for (const l of ls) if (l.trim()) push(l.slice(minIndent).replace(/\s+$/, ''));
        }
      } else if (tk.t === 'close') {
        depth = Math.max(0, depth - 1);
        push(tk.v);
      }
    }
    return lines.join('\n');
  }

  function pretty(lang, body) {
    try {
      if (lang === 'json') return JSON.stringify(JSON.parse(body), null, 2);
      if (lang === 'html') return formatMarkup(body);
      if (lang === 'xml') return formatMarkup(body, { xml: true });
      if (lang === 'css') return formatCss(body, '');
    } catch { /* volta ao bruto */ }
    return null;
  }

  return { detect, sniff, formatMarkup, formatCss, pretty };
});
