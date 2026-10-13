// Inferência de "forma" (tipos) de um JSON e diffs entre respostas.
// Módulo puro: roda no Node (testes) e no navegador (window.MonoShape).
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.MonoShape = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ISO_DT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
  const ISO_D = /^\d{4}-\d{2}-\d{2}$/;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const MAX_ITEMS = 200;

  // ---------- Forma ----------
  function inferShape(v) {
    if (v === null) return { t: 'null' };
    if (Array.isArray(v)) {
      let items = null;
      for (const x of v.slice(0, MAX_ITEMS)) items = items ? merge(items, inferShape(x)) : inferShape(x);
      return { t: 'array', items };
    }
    switch (typeof v) {
      case 'string': {
        const s = { t: 'string' };
        if (ISO_DT.test(v)) s.format = 'date-time';
        else if (ISO_D.test(v)) s.format = 'date';
        else if (UUID.test(v)) s.format = 'uuid';
        return s;
      }
      case 'number':
        return Number.isInteger(v) ? (Math.abs(v) > 2147483647 ? { t: 'integer', big: true } : { t: 'integer' }) : { t: 'number' };
      case 'boolean': return { t: 'boolean' };
      case 'object': {
        const props = {};
        for (const [k, x] of Object.entries(v)) props[k] = { s: inferShape(x), optional: false };
        return { t: 'object', props };
      }
      default: return { t: 'any' };
    }
  }

  // Une duas formas (ex.: elementos de um array). Campos ausentes viram opcionais; null vira "nullable".
  function merge(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (a.t === 'null' && b.t === 'null') return { t: 'null' };
    if (a.t === 'null') return { ...b, nullable: true };
    if (b.t === 'null') return { ...a, nullable: true };
    const nullable = a.nullable || b.nullable || undefined;
    const withNull = (s) => (nullable ? { ...s, nullable: true } : s);
    if (a.t !== b.t) {
      if ((a.t === 'integer' && b.t === 'number') || (a.t === 'number' && b.t === 'integer')) return withNull({ t: 'number' });
      return withNull({ t: 'any' });
    }
    if (a.t === 'string') return withNull(a.format && a.format === b.format ? { t: 'string', format: a.format } : { t: 'string' });
    if (a.t === 'integer') return withNull(a.big || b.big ? { t: 'integer', big: true } : { t: 'integer' });
    if (a.t === 'array') return withNull({ t: 'array', items: a.items && b.items ? merge(a.items, b.items) : a.items || b.items });
    if (a.t === 'object') {
      const props = {};
      const keys = new Set([...Object.keys(a.props), ...Object.keys(b.props)]);
      for (const k of keys) {
        const x = a.props[k], y = b.props[k];
        if (x && y) props[k] = { s: merge(x.s, y.s), optional: x.optional || y.optional };
        else props[k] = { s: (x || y).s, optional: true };
      }
      return withNull({ t: 'object', props });
    }
    return withNull({ t: a.t });
  }

  function describe(s) {
    if (!s) return 'vazio';
    let d;
    switch (s.t) {
      case 'array': d = `array<${s.items ? describe(s.items).replace(' | null', '?') : 'vazio'}>`; break;
      case 'string': d = s.format ? `string(${s.format})` : 'string'; break;
      case 'integer': case 'number': d = 'number'; break;
      default: d = s.t;
    }
    return s.nullable ? `${d} | null` : d;
  }
  // Tipo "grosso" para detectar mudanças relevantes (integer e number contam como number).
  const coarse = (s) => (!s ? 'vazio' : s.t === 'integer' ? 'number' : s.t);

  const childPath = (path, key) => (/^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`);

  // Mudanças de contrato entre duas formas: campo novo, removido, tipo alterado, passou a aceitar null.
  function diffShape(oldS, newS, path = '$', out = []) {
    if (out.length > 300) return out;
    if (!oldS && !newS) return out;
    if (coarse(oldS) !== coarse(newS)) {
      if (!(oldS && oldS.t === 'null') && !(newS && newS.t === 'null')) {
        out.push({ kind: 'type', path, from: describe(oldS), to: describe(newS) });
        return out;
      }
    }
    if (oldS && newS && !!oldS.nullable !== !!newS.nullable && oldS.t !== 'null' && newS.t !== 'null') {
      out.push({ kind: 'nullable', path, from: describe(oldS), to: describe(newS) });
    }
    if (oldS && newS && oldS.t === 'object' && newS.t === 'object') {
      for (const k of Object.keys(newS.props)) {
        if (!oldS.props[k]) out.push({ kind: 'added', path: childPath(path, k), to: describe(newS.props[k].s) });
        else diffShape(oldS.props[k].s, newS.props[k].s, childPath(path, k), out);
      }
      for (const k of Object.keys(oldS.props)) if (!newS.props[k]) out.push({ kind: 'removed', path: childPath(path, k), from: describe(oldS.props[k].s) });
    } else if (oldS && newS && oldS.t === 'array' && newS.t === 'array' && oldS.items && newS.items) {
      diffShape(oldS.items, newS.items, path + '[]', out);
    }
    return out;
  }

  // ---------- Diff de valores (comparação entre ambientes) ----------
  const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  function preview(v) {
    if (v === undefined) return '—';
    const s = JSON.stringify(v);
    return s && s.length > 120 ? s.slice(0, 117) + '…' : s;
  }
  function diffJson(a, b, path = '$', out = [], limit = 500) {
    if (out.length >= limit) return out;
    const ka = kindOf(a), kb = kindOf(b);
    if (ka !== kb) { out.push({ kind: 'type', path, a: preview(a), b: preview(b), ta: ka, tb: kb }); return out; }
    if (ka === 'object') {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) {
        const p = childPath(path, k);
        if (!(k in b)) out.push({ kind: 'removed', path: p, a: preview(a[k]) });
        else if (!(k in a)) out.push({ kind: 'added', path: p, b: preview(b[k]) });
        else diffJson(a[k], b[k], p, out, limit);
        if (out.length >= limit) break;
      }
    } else if (ka === 'array') {
      if (a.length !== b.length) out.push({ kind: 'length', path, a: `${a.length} itens`, b: `${b.length} itens` });
      for (let i = 0; i < Math.min(a.length, b.length) && out.length < limit; i++) diffJson(a[i], b[i], `${path}[${i}]`, out, limit);
    } else if (a !== b) {
      out.push({ kind: 'changed', path, a: preview(a), b: preview(b) });
    }
    return out;
  }

  // Diff simples por linhas para respostas que não são JSON.
  function diffLines(a, b) {
    const la = String(a).split('\n'), lb = String(b).split('\n');
    const out = [];
    const n = Math.max(la.length, lb.length);
    for (let i = 0; i < n && out.length < 300; i++) {
      if (la[i] !== lb[i]) out.push({ kind: la[i] === undefined ? 'added' : lb[i] === undefined ? 'removed' : 'changed', path: `linha ${i + 1}`, a: la[i] ?? '—', b: lb[i] ?? '—' });
    }
    return out;
  }

  function tryJson(text) { try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; } }

  return { inferShape, merge, describe, diffShape, diffJson, diffLines, tryJson, childPath };
});
