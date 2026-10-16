// Gera testes pm.test a partir de uma resposta: status, tempo, Content-Type e, para JSON, campos e tipos.
// É o ponto de partida (sem IA); a IA pode refinar com regras de negócio.
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.MonoTestgen = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const q = (s) => JSON.stringify(String(s));
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  const chaiType = { string: "a('string')", number: "a('number')", boolean: "a('boolean')", object: "an('object')", array: "an('array')", null: 'null' };
  const isId = (k) => /^[A-Za-z_$][\w$]*$/.test(k);
  const acc = (base, k) => (isId(k) ? `${base}.${k}` : `${base}[${q(k)}]`);

  // Linhas de pm.expect para os campos de um objeto (até 2 níveis, até 25 campos por nível).
  function fieldChecks(obj, base, depth, lines) {
    const keys = Object.keys(obj).slice(0, 25);
    for (const k of keys) {
      const v = obj[k], t = typeOf(v), path = acc(base, k);
      lines.push(`  pm.expect(${base}).to.have.property(${q(k)});`);
      if (t === 'null') continue; // pode ser nulo às vezes: não trava o tipo
      lines.push(`  pm.expect(${path}).to.be.${chaiType[t]};`);
      if (t === 'object' && depth < 2) fieldChecks(v, path, depth + 1, lines);
    }
  }

  function generate(res, { maxMs = null } = {}) {
    const out = [];
    const status = Number(res.status) || 200;
    out.push(`pm.test(${q(`Status ${status}`)}, () => {\n  pm.response.to.have.status(${status});\n});`);
    const limit = maxMs || Math.max(1000, Math.ceil(((Number(res.time) || 300) * 3) / 500) * 500);
    out.push(`pm.test(${q(`Responde em menos de ${limit >= 1000 ? (limit / 1000).toLocaleString('pt-BR') + ' s' : limit + ' ms'}`)}, () => {\n  pm.expect(pm.response.responseTime).to.be.below(${limit});\n});`);
    const ct = String(res.contentType || '').split(';')[0].trim();
    if (ct) out.push(`pm.test(${q(`Content-Type ${ct}`)}, () => {\n  pm.expect(pm.response.headers.get('Content-Type')).to.include(${q(ct)});\n});`);
    let json; let isJson = false;
    try { if (res.body != null && /json/i.test(ct || '') || /^\s*[[{]/.test(res.body || '')) { json = JSON.parse(res.body); isJson = true; } } catch { isJson = false; }
    if (isJson) {
      const t = typeOf(json);
      if (t === 'object') {
        const lines = [`  pm.expect(json).to.be.an('object');`];
        fieldChecks(json, 'json', 1, lines);
        out.push(`const json = pm.response.json();\n\npm.test("Estrutura do corpo", () => {\n${lines.join('\n')}\n});`);
      } else if (t === 'array') {
        const lines = [`  pm.expect(json).to.be.an('array');`];
        if (json.length) lines.push(`  pm.expect(json.length).to.be.above(0);`);
        const first = json.find((x) => x && typeOf(x) === 'object');
        if (first) { lines.push(`  const item = json[0];`); fieldChecks(first, 'item', 1, lines); }
        out.push(`const json = pm.response.json();\n\npm.test("Estrutura da lista", () => {\n${lines.join('\n')}\n});`);
      }
    } else if (res.body && /xml/i.test(ct)) {
      const root = (String(res.body).match(/<(?:[\w-]+:)?([\w-]+)[\s>]/) || [])[1];
      if (root) out.push(`pm.test(${q(`Corpo XML com <${root}>`)}, () => {\n  pm.expect(pm.response.text()).to.include(${q('<')});\n  pm.expect(pm.response.text()).to.match(/<([\\w-]+:)?${root}[\\s>]/);\n});`);
    }
    return out.join('\n\n') + '\n';
  }

  // Pedido para a IA: devolve só código JavaScript usando a API pm.*.
  function aiPrompt(req, res) {
    const body = String(res.body || '').slice(0, 9000);
    const headers = (res.headers || []).slice(0, 30).map((h) => `${h.key}: ${String(h.value).slice(0, 200)}`).join('\n');
    return `Requisição: ${req.method} ${req.url}\nStatus: ${res.status} ${res.statusText || ''}\nTempo: ${res.time} ms\nHeaders da resposta:\n${headers}\n\nCorpo da resposta${String(res.body || '').length > 9000 ? ' (cortado)' : ''}:\n${body}\n\n` +
      'Escreva testes para esta resposta usando a API do Postman (pm.test, pm.expect estilo Chai, pm.response). Cubra: status, tempo, Content-Type, campos obrigatórios e tipos, formatos (datas ISO, e-mails, CPFs/CNPJs, chaves de NF-e, valores monetários não negativos) e regras de negócio óbvias pelos dados. ' +
      'Nomes dos testes em português. Não use bibliotecas externas. Não invente campos que não aparecem. Responda SOMENTE com o código JavaScript, sem markdown.';
  }
  const AI_SYSTEM = 'Você escreve testes de API para o Postman/Mono. Responda apenas com código JavaScript válido, sem cercas de markdown nem explicações.';
  const cleanCode = (t) => String(t || '').replace(/^\s*```(?:js|javascript)?\s*/i, '').replace(/```\s*$/, '').trim() + '\n';

  return { generate, aiPrompt, AI_SYSTEM, cleanCode };
});
