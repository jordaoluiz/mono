// Collection Runner: arquivos de dados (CSV/JSON), resumo e relatório da execução.
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.MonoRunner = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // CSV com aspas, quebras de linha dentro de aspas e separador , ; ou tab (Excel em português usa ;).
  function parseCsv(text) {
    const src = String(text || '').replace(/^﻿/, '');
    const firstLine = src.split(/\r?\n/)[0] || '';
    const count = (ch) => (firstLine.match(new RegExp(ch === '\t' ? '\t' : '\\' + ch, 'g')) || []).length;
    const sep = [';', ',', '\t'].sort((a, b) => count(b) - count(a))[0];
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (q) {
        if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"' && cell === '') q = true;
      else if (c === sep) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && src[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some((x) => x !== '')) rows.push(row);
        row = [];
      } else cell += c;
    }
    row.push(cell);
    if (row.some((x) => x !== '')) rows.push(row);
    if (!rows.length) return { columns: [], rows: [], separator: sep };
    const columns = rows[0].map((h, i) => h.trim() || `coluna${i + 1}`);
    return { columns, separator: sep, rows: rows.slice(1).map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? '']))) };
  }

  // Arquivo de dados do Runner: JSON (lista de objetos) ou CSV.
  function parseDataFile(text, name = '') {
    const t = String(text || '').trim();
    if (/\.json$/i.test(name) || /^[[{]/.test(t)) {
      let v;
      try { v = JSON.parse(t); } catch (e) { throw new Error('JSON inválido: ' + e.message); }
      if (!Array.isArray(v)) v = [v];
      if (!v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) throw new Error('O JSON precisa ser uma lista de objetos, ex.: [{ "cpf": "..." }]');
      const columns = [...new Set(v.flatMap((x) => Object.keys(x)))];
      return { kind: 'JSON', columns, rows: v };
    }
    const c = parseCsv(t);
    if (!c.columns.length) throw new Error('Arquivo vazio.');
    return { kind: `CSV (${c.separator === '\t' ? 'tab' : c.separator})`, columns: c.columns, rows: c.rows };
  }

  // Linha de dados para a iteração i (como no Postman, repete a última se houver mais iterações que linhas).
  const rowFor = (rows, i) => (rows && rows.length ? rows[Math.min(i, rows.length - 1)] : {});

  function summarize(records) {
    const reqs = records.filter((r) => !r.skipped);
    const tests = records.flatMap((r) => r.tests || []).filter((t) => !t.skipped);
    const times = reqs.map((r) => r.time).filter((x) => typeof x === 'number');
    const failedReqs = records.filter((r) => r.error || (r.tests || []).some((t) => !t.pass && !t.skipped));
    return {
      requests: reqs.length, skipped: records.length - reqs.length,
      testsPassed: tests.filter((t) => t.pass).length, testsFailed: tests.filter((t) => !t.pass).length,
      errors: records.filter((r) => r.error).length, failedRequests: failedReqs.length,
      avgTime: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0,
      totalTime: times.reduce((a, b) => a + b, 0),
    };
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function reportHtml(run) {
    const s = summarize(run.records);
    const rows = run.records.map((r) => {
      const failed = r.error || (r.tests || []).some((t) => !t.pass && !t.skipped);
      const tests = (r.tests || []).map((t) => `<li class="${t.skipped ? 'sk' : t.pass ? 'ok' : 'ko'}">${t.skipped ? 'PULADO' : t.pass ? 'PASSOU' : 'FALHOU'} · ${esc(t.name)}${t.error ? ` <span>${esc(t.error)}</span>` : ''}</li>`).join('');
      return `<tr class="${failed ? 'fail' : ''}"><td>${r.iteration + 1}</td><td><b class="m">${esc(r.method)}</b> ${esc(r.name)}<div class="u">${esc(r.url || '')}</div>${r.error ? `<div class="e">${esc(r.error)}</div>` : ''}${tests ? `<ul>${tests}</ul>` : ''}</td><td>${r.skipped ? 'pulada' : r.status ?? '—'}</td><td>${r.time != null ? r.time + ' ms' : ''}</td></tr>`;
    }).join('');
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Execução · ${esc(run.name)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:32px;color:#111;background:#fff}h1{font-size:20px;margin:0}.sub{color:#666;margin:4px 0 20px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}.card{border:1px solid #e5e5e5;border-radius:10px;padding:10px 14px;min-width:120px}.card b{display:block;font-size:20px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #eee;padding:8px;text-align:left;vertical-align:top}tr.fail td:first-child{border-left:3px solid #d1242f}
.m{font-family:ui-monospace,monospace;font-size:12px}.u{color:#666;font:12px ui-monospace,monospace;word-break:break-all}.e{color:#d1242f}ul{margin:6px 0 0;padding-left:18px;font-size:13px}li.ok{color:#1a7f37}li.ko{color:#d1242f}li.sk{color:#888}li span{color:#666}</style></head><body>
<h1>${esc(run.name)}</h1><p class="sub">${esc(run.envName ? 'Ambiente: ' + run.envName + ' · ' : '')}${new Date(run.startedAt).toLocaleString('pt-BR')} · ${run.iterations} iteração(ões)${run.dataFile ? ' · dados: ' + esc(run.dataFile) : ''}</p>
<div class="cards"><div class="card"><b>${s.requests}</b>requisições</div><div class="card"><b style="color:#1a7f37">${s.testsPassed}</b>testes passaram</div><div class="card"><b style="color:#d1242f">${s.testsFailed}</b>testes falharam</div><div class="card"><b>${s.errors}</b>erros de rede/script</div><div class="card"><b>${s.avgTime} ms</b>tempo médio</div></div>
<table><tr><th>#</th><th>Requisição</th><th>Status</th><th>Tempo</th></tr>${rows}</table></body></html>`;
  }

  return { parseCsv, parseDataFile, rowFor, summarize, reportHtml };
});
