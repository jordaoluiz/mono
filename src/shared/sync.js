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
      monitors: (d.monitors || []).map((m) => clone(m)),
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
    ops.push(...diffList(base.monitors || [], cur.monitors || [], {
      up: (v) => ({ t: 'mon', id: v.id, v }), del: (id) => ({ t: 'monDel', id }), order: (list) => ({ t: 'monOrder', ids: list }),
    }));
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
    d.collections ||= []; d.environments ||= []; d.globals ||= { vars: [] }; d.monitors ||= [];
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
        case 'mon': upsert(d.monitors, v, (old, n) => n); break;
        case 'monDel': remove(d.monitors, op.id); break;
        case 'monOrder': reorder(d.monitors, op.ids); break;
        default: break;
      }
    }
    return d;
  }

  // Validação feita pelo servidor antes de gravar (o app nunca manda algo diferente disso).
  const TYPES = new Set(['col', 'colDel', 'colOrder', 'fold', 'foldDel', 'foldOrder', 'req', 'reqDel', 'reqOrder', 'env', 'envDel', 'envOrder', 'globals', 'mon', 'monDel', 'monOrder']);
  const okId = (s) => typeof s === 'string' && s.length > 0 && s.length <= 120;
  function validOps(ops) {
    if (!Array.isArray(ops) || ops.length > 5000) return 'Lista de alterações inválida.';
    for (const op of ops) {
      if (!op || typeof op !== 'object' || !TYPES.has(op.t)) return 'Alteração de tipo desconhecido.';
      if (/Order$/.test(op.t)) { if (!Array.isArray(op.ids) || !op.ids.every(okId)) return 'Ordem inválida.'; }
      else if (op.t !== 'globals' && !okId(op.id)) return 'Identificador inválido.';
      if (['fold', 'foldDel', 'foldOrder', 'req', 'reqDel', 'reqOrder'].includes(op.t) && !okId(op.col)) return 'Coleção inválida.';
      if (['col', 'fold', 'req', 'env', 'globals', 'mon'].includes(op.t)) {
        if (!op.v || typeof op.v !== 'object' || Array.isArray(op.v)) return 'Conteúdo inválido.';
        if (op.t !== 'globals' && op.v.id !== op.id) return 'Identificador não confere.';
      }
    }
    return null;
  }

  // Frase curta do que mudou, com o verbo: "alterou Get Booking", "excluiu Consulta e criou Nova". `before` = estado anterior.
  function describe(ops, before) {
    const find = (list, id) => (list || []).find((x) => x.id === id);
    const colOf = (id) => find(before && before.collections, id);
    const prevOf = (op) => {
      const kind = op.t.replace(/Del$/, '');
      if (kind === 'col') return colOf(op.id);
      if (kind === 'req') return find(colOf(op.col) && colOf(op.col).requests, op.id);
      if (kind === 'fold') return find(colOf(op.col) && colOf(op.col).folders, op.id);
      if (kind === 'env') return find(before && before.environments, op.id);
      if (kind === 'mon') return find(before && before.monitors, op.id);
      return null;
    };
    const label = { col: 'a coleção', fold: 'a pasta', req: '', env: 'o ambiente', mon: 'o monitor' };
    const phrases = [];
    for (const op of ops || []) {
      if (/Order$/.test(op.t)) continue;
      if (op.t === 'globals') { phrases.push(['alterou', 'as variáveis globais']); continue; }
      const kind = op.t.replace(/Del$/, '');
      const prev = before ? prevOf(op) : null;
      const name = (op.v && op.v.name) || (prev && prev.name) || 'item';
      const verb = /Del$/.test(op.t) ? 'excluiu' : before && !prev ? 'criou' : 'alterou';
      phrases.push([verb, `${label[kind] ? label[kind] + ' ' : ''}${name}`.trim()]);
    }
    if (!phrases.length) return 'reorganizou itens';
    const seen = new Set();
    const uniq = phrases.filter(([v, n]) => { const k = v + n; if (seen.has(k)) return false; seen.add(k); return true; });
    const byVerb = [];
    for (const [v, n] of uniq) { const g = byVerb.find((x) => x.v === v); if (g) g.n.push(n); else byVerb.push({ v, n: [n] }); }
    const join = (l) => (l.length <= 2 ? l.join(' e ') : `${l.slice(0, 2).join(', ')} e mais ${l.length - 2}`);
    return byVerb.map((g) => `${g.v} ${join(g.n)}`).join(', ');
  }

  // Operações que desfazem `ops` quando aplicadas depois delas. `before` é o estado anterior (formato shareable).
  function inverseOps(before, ops) {
    const work = clone(before || shareable({}));
    work.collections ||= []; work.environments ||= []; work.globals ||= { vars: [] }; work.monitors ||= [];
    const groups = [];
    const find = (list, id) => (list || []).find((x) => x.id === id);
    const col = (id) => find(work.collections, id);
    for (const op of ops || []) {
      const g = [];
      switch (op.t) {
        case 'col': { const c = col(op.id); g.push(c ? { t: 'col', id: op.id, v: strip(c, ['requests', 'folders']) } : { t: 'colDel', id: op.id }); break; }
        case 'colDel': {
          const c = col(op.id);
          if (c) {
            g.push({ t: 'col', id: c.id, v: strip(c, ['requests', 'folders']) });
            for (const f of c.folders || []) g.push({ t: 'fold', col: c.id, id: f.id, v: clone(f) });
            for (const r of c.requests || []) g.push({ t: 'req', col: c.id, id: r.id, v: clone(r) });
            g.push({ t: 'colOrder', ids: ids(work.collections) });
          }
          break;
        }
        case 'colOrder': g.push({ t: 'colOrder', ids: ids(work.collections) }); break;
        case 'fold': case 'req': {
          const c = col(op.col); if (!c) break;
          const list = op.t === 'fold' ? c.folders : c.requests;
          const old = find(list, op.id);
          g.push(old ? { t: op.t, col: op.col, id: op.id, v: clone(old) } : { t: op.t + 'Del', col: op.col, id: op.id });
          break;
        }
        case 'foldDel': case 'reqDel': {
          const c = col(op.col); if (!c) break;
          const kind = op.t === 'foldDel' ? 'fold' : 'req';
          const list = kind === 'fold' ? c.folders : c.requests;
          const old = find(list, op.id);
          if (old) g.push({ t: kind, col: op.col, id: op.id, v: clone(old) }, { t: kind + 'Order', col: op.col, ids: ids(list) });
          break;
        }
        case 'foldOrder': case 'reqOrder': { const c = col(op.col); if (c) g.push({ t: op.t, col: op.col, ids: ids(op.t === 'foldOrder' ? c.folders : c.requests) }); break; }
        case 'env': case 'mon': {
          const list = op.t === 'env' ? work.environments : work.monitors;
          const old = find(list, op.id);
          g.push(old ? { t: op.t, id: op.id, v: clone(old) } : { t: op.t + 'Del', id: op.id });
          break;
        }
        case 'envDel': case 'monDel': {
          const kind = op.t.slice(0, 3);
          const list = kind === 'env' ? work.environments : work.monitors;
          const old = find(list, op.id);
          if (old) g.push({ t: kind, id: op.id, v: clone(old) }, { t: kind + 'Order', ids: ids(list) });
          break;
        }
        case 'envOrder': g.push({ t: 'envOrder', ids: ids(work.environments) }); break;
        case 'monOrder': g.push({ t: 'monOrder', ids: ids(work.monitors) }); break;
        case 'globals': g.push({ t: 'globals', v: clone(work.globals) }); break;
        default: break;
      }
      groups.push(g);
      applyOps(work, [op]);
    }
    return groups.reverse().flat();
  }

  // Itens tocados por uma alteração (para o histórico por requisição): [{ t, col, id, name }].
  function itemsOf(ops, before) {
    const out = [], seen = new Set();
    const find = (list, id) => (list || []).find((x) => x.id === id);
    for (const op of ops || []) {
      if (/Order$/.test(op.t)) continue;
      const kind = op.t.replace(/Del$/, '');
      const key = kind + ':' + (op.col || '') + ':' + (op.id || '');
      if (seen.has(key)) continue;
      seen.add(key);
      let name = op.v && op.v.name;
      if (!name && before) {
        const c = find(before.collections, kind === 'col' ? op.id : op.col);
        const prev = kind === 'col' ? c : kind === 'req' ? find(c && c.requests, op.id) : kind === 'fold' ? find(c && c.folders, op.id)
          : kind === 'env' ? find(before.environments, op.id) : kind === 'mon' ? find(before.monitors, op.id) : null;
        name = prev && prev.name;
      }
      out.push({ t: kind, del: /Del$/.test(op.t), col: op.col || null, id: op.id || null, name: name || (kind === 'globals' ? 'variáveis globais' : '') });
    }
    return out;
  }

  const USERNAME = /^[a-z0-9](?:[a-z0-9._]{1,28})[a-z0-9]$/;
  const normUser = (s) => String(s || '').trim().replace(/^@/, '').toLowerCase();

  return { shareable, diff, applyOps, validOps, describe, inverseOps, itemsOf, USERNAME, normUser, clone };
});
