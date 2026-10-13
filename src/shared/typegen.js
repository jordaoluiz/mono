// Gera C# (records), TypeScript (interfaces) e Zod a partir da forma inferida de um JSON.
(function (root, factory) {
  const m = factory(typeof module === 'object' && module.exports ? require('./shape') : root.MonoShape);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.MonoTypegen = m;
})(typeof self !== 'undefined' ? self : this, function (Shape) {
  'use strict';

  const stripAccents = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  function pascal(raw) {
    const words = stripAccents(String(raw))
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean);
    let s = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
    if (!s) s = 'Item';
    if (/^\d/.test(s)) s = '_' + s;
    return s;
  }
  function singular(name) {
    if (/ies$/.test(name)) return name.slice(0, -3) + 'y';
    if (/(ss|us|is)$/.test(name)) return name;
    if (/oes$/.test(name)) return name.slice(0, -2);        // Botoes -> Botao? mantém simples
    if (/[^s]s$/.test(name)) return name.slice(0, -1);
    return name + 'Item';
  }

  // Coleta os tipos-objeto nomeados, filhos antes dos pais (ordem de declaração para o Zod).
  function collect(shape, rootName) {
    const types = [];
    const used = new Set();
    const unique = (n) => { let x = n, i = 2; while (used.has(x)) x = n + i++; used.add(x); return x; };
    function visit(s, name) {
      if (!s) return s;
      if (s.t === 'object') {
        const typeName = unique(name);
        const fields = Object.entries(s.props).map(([key, p]) => {
          const child = p.s;
          let ref = child;
          if (child.t === 'object') ref = visit(child, pascal(key));
          else if (child.t === 'array') ref = visitArray(child, key);
          return { key, optional: p.optional, shape: ref };
        });
        types.push({ name: typeName, fields });
        return { ...s, ref: typeName };
      }
      if (s.t === 'array') return visitArray(s, name);
      return s;
    }
    function visitArray(s, key) {
      if (!s.items) return s;
      if (s.items.t === 'object') return { ...s, items: visit(s.items, singular(pascal(key))) };
      if (s.items.t === 'array') return { ...s, items: visitArray(s.items, key) };
      return s;
    }
    const top = visit(shape, rootName);
    return { types, top };
  }

  const isIdent = (k) => /^[A-Za-z_$][\w$]*$/.test(k);

  // ---------- TypeScript ----------
  function tsType(s) {
    if (!s) return 'unknown[]';
    let t;
    switch (s.t) {
      case 'object': t = s.ref; break;
      case 'array': t = s.items ? `${wrapTs(tsType(s.items))}[]` : 'unknown[]'; break;
      case 'string': t = 'string'; break;
      case 'integer': case 'number': t = 'number'; break;
      case 'boolean': t = 'boolean'; break;
      case 'null': t = 'null'; break;
      default: t = 'unknown';
    }
    return s.nullable && t !== 'null' && t !== 'unknown' ? `${t} | null` : t;
  }
  const wrapTs = (t) => (t.includes('|') ? `(${t})` : t);
  function toTypeScript(json, rootName = 'Root') {
    const { types, top } = collect(Shape.inferShape(json), pascal(rootName));
    const out = [];
    for (const t of types) {
      out.push(`export interface ${t.name} {`);
      for (const f of t.fields) out.push(`  ${isIdent(f.key) ? f.key : JSON.stringify(f.key)}${f.optional ? '?' : ''}: ${tsType(f.shape)};`);
      out.push('}', '');
    }
    if (top.t !== 'object') out.push(`export type ${pascal(rootName)} = ${tsType(top)};`, '');
    return out.join('\n').trimEnd() + '\n';
  }

  // ---------- Zod ----------
  function zodType(s) {
    if (!s) return 'z.array(z.unknown())';
    let t;
    switch (s.t) {
      case 'object': t = `${s.ref}Schema`; break;
      case 'array': t = `z.array(${s.items ? zodType(s.items) : 'z.unknown()'})`; break;
      case 'string':
        t = s.format === 'date-time' ? 'z.string().datetime({ offset: true })' : s.format === 'uuid' ? 'z.string().uuid()' : s.format === 'date' ? 'z.string().date()' : 'z.string()';
        break;
      case 'integer': t = 'z.number().int()'; break;
      case 'number': t = 'z.number()'; break;
      case 'boolean': t = 'z.boolean()'; break;
      case 'null': t = 'z.null()'; break;
      default: t = 'z.unknown()';
    }
    return s.nullable && s.t !== 'null' && s.t !== 'any' ? `${t}.nullable()` : t;
  }
  function toZod(json, rootName = 'Root') {
    const { types, top } = collect(Shape.inferShape(json), pascal(rootName));
    const out = ["import { z } from 'zod';", ''];
    for (const t of types) {
      out.push(`export const ${t.name}Schema = z.object({`);
      for (const f of t.fields) out.push(`  ${isIdent(f.key) ? f.key : JSON.stringify(f.key)}: ${zodType(f.shape)}${f.optional ? '.optional()' : ''},`);
      out.push('});', `export type ${t.name} = z.infer<typeof ${t.name}Schema>;`, '');
    }
    if (top.t !== 'object') {
      const n = pascal(rootName);
      out.push(`export const ${n}Schema = ${zodType(top)};`, `export type ${n} = z.infer<typeof ${n}Schema>;`, '');
    }
    return out.join('\n').trimEnd() + '\n';
  }

  // ---------- C# (records posicionais + System.Text.Json) ----------
  function csType(s, ctx) {
    if (!s) return 'List<JsonElement>';
    let t;
    switch (s.t) {
      case 'object': t = s.ref; break;
      case 'array': t = `List<${s.items ? csType(s.items, ctx) : (ctx.json = true, 'JsonElement')}>`; break;
      case 'string': t = s.format === 'date-time' ? 'DateTimeOffset' : s.format === 'uuid' ? 'Guid' : s.format === 'date' ? 'DateOnly' : 'string'; break;
      case 'integer': t = s.big ? 'long' : 'int'; break;
      case 'number': t = 'double'; break;
      case 'boolean': t = 'bool'; break;
      case 'null': t = 'object'; break;
      default: ctx.json = true; t = 'JsonElement';
    }
    return t;
  }
  function toCSharp(json, rootName = 'Root') {
    const ctx = { json: false };
    const { types, top } = collect(Shape.inferShape(json), pascal(rootName));
    const body = [];
    for (const t of [...types].reverse()) {
      const used = new Set();
      body.push(`public record ${t.name}(`);
      const lines = t.fields.map((f) => {
        let name = pascal(f.key);
        if (name === t.name) name += 'Value';
        let n = name, i = 2; while (used.has(n)) n = name + i++; used.add(n);
        let type = csType(f.shape, ctx);
        const nullable = f.optional || f.shape.nullable || f.shape.t === 'null';
        if (nullable && !type.endsWith('?')) type += '?';
        return `    [property: JsonPropertyName(${JSON.stringify(f.key)})] ${type} ${n}`;
      });
      body.push(lines.join(',\n'), ');', '');
    }
    if (top.t !== 'object') body.push(`// A resposta é ${top.t === 'array' ? 'uma lista' : 'um valor simples'}: desserialize como ${csType(top, ctx)}`, '');
    const head = ['using System.Text.Json.Serialization;'];
    if (ctx.json) head.unshift('using System.Text.Json;');
    const code = body.join('\n');
    if (/List</.test(code)) head.unshift('using System.Collections.Generic;');
    if (/\b(DateTimeOffset|DateOnly|Guid)\b/.test(code)) head.unshift('using System;');
    return [...head, '', ...body].join('\n').trimEnd() + '\n';
  }

  return { toTypeScript, toZod, toCSharp, pascal, singular };
});
