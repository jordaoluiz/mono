// Fluxos: requisições encadeadas num quadro, passando valores de uma para a outra, com condições e laços.
// Este módulo é a parte sem tela: modelo, validação, leitura de valores da resposta, condições e o executor.
// O app injeta `hooks.request` (que envia de verdade, com scripts, auth, cookies e certificado).
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.MonoFlows = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Tipos de bloco e as saídas de cada um.
  const TYPES = {
    start: { label: 'Início', ports: ['out'] },
    request: { label: 'Requisição', ports: ['ok', 'fail'] },
    condition: { label: 'Condição', ports: ['yes', 'no'] },
    loop: { label: 'Repetir', ports: ['each', 'done'] },
    set: { label: 'Definir variáveis', ports: ['out'] },
    delay: { label: 'Esperar', ports: ['out'] },
  };
  const PORT_LABEL = { out: '', ok: 'ok', fail: 'falhou', yes: 'sim', no: 'não', each: 'cada', done: 'fim' };
  const OPS = [
    ['==', 'é igual a'], ['!=', 'é diferente de'], ['>', 'maior que'], ['>=', 'maior ou igual a'], ['<', 'menor que'], ['<=', 'menor ou igual a'],
    ['contains', 'contém'], ['!contains', 'não contém'], ['empty', 'está vazio'], ['!empty', 'não está vazio'], ['matches', 'combina com (regex)'],
  ];
  const UNARY = new Set(['empty', '!empty']);
  const MAX_STEPS = 5000;
  const MAX_LOOP = 1000;

  let seq = 0;
  const nid = (p) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  function newFlow(name = 'Novo fluxo') {
    return { id: nid('flow'), name, nodes: [{ id: nid('n'), type: 'start', x: 80, y: 40, assign: [] }], edges: [] };
  }
  function newNode(type, x = 0, y = 0) {
    const n = { id: nid('n'), type, x, y };
    if (type === 'request') Object.assign(n, { ref: null, extract: [], stopOnFail: true });
    if (type === 'condition') Object.assign(n, { match: 'all', rules: [{ left: '{{res.status}}', op: '==', right: '200' }] });
    if (type === 'loop') Object.assign(n, { mode: 'count', count: 3, list: '', itemVar: 'item', indexVar: 'i', rules: [{ left: '', op: '!=', right: '' }], match: 'all', max: 20, wait: 0 });
    if (type === 'set') Object.assign(n, { assign: [{ key: '', value: '' }] });
    if (type === 'delay') Object.assign(n, { ms: 1000 });
    return n;
  }

  // ---------- leitura de valores ----------
  // Caminho estilo JS: data.items[0].id · $.data.id · items.length · ["campo com espaço"]
  function parsePath(p) {
    const s = String(p || '').trim().replace(/^\$\.?/, '');
    const out = [];
    const re = /\[(\d+|"[^"]*"|'[^']*')\]|([^.[\]]+)/g;
    let m;
    while ((m = re.exec(s))) {
      if (m[1] != null) out.push(/^\d+$/.test(m[1]) ? Number(m[1]) : m[1].slice(1, -1));
      else out.push(m[2]);
    }
    return out;
  }
  function getPath(obj, p) {
    let cur = obj;
    for (const k of parsePath(p)) {
      if (cur == null) return undefined;
      if (k === 'length' && (Array.isArray(cur) || typeof cur === 'string')) { cur = cur.length; continue; }
      if (Array.isArray(cur) && typeof k === 'string' && /^-\d+$/.test(k)) { cur = cur[cur.length + Number(k)]; continue; }
      cur = cur[k];
    }
    return cur;
  }
  const xmlUnescape = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
  // XML: nome da tag (sem prefixo), opcionalmente "pai/filha" e índice "tag[1]". Pega o texto. "@atributo" no fim pega atributo.
  function xmlValue(xml, path) {
    let text = String(xml || '');
    const parts = String(path || '').split('/').map((s) => s.trim()).filter(Boolean);
    let attr = null;
    if (parts.length && parts[parts.length - 1].startsWith('@')) attr = parts.pop().slice(1);
    if (!parts.length) return undefined;
    for (let i = 0; i < parts.length; i++) {
      const m = parts[i].match(/^([\w.-]+)(?:\[(\d+)\])?$/);
      if (!m) return undefined;
      const name = m[1], idx = m[2] ? Number(m[2]) : 0;
      const re = new RegExp(`<(?:[\\w.-]+:)?${name.replace(/[.-]/g, '\\$&')}(\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${name.replace(/[.-]/g, '\\$&')}>)`, 'g');
      let hit = null, k = 0, mm;
      while ((mm = re.exec(text))) { if (k++ === idx) { hit = mm; break; } }
      if (!hit) return undefined;
      if (i === parts.length - 1) {
        if (attr) { const a = (hit[1] || '').match(new RegExp(`(?:^|\\s)(?:[\\w.-]+:)?${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`)); return a ? xmlUnescape(a[2] ?? a[3]) : undefined; }
        const inner = hit[2] ?? '';
        return /</.test(inner) ? inner.trim() : xmlUnescape(inner.trim());
      }
      text = hit[2] ?? '';
    }
    return undefined;
  }
  // Uma regra de extração: { var, from: 'json'|'xml'|'header'|'status'|'time'|'text'|'regex', path }
  function extractOne(rule, res) {
    const from = rule.from || 'json';
    if (from === 'status') return res.status;
    if (from === 'time') return res.time;
    if (from === 'text') return res.body ?? '';
    if (from === 'header') {
      const h = (res.headers || []).find((x) => String(x.key).toLowerCase() === String(rule.path || '').trim().toLowerCase());
      return h ? h.value : undefined;
    }
    if (from === 'xml') return xmlValue(res.body, rule.path);
    if (from === 'regex') {
      let re; try { re = new RegExp(rule.path); } catch { return undefined; }
      const m = String(res.body || '').match(re);
      return m ? (m[1] !== undefined ? m[1] : m[0]) : undefined;
    }
    let json = res.json;
    if (json === undefined) { try { json = JSON.parse(res.body); } catch { return undefined; } }
    return rule.path && String(rule.path).trim() && String(rule.path).trim() !== '$' ? getPath(json, rule.path) : json;
  }

  // ---------- valores e modelos {{var}} ----------
  const asText = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  // Uma expressão que é só "{{x}}" devolve o valor cru (lista, objeto, número); senão monta texto.
  function resolve(tpl, vars) {
    const s = String(tpl ?? '');
    const whole = s.match(/^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/);
    if (whole) return lookup(whole[1], vars);
    return s.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, k) => { const v = lookup(k, vars); return v === undefined ? m : asText(v); });
  }
  // "pedido.itens[0].id": variável pedido e depois o caminho dentro dela.
  function lookup(expr, vars) {
    const k = String(expr).trim();
    if (Object.prototype.hasOwnProperty.call(vars, k)) return vars[k];
    const parts = parsePath(k);
    for (let i = parts.length - 1; i >= 1; i--) {
      const head = parts.slice(0, i).join('.');
      if (Object.prototype.hasOwnProperty.call(vars, head)) {
        let v = vars[head];
        if (typeof v === 'string' && /^\s*[[{]/.test(v)) { try { v = JSON.parse(v); } catch { /* texto */ } }
        let cur = v;
        for (const p of parts.slice(i)) { if (cur == null) return undefined; cur = p === 'length' && (Array.isArray(cur) || typeof cur === 'string') ? cur.length : cur[p]; }
        return cur;
      }
    }
    return undefined;
  }
  const isNum = (v) => v !== '' && v != null && typeof v !== 'object' && typeof v !== 'boolean' && !Number.isNaN(Number(v));
  function compare(left, op, right) {
    const l = left, r = right;
    switch (op) {
      case 'empty': return l == null || l === '' || (Array.isArray(l) && !l.length) || (typeof l === 'object' && !Array.isArray(l) && !Object.keys(l).length);
      case '!empty': return !compare(l, 'empty');
      case '==': return isNum(l) && isNum(r) ? Number(l) === Number(r) : asText(l) === asText(r);
      case '!=': return !compare(l, '==', r);
      case '>': case '>=': case '<': case '<=': {
        const a = isNum(l) ? Number(l) : asText(l), b = isNum(r) ? Number(r) : asText(r);
        if (typeof a !== typeof b) return false;
        return op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : a <= b;
      }
      case 'contains': return Array.isArray(l) ? l.some((x) => asText(x) === asText(r)) : asText(l).includes(asText(r));
      case '!contains': return !compare(l, 'contains', r);
      case 'matches': try { return new RegExp(asText(r)).test(asText(l)); } catch { return false; }
      default: return false;
    }
  }
  function evalRules(node, vars) {
    const rules = (node.rules || []).filter((r) => r && (String(r.left || '').trim() || UNARY.has(r.op)));
    if (!rules.length) return true;
    const results = rules.map((r) => compare(resolve(r.left, vars), r.op, UNARY.has(r.op) ? undefined : resolve(r.right, vars)));
    return node.match === 'any' ? results.some(Boolean) : results.every(Boolean);
  }
  function describeRules(node) {
    const rules = (node.rules || []).filter((r) => r && (String(r.left || '').trim() || UNARY.has(r.op)));
    if (!rules.length) return 'sempre';
    const opl = Object.fromEntries(OPS);
    return rules.map((r) => `${r.left} ${opl[r.op] || r.op}${UNARY.has(r.op) ? '' : ' ' + (r.right === '' ? '""' : r.right)}`).join(node.match === 'any' ? ' ou ' : ' e ');
  }
  function listOf(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      const s = v.trim();
      if (/^\[/.test(s)) { try { const a = JSON.parse(s); if (Array.isArray(a)) return a; } catch { /* lista em texto */ } }
      if (!s) return [];
      return s.split(/\r?\n|,/).map((x) => x.trim()).filter(Boolean);
    }
    if (v && typeof v === 'object') return Object.values(v);
    return v == null ? [] : [v];
  }

  // ---------- grafo ----------
  const nodeById = (flow, id) => (flow.nodes || []).find((n) => n.id === id) || null;
  const nextOf = (flow, id, port) => { const e = (flow.edges || []).find((x) => x.from === id && (x.port || 'out') === port); return e ? e.to : null; };
  function connect(flow, from, port, to) {
    flow.edges = (flow.edges || []).filter((e) => !(e.from === from && (e.port || 'out') === port));
    if (to && to !== from) flow.edges.push({ id: nid('e'), from, port, to });
    return flow;
  }
  function removeNode(flow, id) {
    flow.nodes = (flow.nodes || []).filter((n) => n.id !== id);
    flow.edges = (flow.edges || []).filter((e) => e.from !== id && e.to !== id);
    return flow;
  }

  // Problemas que impedem ou atrapalham a execução: [{ nodeId, level: 'erro'|'aviso', text }].
  function validate(flow, { reqExists = () => true } = {}) {
    const out = [];
    const nodes = flow.nodes || [];
    const starts = nodes.filter((n) => n.type === 'start');
    if (!starts.length) out.push({ nodeId: null, level: 'erro', text: 'O fluxo não tem bloco de Início.' });
    if (starts.length > 1) out.push({ nodeId: starts[1].id, level: 'erro', text: 'Só pode haver um bloco de Início.' });
    for (const n of nodes) {
      if (!TYPES[n.type]) { out.push({ nodeId: n.id, level: 'erro', text: 'Bloco de tipo desconhecido.' }); continue; }
      if (n.type === 'request') {
        if (!n.ref || !n.ref.reqId) out.push({ nodeId: n.id, level: 'erro', text: 'Escolha a requisição deste bloco.' });
        else if (!reqExists(n.ref)) out.push({ nodeId: n.id, level: 'erro', text: 'A requisição deste bloco foi excluída.' });
        for (const x of n.extract || []) if (x && x.var && !/^[\w.-]+$/.test(x.var)) out.push({ nodeId: n.id, level: 'erro', text: `Nome de variável inválido: ${x.var}` });
      }
      if (n.type === 'loop' && n.mode === 'list' && !String(n.list || '').trim()) out.push({ nodeId: n.id, level: 'erro', text: 'Diga qual lista percorrer.' });
      if (n.type === 'loop' && !nextOf(flow, n.id, 'each')) out.push({ nodeId: n.id, level: 'aviso', text: 'Nada ligado em "cada": o laço não faz nada.' });
    }
    const start = starts[0];
    if (start && !nextOf(flow, start.id, 'out')) out.push({ nodeId: start.id, level: 'aviso', text: 'Ligue o Início ao primeiro bloco.' });
    // blocos soltos
    if (start) {
      const seen = new Set([start.id]); const stack = [start.id];
      while (stack.length) { const id = stack.pop(); for (const e of flow.edges || []) if (e.from === id && !seen.has(e.to)) { seen.add(e.to); stack.push(e.to); } }
      for (const n of nodes) if (!seen.has(n.id)) out.push({ nodeId: n.id, level: 'aviso', text: 'Bloco solto: não é alcançado a partir do Início.' });
    }
    return out;
  }

  class FlowError extends Error { constructor(msg, nodeId) { super(msg); this.nodeId = nodeId; } }

  // Executa o fluxo. hooks: { request(node, vars, ctx) → { ok, failed, status, statusText, headers, body, time, size, error, testsFailed, tests },
  //   sleep(ms), onStep(step), stopped() → bool }. Devolve { ok, stopped, error, vars, steps }.
  async function run(flow, hooks = {}, initial = {}) {
    const vars = { ...initial };
    const steps = [];
    let count = 0;
    const sleep = hooks.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const stopped = () => !!(hooks.stopped && hooks.stopped());
    const push = (s) => { s.at = Date.now(); steps.push(s); if (hooks.onStep) hooks.onStep(s, steps); return s; };
    const start = (flow.nodes || []).find((n) => n.type === 'start');
    if (!start) return { ok: false, error: 'O fluxo não tem bloco de Início.', vars, steps };

    async function chain(fromId, stopAt, depth) {
      if (depth > 20) throw new FlowError('Laços aninhados demais (mais de 20).', fromId);
      let cur = fromId;
      while (cur && cur !== stopAt) {
        if (stopped()) return 'stopped';
        if (++count > MAX_STEPS) throw new FlowError(`O fluxo passou de ${MAX_STEPS} passos e foi interrompido (laço sem fim?).`, cur);
        const n = nodeById(flow, cur);
        if (!n) return null;
        switch (n.type) {
          case 'start': {
            const got = {};
            for (const a of n.assign || []) { if (!a || !String(a.key || '').trim() || Object.prototype.hasOwnProperty.call(vars, a.key.trim())) continue; const v = resolve(a.value, vars); vars[a.key.trim()] = v; got[a.key.trim()] = v; }
            if (Object.keys(got).length) push({ nodeId: n.id, type: 'start', state: 'ok', extracted: got });
            cur = nextOf(flow, n.id, 'out');
            break;
          }
          case 'request': {
            const step = push({ nodeId: n.id, type: 'request', state: 'running' });
            const t0 = Date.now();
            let res;
            try { res = await hooks.request(n, vars, { step }); } catch (e) { res = { ok: false, failed: true, error: (e && e.message) || String(e) }; }
            res = res || { ok: false, failed: true, error: 'Sem resposta.' };
            step.ms = res.time ?? Date.now() - t0;
            step.res = res;
            vars['res.status'] = res.status ?? null; vars['res.time'] = res.time ?? null;
            const got = {};
            if (res.ok) {
              for (const x of n.extract || []) {
                if (!x || !String(x.var || '').trim()) continue;
                const v = extractOne(x, res);
                vars[x.var.trim()] = v === undefined ? null : v;
                got[x.var.trim()] = v === undefined ? null : v;
              }
            }
            step.extracted = got;
            const failed = !res.ok || !!res.failed;
            step.state = failed ? 'fail' : 'ok';
            if (hooks.onStep) hooks.onStep(step, steps);
            const nxt = nextOf(flow, n.id, failed ? 'fail' : 'ok');
            if (failed && !nxt && n.stopOnFail !== false) throw new FlowError(res.error || (res.testsFailed ? `${res.testsFailed} teste(s) falharam.` : `Falhou (status ${res.status ?? '—'}).`), n.id);
            cur = nxt;
            break;
          }
          case 'condition': {
            const yes = evalRules(n, vars);
            push({ nodeId: n.id, type: 'condition', state: 'ok', result: yes, text: describeRules(n) });
            cur = nextOf(flow, n.id, yes ? 'yes' : 'no');
            break;
          }
          case 'set': {
            const got = {};
            for (const a of n.assign || []) { if (!a || !String(a.key || '').trim()) continue; const v = resolve(a.value, vars); vars[a.key.trim()] = v; got[a.key.trim()] = v; }
            push({ nodeId: n.id, type: 'set', state: 'ok', extracted: got });
            cur = nextOf(flow, n.id, 'out');
            break;
          }
          case 'delay': {
            const ms = Math.max(0, Math.min(10 * 60 * 1000, Number(resolve(n.ms, vars)) || 0));
            const step = push({ nodeId: n.id, type: 'delay', state: 'running', ms });
            await sleep(ms);
            step.state = 'ok'; if (hooks.onStep) hooks.onStep(step, steps);
            cur = nextOf(flow, n.id, 'out');
            break;
          }
          case 'loop': {
            const body = nextOf(flow, n.id, 'each');
            const itemVar = String(n.itemVar || 'item').trim() || 'item', indexVar = String(n.indexVar || 'i').trim() || 'i';
            const step = push({ nodeId: n.id, type: 'loop', state: 'running', iterations: 0 });
            const once = async (i, item) => {
              vars[indexVar] = i; if (item !== undefined) vars[itemVar] = item;
              step.iterations = i + 1; if (hooks.onStep) hooks.onStep(step, steps);
              if (body) { const r = await chain(body, n.id, depth + 1); if (r === 'stopped') return 'stopped'; }
              return null;
            };
            if (n.mode === 'list') {
              const items = listOf(resolve(n.list, vars)).slice(0, MAX_LOOP);
              step.total = items.length;
              for (let i = 0; i < items.length; i++) if ((await once(i, items[i])) === 'stopped') return 'stopped';
            } else if (n.mode === 'while') {
              const max = Math.max(1, Math.min(MAX_LOOP, Number(n.max) || 20));
              let i = 0;
              while (evalRules(n, vars)) {
                if (i >= max) { step.note = `Parou no limite de ${max} repetições.`; break; }
                if ((await once(i, undefined)) === 'stopped') return 'stopped';
                i++;
                const w = Number(resolve(n.wait, vars)) || 0;
                if (w > 0 && evalRules(n, vars) && i < max) await sleep(Math.min(w, 10 * 60 * 1000));
              }
            } else {
              const total = Math.max(0, Math.min(MAX_LOOP, Number(resolve(n.count, vars)) || 0));
              step.total = total;
              for (let i = 0; i < total; i++) if ((await once(i, undefined)) === 'stopped') return 'stopped';
            }
            step.state = 'ok'; if (hooks.onStep) hooks.onStep(step, steps);
            cur = nextOf(flow, n.id, 'done');
            break;
          }
          default: cur = null;
        }
      }
      return null;
    }

    try {
      const r = await chain(start.id, null, 0);
      if (r === 'stopped') return { ok: false, stopped: true, error: 'Interrompido.', vars, steps };
      return { ok: true, vars, steps };
    } catch (e) {
      const last = steps[steps.length - 1];
      if (last && last.state === 'running') last.state = 'fail';
      return { ok: false, error: (e && e.message) || String(e), nodeId: e && e.nodeId, vars, steps };
    }
  }

  // Validação do formato para o servidor (fluxos sincronizam com o workspace).
  function validShape(f) {
    if (!f || typeof f !== 'object' || !Array.isArray(f.nodes) || !Array.isArray(f.edges)) return 'Fluxo inválido.';
    if (f.nodes.length > 500 || f.edges.length > 2000) return 'Fluxo grande demais.';
    return null;
  }

  // Todos os caminhos de um JSON com o valor (para escolher o que extrair clicando).
  function leafPaths(v, max = 400) {
    const out = [];
    const walk = (x, p, depth) => {
      if (out.length >= max) return;
      if (x && typeof x === 'object' && depth < 8) {
        const arr = Array.isArray(x);
        if (p) out.push({ path: p, value: x, kind: arr ? 'lista' : 'objeto' });
        const keys = arr ? x.slice(0, 3).map((_, i) => i) : Object.keys(x);
        for (const k of keys) walk(x[k], arr ? `${p}[${k}]` : p ? (/^[A-Za-z_$][\w$]*$/.test(k) ? `${p}.${k}` : `${p}["${k}"]`) : (/^[A-Za-z_$][\w$]*$/.test(k) ? k : `["${k}"]`), depth + 1);
      } else if (p) out.push({ path: p, value: x, kind: x === null ? 'null' : typeof x });
    };
    walk(v, '', 0);
    return out;
  }
  const varNameFor = (path) => { const segs = parsePath(path).filter((k) => typeof k === 'string'); return (segs[segs.length - 1] || 'valor').replace(/[^\w.-]/g, '_'); };

  return { leafPaths, varNameFor, TYPES, PORT_LABEL, OPS, UNARY, newFlow, newNode, parsePath, getPath, xmlValue, extractOne, resolve, lookup, compare, evalRules, describeRules, listOf, nextOf, nodeById, connect, removeNode, validate, run, validShape, asText };
});
