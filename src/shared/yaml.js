// Leitor de YAML suficiente para especificações OpenAPI/Swagger:
// mapas e listas por indentação, escalares, strings com aspas, blocos | e >, fluxo [..] e {..} simples.
// Não suporta âncoras/aliases (&, *) nem documentos múltiplos.
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.MonoYaml = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function scalar(raw) {
    const s = raw.trim();
    if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
    if (s === 'true' || s === 'True' || s === 'TRUE') return true;
    if (s === 'false' || s === 'False' || s === 'FALSE') return false;
    if (/^[-+]?\d+$/.test(s) && Math.abs(Number(s)) < 2 ** 53) return Number(s);
    if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
    if (s.startsWith('"')) return JSON.parse(s.replace(/\\'/g, "'"));
    if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
    if (s.startsWith('[') || s.startsWith('{')) return flow(s);
    return s;
  }
  // Coleções em fluxo: [a, b, "c"] e {a: 1, b: x}
  function flow(s) {
    let i = 0;
    const ws = () => { while (/\s/.test(s[i])) i++; };
    function val() {
      ws();
      if (s[i] === '[') { i++; const arr = []; ws(); if (s[i] === ']') { i++; return arr; } for (;;) { arr.push(val()); ws(); if (s[i] === ',') { i++; continue; } if (s[i] === ']') { i++; return arr; } throw new Error('YAML: lista em fluxo malformada'); } }
      if (s[i] === '{') { i++; const obj = {}; ws(); if (s[i] === '}') { i++; return obj; } for (;;) { ws(); const k = token(':'); i++; obj[k] = val(); ws(); if (s[i] === ',') { i++; continue; } if (s[i] === '}') { i++; return obj; } throw new Error('YAML: mapa em fluxo malformado'); } }
      return scalar(token(',]}'));
    }
    function token(stops) {
      ws();
      if (s[i] === '"' || s[i] === "'") { const q = s[i]; let j = i + 1; while (j < s.length && !(s[j] === q && s[j - 1] !== '\\')) j++; const t = s.slice(i, j + 1); i = j + 1; return q === '"' ? JSON.parse(t) : t.slice(1, -1); }
      let j = i; while (j < s.length && !stops.includes(s[j])) j++;
      const t = s.slice(i, j).trim(); i = j; return t;
    }
    return val();
  }

  function stripComment(line) {
    let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c;
      else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
    }
    return line;
  }
  // Divide "chave: valor" respeitando aspas na chave.
  function splitKey(t) {
    let q = null;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c;
      else if (c === ':' && (i === t.length - 1 || t[i + 1] === ' ')) {
        let k = t.slice(0, i).trim();
        if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) k = k.slice(1, -1);
        return [k, t.slice(i + 1)];
      }
    }
    return null;
  }

  function parse(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
      .map((raw) => ({ raw, ind: raw.match(/^ */)[0].length, t: stripComment(raw).trimEnd() }));
    let pos = 0;
    const skip = () => { while (pos < lines.length && (!lines[pos].t.trim() || lines[pos].t.trim() === '---')) pos++; };

    function block(ind, style) {
      const out = [];
      while (pos < lines.length) {
        const l = lines[pos];
        if (l.raw.trim() && l.ind < ind) break;
        out.push(l.raw.slice(Math.min(ind, l.ind)));
        pos++;
      }
      while (out.length && !out[out.length - 1].trim()) out.pop();
      if (style === '>') return out.join('\n').replace(/([^\n])\n(?=[^\n ])/g, '$1 ') + '\n';
      return out.join('\n') + '\n';
    }

    function node(ind) {
      skip();
      if (pos >= lines.length) return null;
      const l = lines[pos];
      if (l.ind < ind) return null;
      return l.t.trimStart().startsWith('- ') || l.t.trim() === '-' ? list(l.ind) : map(l.ind);
    }
    function valueAfter(rest, parentInd) {
      const v = rest.trim();
      if (v === '|' || v === '|-' || v === '>' || v === '>-' || v === '|+' || v === '>+') {
        skip(); const ind = pos < lines.length ? lines[pos].ind : parentInd + 2;
        const txt = block(ind, v[0]);
        return v.endsWith('-') ? txt.replace(/\n$/, '') : txt;
      }
      if (v === '') { skip(); return pos < lines.length && lines[pos].ind > parentInd ? node(lines[pos].ind) : (pos < lines.length && lines[pos].ind === parentInd && lines[pos].t.trimStart().startsWith('- ') ? list(parentInd) : null); }
      if (v.startsWith('&') || v.startsWith('*')) throw new Error('YAML com âncoras (&, *) não é suportado — use a versão JSON da especificação.');
      return scalar(v);
    }
    function map(ind) {
      const obj = {};
      for (;;) {
        skip();
        if (pos >= lines.length) break;
        const l = lines[pos];
        if (l.ind !== ind || l.t.trimStart().startsWith('- ')) break;
        const kv = splitKey(l.t.trim());
        if (!kv) throw new Error(`YAML: linha ${pos + 1} inesperada: "${l.t.trim().slice(0, 40)}"`);
        pos++;
        obj[kv[0]] = valueAfter(kv[1], ind);
      }
      return obj;
    }
    function list(ind) {
      const arr = [];
      for (;;) {
        skip();
        if (pos >= lines.length) break;
        const l = lines[pos];
        if (l.ind !== ind || !(l.t.trimStart().startsWith('- ') || l.t.trim() === '-')) break;
        const rest = l.t.trim().slice(1);
        const itemInd = ind + (l.t.length - l.t.trimStart().length - ind) + 2;
        if (!rest.trim()) { pos++; arr.push(node(ind + 1)); continue; }
        const kv = splitKey(rest.trim());
        if (kv && !rest.trim().startsWith('{') && !rest.trim().startsWith('"')) {
          // "- chave: valor" abre um mapa cujos demais campos vêm alinhados após o "- "
          lines[pos] = { raw: ' '.repeat(itemInd) + rest.trim(), ind: itemInd, t: ' '.repeat(itemInd) + rest.trim() };
          arr.push(map(itemInd));
        } else { pos++; arr.push(valueAfter(rest, ind)); }
      }
      return arr;
    }
    skip();
    return node(0);
  }

  return { parse };
});
