// GraphQL: consulta de introspecção, schema compacto, autocompletar pelo schema e cores da query.
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.MonoGraphQL = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const INTROSPECTION = `query IntrospectionQuery {
  __schema {
    queryType { name } mutationType { name } subscriptionType { name }
    types {
      kind name description
      fields(includeDeprecated: true) { name description isDeprecated args { name description type { ...T } defaultValue } type { ...T } }
      inputFields { name description type { ...T } defaultValue }
      enumValues(includeDeprecated: true) { name description }
    }
  }
}
fragment T on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } }`;

  // "[String!]!" a partir do formato de introspecção.
  function typeStr(t) {
    if (!t) return '';
    if (t.kind === 'NON_NULL') return typeStr(t.ofType) + '!';
    if (t.kind === 'LIST') return '[' + typeStr(t.ofType) + ']';
    return t.name || '';
  }
  const baseName = (t) => { while (t && t.ofType) t = t.ofType; return t ? t.name : ''; };

  // Resposta da introspecção ({ data: { __schema } } ou o __schema direto) → schema compacto.
  function fromIntrospection(json) {
    const s = json && (json.data ? json.data.__schema : json.__schema || json);
    if (!s || !Array.isArray(s.types)) throw new Error('A resposta não tem o schema (__schema). O servidor pode ter a introspecção desligada.');
    const types = {};
    for (const t of s.types) {
      if (!t.name || t.name.startsWith('__')) continue;
      const fields = {};
      for (const f of t.fields || t.inputFields || []) {
        fields[f.name] = { type: typeStr(f.type), base: baseName(f.type), description: f.description || '', deprecated: !!f.isDeprecated,
          args: (f.args || []).map((a) => ({ name: a.name, type: typeStr(a.type), description: a.description || '' })) };
      }
      types[t.name] = { kind: t.kind, description: t.description || '', fields, values: (t.enumValues || []).map((v) => v.name) };
    }
    return {
      query: s.queryType && s.queryType.name, mutation: s.mutationType && s.mutationType.name, subscription: s.subscriptionType && s.subscriptionType.name,
      types, count: Object.keys(types).length,
    };
  }

  // Tira strings e comentários (sem mudar posições relevantes para o contexto).
  function clean(text) {
    return String(text || '').replace(/"""[\s\S]*?("""|$)/g, '""').replace(/"(?:\\.|[^"\\\n])*("|$)/g, '""').replace(/#[^\n]*/g, '');
  }

  // Contexto do cursor: tipo da seleção atual e, dentro de (), o campo cujos argumentos estão sendo escritos.
  function contextAt(schema, before) {
    const src = clean(before);
    const prefix = (src.match(/[_A-Za-z][_0-9A-Za-z]*$/) || [''])[0];
    const body = src.slice(0, src.length - prefix.length);
    const op = (body.match(/^\s*(query|mutation|subscription)\b/) || [, 'query'])[1];
    let rootType = schema[op] || schema.query;
    // pilha de seleções: cada item é o nome do tipo daquela seleção
    const stack = [];
    let lastField = null, lastWasOn = false, onType = null, paren = 0, argField = null, fragType = null;
    const tokens = body.match(/\.\.\.|[_A-Za-z][_0-9A-Za-z]*|[{}():$!\[\]=@,]/g) || [];
    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      if (paren > 0) { if (tk === '(') paren++; else if (tk === ')') { paren--; if (!paren) argField = null; } continue; }
      if (tk === '(') { paren = 1; argField = lastField; continue; }
      if (tk === 'fragment' && !stack.length) { fragType = tokens[i + 3]; continue; } // fragment Nome on Tipo {
      if (tk === '...') { lastWasOn = true; continue; }
      if (lastWasOn && tk === 'on') { onType = tokens[i + 1]; i++; lastWasOn = false; continue; }
      lastWasOn = false;
      if (tk === '{') {
        const cur = stack.length ? stack[stack.length - 1] : null;
        let next;
        if (onType) { next = onType; onType = null; }
        else if (!stack.length) next = fragType || rootType;
        else { const f = cur && schema.types[cur] && schema.types[cur].fields[lastField]; next = f ? f.base : null; }
        stack.push(next);
        lastField = null;
        continue;
      }
      if (tk === '}') { stack.pop(); lastField = null; if (!stack.length) fragType = null; continue; }
      if (/^[_A-Za-z]/.test(tk) && stack.length) {
        if (tokens[i + 1] === ':') { i++; continue; } // alias: nome do campo vem depois
        lastField = tk;
      }
    }
    return { prefix, type: stack.length ? stack[stack.length - 1] : null, inArgs: paren > 0, argField, parent: stack.length >= 1 ? stack[stack.length - 1] : null, depth: stack.length };
  }

  // Sugestões no formato do editor de código: { prefix, items: [{ label, detail }] }.
  function completions(schema, before, force = false) {
    if (!schema) return null;
    const ctx = contextAt(schema, before);
    if (!ctx.depth) {
      if (!force && ctx.prefix.length < 1) return null;
      const kw = ['query', 'mutation', 'subscription', 'fragment'].filter((k) => k.startsWith(ctx.prefix.toLowerCase()) && k !== ctx.prefix);
      return kw.length ? { prefix: ctx.prefix, items: kw.map((k) => ({ label: k, detail: 'operação' })) } : null;
    }
    const t = ctx.type && schema.types[ctx.type];
    if (!t) return null;
    if (!force && !ctx.prefix && !/[{\s,(]$/.test(before)) return null;
    const q = ctx.prefix.toLowerCase();
    let items;
    if (ctx.inArgs) {
      const f = t.fields[ctx.argField];
      items = (f ? f.args : []).filter((a) => a.name.toLowerCase().startsWith(q) && a.name !== ctx.prefix).map((a) => ({ label: a.name, detail: a.type, insert: a.name + ': ' }));
    } else {
      items = Object.entries(t.fields).filter(([k]) => k.toLowerCase().startsWith(q) && k !== ctx.prefix)
        .map(([k, f]) => ({ label: k, detail: f.type + (f.args.length ? ` (${f.args.map((a) => a.name).join(', ')})` : '') + (f.deprecated ? ' · obsoleto' : '') }));
      if ('__typename'.startsWith(q) && ctx.prefix !== '__typename') items.push({ label: '__typename', detail: 'String!' });
    }
    return items.length ? { prefix: ctx.prefix, items: items.slice(0, 60) } : null;
  }

  // Cores da query (mesmas classes do realce de JS do app).
  function highlight(text) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return String(text || '').replace(/("""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"?)|(#[^\n]*)|(\$[_A-Za-z][_0-9A-Za-z]*)|\b(query|mutation|subscription|fragment|on|true|false|null)\b|(@[_A-Za-z]+)|(-?\d+(?:\.\d+)?)|([_A-Za-z][_0-9A-Za-z]*)(?=\s*:)|([^"#$@\w]+|[\w]+)/g,
      (m, str, com, vr, kw, dir, num, key, rest) => {
        if (str) return `<span class="j-str">${esc(str)}</span>`;
        if (com) return `<span class="c-com">${esc(com)}</span>`;
        if (vr) return `<span class="j-num">${esc(vr)}</span>`;
        if (kw) return `<span class="c-kw">${esc(kw)}</span>`;
        if (dir) return `<span class="c-glob">${esc(dir)}</span>`;
        if (num) return `<span class="j-num">${esc(num)}</span>`;
        if (key) return `<span class="j-key">${esc(key)}</span>`;
        return esc(rest || m);
      });
  }

  // Nome da operação (para operationName quando há mais de uma).
  function operations(text) {
    const out = [];
    const re = /\b(query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)/g;
    let m; const src = clean(text);
    while ((m = re.exec(src))) out.push({ type: m[1], name: m[2] });
    return out;
  }

  return { INTROSPECTION, fromIntrospection, contextAt, completions, highlight, operations, typeStr };
});
