// Visão geral de uma API importada: para que serve, como usar, autenticação,
// diagrama de comunicação e fluxo típico (SVG gerado aqui, sem bibliotecas externas).
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.MonoOverview = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hasParam = (p) => /\{\{?\w+\}?\}|:\w+|\/\d+(\/|$)/.test(p);
  const resourceOf = (p) => (String(p).split('/').filter((x) => x && !/^\{|^:|^\d+$|^v\d+$|^api$/i.test(x))[0] || '').replace(/[-_]/g, ' ');
  const VERB = (e) => ({ GET: hasParam(e.path) ? 'consultar' : 'listar', POST: 'criar', PUT: 'atualizar', PATCH: 'atualizar parcialmente', DELETE: 'remover', HEAD: 'verificar', OPTIONS: 'descobrir opções de' }[e.method] || e.method.toLowerCase());
  const isAuthEp = (e) => /auth|login|token|session|signin|oauth/i.test(`${e.path} ${e.name}`) && e.method === 'POST';
  const isHealth = (e) => /ping|health|status|alive|ready/i.test(`${e.path} ${e.name}`) && e.method === 'GET';
  const needsAuth = (e, model) => !!(e.authHint || (e.auth && !['none', 'inherit'].includes(e.auth.type)) || (model.collectionAuth && model.collectionAuth.type !== 'none' && !(e.auth && e.auth.type === 'none') && !isAuthEp(e)));
  const okStatus = (e) => {
    const r = (e.responses || []).find((x) => Number(x.status) >= 200 && Number(x.status) < 300);
    if (r) return Number(r.status);
    return e.method === 'POST' ? 201 : e.method === 'DELETE' ? 204 : 200;
  };
  const joinPt = (arr) => (arr.length <= 1 ? arr.join('') : arr.slice(0, -1).join(', ') + ' e ' + arr[arr.length - 1]);

  function buildOverview(model) {
    const groups = [];
    for (const e of model.endpoints) {
      const name = Array.isArray(e.folder) ? e.folder.join(' / ') : e.folder || e.group || 'Geral';
      let g = groups.find((x) => x.name === name);
      if (!g) groups.push((g = { name, endpoints: [] }));
      g.endpoints.push({ name: e.name, method: e.method, path: e.path || e.url, description: e.description || '', needsAuth: needsAuth(e, model), returnsToken: !!e.returnsToken });
    }
    const methods = {};
    for (const e of model.endpoints) methods[e.method] = (methods[e.method] || 0) + 1;
    const authEp = model.endpoints.find((e) => e.returnsToken) || model.endpoints.find(isAuthEp);
    const health = model.endpoints.find(isHealth);
    const protectedEps = model.endpoints.filter((e) => needsAuth(e, model));

    // Para que serve
    const resources = [...new Set(model.endpoints.filter((e) => !isAuthEp(e) && !isHealth(e)).map((e) => resourceOf(e.path)).filter(Boolean))];
    const capabilities = groups.map((g) => {
      const eps = model.endpoints.filter((e) => (Array.isArray(e.folder) ? e.folder.join(' / ') : e.folder || e.group || 'Geral') === g.name);
      if (eps.every(isAuthEp)) return `${g.name}: obter o token de acesso`;
      if (eps.every(isHealth)) return `${g.name}: verificar se a API está no ar`;
      const crud = eps.filter((e) => !isAuthEp(e) && !isHealth(e));
      const verbs = [...new Set(crud.map(VERB))];
      const res = [...new Set(crud.map((e) => resourceOf(e.path)).filter(Boolean))];
      return `${g.name}: ${joinPt(verbs)}${res.length ? ' ' + joinPt(res.map((r) => `"${r}"`)) : ''}`;
    });
    const main = groups.filter((g) => !g.endpoints.every((e) => isAuthEp(e) || isHealth(e))).sort((a, b) => b.endpoints.length - a.endpoints.length)[0];
    const mainVerbs = main ? [...new Set(model.endpoints.filter((e) => (Array.isArray(e.folder) ? e.folder.join(' / ') : e.folder || e.group || 'Geral') === main.name && !isAuthEp(e) && !isHealth(e)).map(VERB))] : [];
    const purpose = `${model.title} é uma API REST com ${model.endpoints.length} endpoint(s) em ${groups.length} grupo(s)` +
      (resources.length ? `, centrada em ${joinPt(resources.slice(0, 4).map((r) => `"${r}"`))}` : '') + '.' +
      (mainVerbs.length ? ` Com ela você consegue ${joinPt(mainVerbs)} ${resources[0] ? `"${resources[0]}"` : 'registros'}` : '') +
      (protectedEps.length ? `; as operações que alteram dados exigem autenticação${authEp ? ` (token obtido em ${authEp.method} ${authEp.path})` : ''}.` : mainVerbs.length ? '.' : '');
    const docNote = model.description || '';

    // Autenticação
    const kinds = new Set(model.authKinds || []);
    const authLines = [];
    if (kinds.has('cookie-token')) authLines.push(`Operações protegidas enviam o token no cookie: Cookie: token=<valor>.${authEp ? ` O token vem de ${authEp.method} ${authEp.path}.` : ''}`);
    if (kinds.has('basic')) authLines.push('Alternativa aceita: Authorization: Basic (usuário e senha).');
    const ca = model.collectionAuth;
    if (ca && ca.type === 'bearer') authLines.push('Envie Authorization: Bearer <token> (configurado na coleção com {{token}}).');
    if (ca && ca.type === 'apikey') authLines.push(`Envie a chave ${ca.key} ${ca.in === 'query' ? 'na query string' : 'no header'} (configurada na coleção com {{apiKey}}).`);
    if (ca && ca.type === 'oauth2') authLines.push(`OAuth 2.0: o token é obtido em ${ca.oauth2.tokenUrl || 'URL do token'}. Preencha {{clientId}} e {{clientSecret}} no ambiente e use "Obter novo token" na coleção.`);
    if (ca && ca.type === 'basic') authLines.push('Authorization: Basic com {{usuario}} e {{senha}} do ambiente.');
    const authSummary = protectedEps.length || authLines.length
      ? `${protectedEps.length} de ${model.endpoints.length} endpoint(s) exigem autenticação${protectedEps.length ? ` (${joinPt([...new Set(protectedEps.map((e) => e.method))])})` : ''}.`
      : 'Nenhum endpoint indica exigir autenticação.';

    // Como usar
    const howTo = [];
    if (model.baseUrl) howTo.push(`Use a base ${model.baseUrl} pela variável {{baseUrl}} — a seção Variáveis mostra o que já está no ambiente e cria o que faltar.`);
    if (health) howTo.push(`Confirme que a API está no ar com ${health.method} ${health.path} (${health.name}).`);
    if (authEp) howTo.push(`Autentique com ${authEp.method} ${authEp.path} (${authEp.name}).${authEp.returnsToken && authEp.tokenField ? ' O teste gerado salva o token em {{token}} automaticamente.' : ' Copie o token retornado para {{token}} no ambiente.'}`);
    const reads = model.endpoints.filter((e) => e.method === 'GET' && !isHealth(e));
    if (reads.length) howTo.push(`Leia dados com ${joinPt(reads.slice(0, 3).map((e) => `${e.method} ${e.path}`))}${reads.some((e) => !needsAuth(e, model)) ? ' — leitura não exige token' : ''}.`);
    const writes = model.endpoints.filter((e) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method) && !isAuthEp(e));
    if (writes.length) howTo.push(`Altere dados com ${joinPt([...new Set(writes.map((e) => e.method))])}${protectedEps.some((e) => writes.includes(e)) ? ' (essas exigem o token)' : ''}. Os bodies de exemplo da documentação já estão preenchidos.`);

    // Fluxo típico
    const mainGroup = groups.filter((g) => !g.endpoints.every((e) => isAuthEp(e) || isHealth(e))).sort((a, b) => b.endpoints.length - a.endpoints.length)[0];
    const pick = (fn) => mainGroup && model.endpoints.find((e) => (Array.isArray(e.folder) ? e.folder.join(' / ') : e.folder || e.group || 'Geral') === mainGroup.name && fn(e));
    const steps = [];
    const step = (e, label) => e && !steps.some((s) => s.e === e) && steps.push({ e, method: e.method, path: e.path, label: label || e.name, status: okStatus(e), needsAuth: needsAuth(e, model), returnsToken: !!e.returnsToken });
    if (health) step(health, 'API no ar?');
    if (authEp) step(authEp, 'obter token');
    step(pick((e) => e.method === 'POST'), 'criar');
    step(pick((e) => e.method === 'GET' && !hasParam(e.path)), 'listar');
    step(pick((e) => e.method === 'GET' && hasParam(e.path)), 'consultar');
    step(pick((e) => e.method === 'PUT') || pick((e) => e.method === 'PATCH'), 'atualizar');
    step(pick((e) => e.method === 'DELETE'), 'remover');

    // Webservice SOAP (WSDL): textos próprios — tudo é POST com envelope, e serviços fiscais usam certificado.
    if (model.soap) {
      const ops = model.endpoints.map((e) => e.name);
      const host = (() => { try { return new URL(model.baseUrl).host; } catch { return ''; } })();
      const fiscal = /fazenda|sefaz|nfe|nfse|cte|mdfe|sped|receita|esocial|reinf|\.gov\.br$/i.test(host + ' ' + model.title);
      const versions = [...new Set(model.endpoints.map((e) => e.soap && e.soap.version).filter(Boolean))].join(' e ');
      const soapPurpose = `${model.title} é um webservice SOAP ${versions} com ${ops.length} operação(ões)${groups.length > 1 ? ` em ${groups.length} serviços` : ''}: ${joinPt(ops.slice(0, 6))}${ops.length > 6 ? '…' : ''}.`;
      const soapCaps = groups.map((g) => `${g.name}: ${joinPt(g.endpoints.map((e) => e.name).slice(0, 8))}`);
      const soapAuthLines = fiscal
        ? [`Webservices fiscais exigem certificado digital do cliente (A1, .pfx): cadastre em Configurações › Certificados para ${host ? '"' + host + '"' : 'o host do serviço'}.`, 'Mensagens com documento fiscal (NF-e, eventos, inutilização) precisam estar assinadas: botão "Assinar" no Body ou pm.xml.sign() no script.']
        : ['O WSDL não declara autenticação (WS-Security não é lido). Se o serviço exigir, adicione os headers ou o certificado.'];
      const soapHow = [];
      if (model.baseUrl) soapHow.push(`O endereço do serviço fica em {{baseUrl}} (${model.baseUrl}) — a seção Variáveis cria no ambiente.`);
      soapHow.push(`Cada operação é um POST com o envelope SOAP ${versions} já montado no Body, com Content-Type${model.endpoints.some((e) => e.soap && e.soap.version === '1.1') ? ' e SOAPAction' : ' (action)'} prontos.`);
      soapHow.push('Troque os "?" do envelope pelos valores reais; os comentários indicam campos opcionais e repetições.');
      if (fiscal) soapHow.push(...soapAuthLines);
      return {
        title: model.title, version: model.version, format: model.format, source: model.source, baseUrl: model.baseUrl,
        purpose: soapPurpose, docNote, capabilities: soapCaps,
        authSummary: fiscal ? 'Autenticação por certificado digital do cliente (mTLS).' : 'Nenhuma autenticação declarada no WSDL.', authLines: soapAuthLines,
        howTo: soapHow, groups,
        counts: { endpoints: model.endpoints.length, groups: groups.length, methods, protected: 0 },
        flow: model.endpoints.slice(0, 6).map((e) => ({ method: e.method, path: e.path, label: e.name, status: 200, needsAuth: fiscal, returnsToken: false })),
        generatedAt: Date.now(), ai: null,
      };
    }

    return {
      title: model.title, version: model.version, format: model.format, source: model.source, baseUrl: model.baseUrl,
      purpose, docNote, capabilities, authSummary, authLines, howTo, groups,
      counts: { endpoints: model.endpoints.length, groups: groups.length, methods, protected: protectedEps.length },
      flow: steps.map(({ e, ...s }) => s), generatedAt: Date.now(), ai: null,
    };
  }

  // ---------- SVG ----------
  const SVG_STYLE = `
    .bx{fill:var(--surface-2,#141414);stroke:var(--border-strong,#2e2e2e);stroke-width:1}
    .bx-strong{fill:var(--surface,#0b0b0b);stroke:var(--invert-bg,#fff);stroke-width:1.2}
    .t{fill:var(--text,#f5f5f5);font:600 13px Inter,'Segoe UI',system-ui,sans-serif}
    .t2{fill:var(--text-2,#b3b3b3);font:12px Inter,'Segoe UI',system-ui,sans-serif}
    .tm{fill:var(--muted,#6e6e6e);font:11px Inter,'Segoe UI',system-ui,sans-serif}
    .mono{font-family:'JetBrains Mono','Cascadia Code',Consolas,monospace;font-size:11px}
    .ln{stroke:var(--border-strong,#3a3a3a);stroke-width:1.2;fill:none}
    .ar{stroke:var(--text-2,#b3b3b3);stroke-width:1.4;fill:none}
    .ar-res{stroke:var(--muted,#6e6e6e);stroke-width:1.2;fill:none;stroke-dasharray:4 4}
    .life{stroke:var(--border-strong,#2e2e2e);stroke-width:1;stroke-dasharray:3 4}
    .mGET{fill:var(--m-GET,#6bdd9a)}.mPOST{fill:var(--m-POST,#ffe47e)}.mPUT{fill:var(--m-PUT,#74aef6)}.mPATCH{fill:var(--m-PATCH,#c0a8e1)}.mDELETE{fill:var(--m-DELETE,#f79a8e)}.mHEAD,.mOPTIONS{fill:var(--m-GET,#6bdd9a)}
    .lock{fill:var(--warning,#d29922);font:11px Inter,system-ui,sans-serif}
    .ok{fill:var(--success,#3fb950)}
  `;
  const head = (w, h, title) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title)}"><style>${SVG_STYLE}</style>
    <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--text-2,#b3b3b3)"/></marker>
    <marker id="ahm" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--muted,#6e6e6e)"/></marker></defs>`;
  const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
  const hostOf = (u) => { try { return new URL(u).host; } catch { return u || ''; } };

  // Diagrama de comunicação: cliente → API → grupos de endpoints.
  function architectureSvg(ov) {
    const W = 940, colX = [20, 350, 630], boxW = [180, 230, 290];
    const groups = ov.groups.slice(0, 8);
    const gH = groups.map((g) => 40 + Math.min(g.endpoints.length, 6) * 18 + (g.endpoints.length > 6 ? 16 : 0));
    const totalG = gH.reduce((a, b) => a + b, 0) + (groups.length - 1) * 14;
    const H = Math.max(260, totalG + 40);
    const midY = H / 2;
    let s = head(W, H, `Diagrama de comunicação de ${ov.title}`);
    // Cliente
    s += `<rect class="bx" x="${colX[0]}" y="${midY - 42}" width="${boxW[0]}" height="84" rx="10"/>
      <text class="t" x="${colX[0] + 16}" y="${midY - 12}">Cliente</text>
      <text class="t2" x="${colX[0] + 16}" y="${midY + 8}">Mono · seu app</text>
      <text class="tm mono" x="${colX[0] + 16}" y="${midY + 26}">{{baseUrl}}${ov.counts.protected ? ' {{token}}' : ''}</text>`;
    // API
    const apiH = 110;
    s += `<rect class="bx-strong" x="${colX[1]}" y="${midY - apiH / 2}" width="${boxW[1]}" height="${apiH}" rx="12"/>
      <text class="t" x="${colX[1] + 16}" y="${midY - 26}">${esc(clip(ov.title, 26))}</text>
      <text class="t2 mono" x="${colX[1] + 16}" y="${midY - 6}">${esc(clip(hostOf(ov.baseUrl), 30))}</text>
      <text class="tm" x="${colX[1] + 16}" y="${midY + 16}">${ov.counts.endpoints} endpoints · ${ov.counts.groups} grupos</text>
      ${ov.counts.protected ? `<text class="lock" x="${colX[1] + 16}" y="${midY + 36}">🔒 ${ov.counts.protected} protegido(s)</text>` : ''}`;
    // Seta cliente → API
    s += `<path class="ar" d="M${colX[0] + boxW[0]} ${midY - 10} L${colX[1] - 4} ${midY - 10}" marker-end="url(#ah)"/>
      <path class="ar-res" d="M${colX[1] - 4} ${midY + 12} L${colX[0] + boxW[0] + 4} ${midY + 12}" marker-end="url(#ahm)"/>
      <text class="tm" x="${(colX[0] + boxW[0] + colX[1]) / 2}" y="${midY - 18}" text-anchor="middle">HTTPS · requisição</text>
      <text class="tm" x="${(colX[0] + boxW[0] + colX[1]) / 2}" y="${midY + 30}" text-anchor="middle">resposta JSON</text>`;
    // Grupos
    let y = (H - totalG) / 2;
    groups.forEach((g, i) => {
      const h = gH[i];
      const cy = y + 20;
      s += `<path class="ln" d="M${colX[1] + boxW[1]} ${midY} C${colX[1] + boxW[1] + 40} ${midY}, ${colX[2] - 40} ${cy}, ${colX[2]} ${cy}"/>`;
      s += `<rect class="bx" x="${colX[2]}" y="${y}" width="${boxW[2]}" height="${h}" rx="10"/>
        <text class="t" x="${colX[2] + 14}" y="${y + 24}">${esc(clip(g.name, 30))}</text>
        <text class="tm" x="${colX[2] + boxW[2] - 14}" y="${y + 24}" text-anchor="end">${g.endpoints.length}</text>`;
      g.endpoints.slice(0, 6).forEach((e, j) => {
        const ly = y + 44 + j * 18;
        s += `<text class="mono m${esc(e.method)}" x="${colX[2] + 14}" y="${ly}" font-weight="700">${esc(e.method)}</text>
          <text class="t2 mono" x="${colX[2] + 72}" y="${ly}">${esc(clip(e.path, 28))}${e.needsAuth ? ' 🔒' : ''}</text>`;
      });
      if (g.endpoints.length > 6) s += `<text class="tm" x="${colX[2] + 14}" y="${y + 44 + 6 * 18}">+ ${g.endpoints.length - 6} endpoint(s)</text>`;
      y += h + 14;
    });
    return s + '</svg>';
  }

  // Fluxo típico em diagrama de sequência.
  function sequenceSvg(ov) {
    const steps = ov.flow.length ? ov.flow : [];
    const W = 760, top = 64, row = 62;
    const H = top + Math.max(1, steps.length) * row + 30;
    const xC = 130, xA = 600;
    let s = head(W, H, `Fluxo típico de uso de ${ov.title}`);
    s += `<rect class="bx" x="${xC - 80}" y="12" width="160" height="36" rx="8"/><text class="t" x="${xC}" y="35" text-anchor="middle">Cliente (Mono)</text>
      <rect class="bx-strong" x="${xA - 110}" y="12" width="220" height="36" rx="8"/><text class="t" x="${xA}" y="35" text-anchor="middle">${esc(clip(ov.title, 24))}</text>
      <line class="life" x1="${xC}" y1="48" x2="${xC}" y2="${H - 8}"/><line class="life" x1="${xA}" y1="48" x2="${xA}" y2="${H - 8}"/>`;
    if (!steps.length) s += `<text class="tm" x="${W / 2}" y="${top + 20}" text-anchor="middle">Sem endpoints suficientes para montar um fluxo.</text>`;
    steps.forEach((st, i) => {
      const y = top + i * row;
      s += `<text class="tm" x="${xC + 12}" y="${y + 4}">${i + 1}. ${esc(st.label)}${st.needsAuth ? '  🔒 com token' : ''}</text>
        <path class="ar" d="M${xC + 4} ${y + 14} L${xA - 6} ${y + 14}" marker-end="url(#ah)"/>
        <text class="mono m${esc(st.method)}" x="${(xC + xA) / 2 - 4}" y="${y + 8}" text-anchor="end" font-weight="700">${esc(st.method)}</text>
        <text class="t2 mono" x="${(xC + xA) / 2 + 4}" y="${y + 8}">${esc(clip(st.path, 34))}</text>
        <path class="ar-res" d="M${xA - 4} ${y + 34} L${xC + 6} ${y + 34}" marker-end="url(#ahm)"/>
        <text class="mono ${st.status < 300 ? 'ok' : 'tm'}" x="${(xC + xA) / 2}" y="${y + 48}" text-anchor="middle">${st.status}${st.returnsToken ? ' · token → {{token}}' : ''}</text>`;
    });
    return s + '</svg>';
  }

  // ---------- Exportação ----------
  function toMarkdown(ov) {
    const L = [];
    L.push(`# ${ov.title}${ov.version ? ' ' + ov.version : ''}`, '');
    L.push(`> ${ov.format}${ov.source ? ` · ${ov.source}` : ''}${ov.baseUrl ? ` · base ${ov.baseUrl}` : ''}`, '');
    L.push('## Para que serve', '', (ov.ai && ov.ai.purpose) || ov.purpose, '');
    if (ov.capabilities.length) { L.push('**O que dá para fazer**', ''); ov.capabilities.forEach((c) => L.push(`- ${c}`)); L.push(''); }
    L.push('## Como usar', '');
    ((ov.ai && ov.ai.howTo) || ov.howTo).forEach((h, i) => L.push(`${i + 1}. ${h}`));
    L.push('', '## Autenticação', '', ov.authSummary, ...ov.authLines.map((l) => `- ${l}`), '');
    L.push('## Fluxo típico', '');
    ov.flow.forEach((f, i) => L.push(`${i + 1}. **${f.label}** — \`${f.method} ${f.path}\` → ${f.status}${f.needsAuth ? ' (com token)' : ''}`));
    L.push('', '## Endpoints', '');
    for (const g of ov.groups) {
      L.push(`### ${g.name}`, '', '| Método | Caminho | Nome | Auth |', '|---|---|---|---|');
      g.endpoints.forEach((e) => L.push(`| ${e.method} | \`${e.path}\` | ${e.name} | ${e.needsAuth ? 'sim' : '—'} |`));
      L.push('');
    }
    return L.join('\n');
  }
  function toHtml(ov, tokens = '') {
    const md = (t) => esc(t).replace(/\{\{(\w+)\}\}/g, '<code>{{$1}}</code>');
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(ov.title)} — visão geral</title>
<style>:root{${tokens}}body{margin:0;background:var(--bg,#fff);color:var(--text,#111);font:14px/1.6 Inter,'Segoe UI',system-ui,sans-serif}main{max-width:920px;margin:0 auto;padding:40px 24px}
h1{margin:0 0 4px;font-size:26px}h2{margin:32px 0 8px;font-size:17px}.meta{color:var(--muted,#777)}code{font-family:'JetBrains Mono',Consolas,monospace;font-size:12px;background:var(--surface-2,#f2f2f2);padding:1px 5px;border-radius:4px}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--border,#e6e6e6)}svg{max-width:100%;height:auto;border:1px solid var(--border,#e6e6e6);border-radius:12px;background:var(--bg,#fff)}
.m{font:700 11px 'JetBrains Mono',Consolas,monospace}.GET{color:var(--m-GET)}.POST{color:var(--m-POST)}.PUT{color:var(--m-PUT)}.PATCH{color:var(--m-PATCH)}.DELETE{color:var(--m-DELETE)}</style></head><body><main>
<h1>${esc(ov.title)} ${esc(ov.version || '')}</h1><div class="meta">${esc(ov.format)}${ov.baseUrl ? ' · ' + esc(ov.baseUrl) : ''}</div>
<h2>Para que serve</h2><p>${md((ov.ai && ov.ai.purpose) || ov.purpose)}</p><ul>${ov.capabilities.map((c) => `<li>${md(c)}</li>`).join('')}</ul>
<h2>Como usar</h2><ol>${((ov.ai && ov.ai.howTo) || ov.howTo).map((h) => `<li>${md(h)}</li>`).join('')}</ol>
<h2>Autenticação</h2><p>${md(ov.authSummary)}</p><ul>${ov.authLines.map((l) => `<li>${md(l)}</li>`).join('')}</ul>
<h2>Diagrama de comunicação</h2>${architectureSvg(ov)}
<h2>Fluxo típico</h2>${sequenceSvg(ov)}
<h2>Endpoints</h2>${ov.groups.map((g) => `<h3>${esc(g.name)}</h3><table>${g.endpoints.map((e) => `<tr><td class="m ${esc(e.method)}">${esc(e.method)}</td><td><code>${esc(e.path)}</code></td><td>${esc(e.name)}</td><td>${e.needsAuth ? '🔒' : ''}</td></tr>`).join('')}</table>`).join('')}
</main></body></html>`;
  }

  return { buildOverview, architectureSvg, sequenceSvg, toMarkdown, toHtml };
});
