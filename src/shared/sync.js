// Sincronização de workspaces compartilhados: o que é compartilhado, diferença entre duas versões em
// operações por item (coleção, pasta, requisição, ambiente, globais) e aplicação dessas operações.
// O mesmo código roda no servidor (para gravar) e no app (para enviar e para receber dos colegas).
// Conflito: vence a última gravação de cada item — duas pessoas editando requisições diferentes não se atrapalham.
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.MonoSync = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const LOCAL_ONLY = ['open']; // estado da árvore (aberta/fechada) é de cada pessoa
  const strip = (o, extra = []) => { const c = clone(o) || {}; for (const k of [...LOCAL_ONLY, ...extra]) delete c[k]; return c; };
  // Segredos (cadeado) nunca saem do computador: vão vazios e cada pessoa preenche o seu.
  const hideSecrets = (vars) => (vars || []).map((v) => (v && v.secret ? { ...v, value: '' } : v));

  // Parte compartilhada de um workspace, sem estado local nem segredos.
  function shareable(d) {
    d = d || {};
    return {
      collections: (d.collections || []).map((c) => ({
        ...strip(c, ['requests', 'folders']),
        folders: (c.folders || []).map((f) => strip(f)),
        requests: (c.requests || []).map((r) => clone(r)),
      })),
      environments: (d.environments || []).map((e) => ({ ...clone(e), vars: hideSecrets(e.vars) })),
      globals: { ...clone(d.globals || {}), vars: hideSecrets((d.globals || {}).vars) },
    };
  }

  const ids = (list) => (list || []).map((x) => x.id);
  function diffList(base, cur, mk) {
    const ops = [];
    const b = new Map((base || []).map((x) => [x.id, x]));
    const c = new Set(ids(cur));
    for (const x of cur || []) if (!b.has(x.id) || !same(b.get(x.id), x)) ops.push(mk.up(x));
    for (const x of base || []) if (!c.has(x.id)) ops.push(mk.del(x.id));
    const kept = ids(base).filter((id) => c.has(id));
    const curOld = ids(cur).filter((id) => b.has(id));
    if (!same(kept, curOld)) ops.push(mk.order(ids(cur)));
    return ops;
  }

  // Operações que transformam `base` em `cur` (ambos no formato de shareable()).
  function diff(base, cur) {
    base = base || shareable({}); cur = cur || shareable({});
    const meta = (c) => strip(c, ['requests', 'folders']);
    const ops = [];
    const bCols = new Map(base.collections.map((c) => [c.id, c]));
    ops.push(...diffList(base.collections.map(meta), cur.collections.map(meta), {
      up: (v) => ({ t: 'col', id: v.id, v }), del: (id) => ({ t: 'colDel', id }), order: (list) => ({ t: 'colOrder', ids: list }),
    }));
    for (const c of cur.collections) {
      const b = bCols.get(c.id) || { folders: [], requests: [] };
      ops.push(...diffList(b.folders, c.folders, {
        up: (v) => ({ t: 'fold', col: c.id, id: v.id, v }), del: (id) => ({ t: 'foldDel', col: c.id, id }), order: (list) => ({ t: 'foldOrder', col: c.id, ids: list }),
      }));
      ops.push(...diffList(b.requests, c.requests, {
        up: (v) => ({ t: 'req', col: c.id, id: v.id, v }), del: (id) => ({ t: 'reqDel', col: c.id, id }), order: (list) => ({ t: 'reqOrder', col: c.id, ids: list }),
      }));
    }
    ops.push(...diffList(base.environments, cur.environments, {
      up: (v) => ({ t: 'env', id: v.id, v }), del: (id) => ({ t: 'envDel', id }), order: (list) => ({ t: 'envOrder', ids: list }),
    }));
    if (!same(base.globals, cur.globals)) ops.push({ t: 'globals', v: cur.globals });
    return ops;
  }

  // ---------- aplicar ----------
  function reorder(list, order) {
    const pos = new Map(order.map((id, i) => [id, i]));
    const known = list.filter((x) => pos.has(x.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id));
    const rest = list.filter((x) => !pos.has(x.id));
    list.splice(0, list.length, ...known, ...rest);
  }
  function upsert(list, v, merge) {
    const i = list.findIndex((x) => x.id === v.id);
    if (i === -1) list.push(merge(null, v));
    else list[i] = merge(list[i], v);
  }
  const remove = (list, id) => { const i = list.findIndex((x) => x.id === id); if (i >= 0) list.splice(i, 1); };
  // Mantém o valor local das variáveis secretas (o que vem de fora chega vazio).
  function keepSecrets(oldVars, newVars) {
    const mine = new Map((oldVars || []).filter((v) => v && v.secret).map((v) => [v.key, v.value]));
    return (newVars || []).map((v) => (v && v.secret && mine.has(v.key) ? { ...v, value: mine.get(v.key) } : v));
  }

  // Aplica as operações em `d` (estado do app ou documento do servidor) e devolve `d`.
  function applyOps(d, ops) {
    d.collections ||= []; d.environments ||= []; d.globals ||= { vars: [] };
    const col = (id) => d.collections.find((c) => c.id === id);
    for (const op of ops || []) {
      const v = clone(op.v);
      switch (op.t) {
        case 'col': upsert(d.collections, v, (old, n) => ({ ...n, requests: old ? old.requests : [], folders: old ? old.folders || [] : [], ...(old && old.open !== undefined ? { open: old.open } : {}) })); break;
        case 'colDel': remove(d.collections, op.id); break;
        case 'colOrder': reorder(d.collections, op.ids); break;
        case 'fold': { const c = col(op.col); if (c) upsert(c.folders ||= [], v, (old, n) => ({ ...n, ...(old && old.open !== undefined ? { open: old.open } : {}) })); break; }
        case 'foldDel': { const c = col(op.col); if (c) remove(c.folders ||= [], op.id); break; }
        case 'foldOrder': { const c = col(op.col); if (c) reorder(c.folders ||= [], op.ids); break; }
        case 'req': { const c = col(op.col); if (c) upsert(c.requests ||= [], v, (old, n) => n); break; }
        case 'reqDel': { const c = col(op.col); if (c) remove(c.requests ||= [], op.id); break; }
        case 'reqOrder': { const c = col(op.col); if (c) reorder(c.requests ||= [], op.ids); break; }
        case 'env': upsert(d.environments, v, (old, n) => ({ ...n, vars: keepSecrets(old && old.vars, n.vars) })); break;
        case 'envDel': remove(d.environments, op.id); break;
        case 'envOrder': reorder(d.environments, op.ids); break;
        case 'globals': d.globals = { ...v, vars: keepSecrets(d.globals && d.globals.vars, v && v.vars) }; break;
        default: break;
      }
    }
    return d;
  }

  // Validação feita pelo servidor antes de gravar (o app nunca manda algo diferente disso).
  const TYPES = new Set(['col', 'colDel', 'colOrder', 'fold', 'foldDel', 'foldOrder', 'req', 'reqDel', 'reqOrder', 'env', 'envDel', 'envOrder', 'globals']);
  const okId = (s) => typeof s === 'string' && s.length > 0 && s.length <= 120;
  function validOps(ops) {
    if (!Array.isArray(ops) || ops.length > 5000) return 'Lista de alterações inválida.';
    for (const op of ops) {
      if (!op || typeof op !== 'object' || !TYPES.has(op.t)) return 'Alteração de tipo desconhecido.';
      if (/Order$/.test(op.t)) { if (!Array.isArray(op.ids) || !op.ids.every(okId)) return 'Ordem inválida.'; }
      else if (op.t !== 'globals' && !okId(op.id)) return 'Identificador inválido.';
      if (['fold', 'foldDel', 'foldOrder', 'req', 'reqDel', 'reqOrder'].includes(op.t) && !okId(op.col)) return 'Coleção inválida.';
      if (['col', 'fold', 'req', 'env', 'globals'].includes(op.t)) {
        if (!op.v || typeof op.v !== 'object' || Array.isArray(op.v)) return 'Conteúdo inválido.';
        if (op.t !== 'globals' && op.v.id !== op.id) return 'Identificador não confere.';
      }
    }
    return null;
  }

  // Descrição curta para o aviso "@fulano alterou …".
  function describe(ops, data) {
    const names = [];
    const colName = (id) => ((data && data.collections) || []).find((c) => c.id === id)?.name;
    for (const op of ops || []) {
      if (op.t === 'req') names.push(op.v.name || 'requisição');
      else if (op.t === 'col') names.push(op.v.name || 'coleção');
      else if (op.t === 'fold') names.push(op.v.name || 'pasta');
      else if (op.t === 'env') names.push(`ambiente ${op.v.name || ''}`.trim());
      else if (op.t === 'globals') names.push('variáveis globais');
      else if (/Del$/.test(op.t)) names.push(op.t === 'colDel' ? 'uma coleção' : op.t === 'envDel' ? 'um ambiente' : `item em ${colName(op.col) || 'coleção'}`);
    }
    const uniq = [...new Set(names)];
    if (!uniq.length) return 'reorganizou itens';
    return uniq.length <= 2 ? uniq.join(' e ') : `${uniq.slice(0, 2).join(', ')} e mais ${uniq.length - 2}`;
  }

  const USERNAME = /^[a-z0-9](?:[a-z0-9._]{1,28})[a-z0-9]$/;
  const normUser = (s) => String(s || '').trim().replace(/^@/, '').toLowerCase();

  return { shareable, diff, applyOps, validOps, describe, USERNAME, normUser, clone };
});
