// WSDL 1.1 → modelo de API do Mono: uma requisição por operação, com envelope SOAP de exemplo,
// SOAPAction / action do SOAP 1.2 e o endereço do serviço. Lê schemas (XSD) embutidos e importados.
(function (root, factory) {
  const m = factory(root.MonoXml || (typeof require === 'function' ? require('./xml') : null));
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.MonoWsdl = m;
})(typeof self !== 'undefined' ? self : this, function (X) {
  'use strict';
  const NS = {
    wsdl: 'http://schemas.xmlsoap.org/wsdl/', soap11: 'http://schemas.xmlsoap.org/wsdl/soap/', soap12: 'http://schemas.xmlsoap.org/wsdl/soap12/',
    xs: 'http://www.w3.org/2001/XMLSchema', env11: 'http://schemas.xmlsoap.org/soap/envelope/', env12: 'http://www.w3.org/2003/05/soap-envelope',
  };
  const isWsdl = (text) => /<([\w-]+:)?definitions[\s>][\s\S]*schemas\.xmlsoap\.org\/wsdl\//.test(String(text).slice(0, 20000));
  const qname = (el, v) => { const s = String(v || ''); const i = s.indexOf(':'); const prefix = i < 0 ? '' : s.slice(0, i); return { ns: X.inScope(el)[prefix] || '', local: i < 0 ? s : s.slice(i + 1) }; };
  const byLocal = (el, local, ns) => X.elements(el).filter((c) => c.local === local && (!ns || X.nsUri(c) === ns));

  // Referências externas (wsdl:import, xs:import/include) para buscar antes de montar.
  function externalRefs(text, baseUrl) {
    const doc = X.parse(text);
    const out = [];
    for (const e of X.walk(doc.root)) {
      const loc = (e.local === 'import' && X.nsUri(e) === NS.wsdl) ? X.attr(e, 'location') : (e.local === 'import' || e.local === 'include') && X.nsUri(e) === NS.xs ? X.attr(e, 'schemaLocation') : null;
      if (loc) { try { out.push(new URL(loc, baseUrl || undefined).toString()); } catch { /* relativo sem base */ } }
    }
    return [...new Set(out)];
  }

  // ---------- Schemas ----------
  function schemaIndex(docs) {
    const idx = { elements: new Map(), types: new Map(), groups: new Map(), attrGroups: new Map() };
    const key = (ns, local) => `{${ns}}${local}`;
    const add = (schema) => {
      const tns = X.attr(schema, 'targetNamespace') || '';
      const qualified = X.attr(schema, 'elementFormDefault') === 'qualified';
      for (const c of X.elements(schema)) {
        if (X.nsUri(c) !== NS.xs) continue;
        const name = X.attr(c, 'name');
        if (!name) continue;
        const rec = { el: c, tns, qualified };
        if (c.local === 'element') idx.elements.set(key(tns, name), rec);
        else if (c.local === 'complexType' || c.local === 'simpleType') idx.types.set(key(tns, name), rec);
        else if (c.local === 'group') idx.groups.set(key(tns, name), rec);
      }
    };
    for (const d of docs) for (const s of X.findAll(d.root, 'schema')) if (X.nsUri(s) === NS.xs) add(s);
    idx.key = key;
    return idx;
  }

  const XS_SAMPLE = { string: '?', normalizedString: '?', token: '?', int: '0', integer: '0', long: '0', short: '0', byte: '0', unsignedInt: '0', unsignedLong: '0', unsignedShort: '0', unsignedByte: '0', positiveInteger: '1', nonNegativeInteger: '0', decimal: '0.00', double: '0.0', float: '0.0', boolean: 'false', dateTime: new Date(0).toISOString().replace('.000Z', ''), date: '2026-01-01', time: '00:00:00', base64Binary: '?', hexBinary: '?', anyURI: 'http://?', QName: '?', guid: '00000000-0000-0000-0000-000000000000', char: '0', duration: 'PT0S' };

  // Gera o XML de exemplo de um elemento (estilo SoapUI: "?" e comentários de opcional/repetição).
  function sampleElement(idx, rec, ctx) {
    const prefixes = ctx.prefixes;
    const pfx = (ns) => { if (!prefixes.has(ns)) prefixes.set(ns, `ns${prefixes.size + 1}`); return prefixes.get(ns) + ':'; };
    const occurs = (el, ind) => {
      const out = [];
      const min = X.attr(el, 'minOccurs'), max = X.attr(el, 'maxOccurs');
      if (min === '0') out.push(`${ind}<!--Opcional:-->`);
      if (max && max !== '1') out.push(`${ind}<!--${max === 'unbounded' ? 'Zero ou mais' : 'Até ' + max} repetições:-->`);
      return out;
    };
    // elemento → linhas
    const element = (el, tns, qualified, ind, depth, top) => {
      if (depth > 12) return [`${ind}<!-- estrutura recursiva omitida -->`];
      if (X.attr(el, 'ref')) {
        const q = qname(el, X.attr(el, 'ref'));
        const r = idx.elements.get(idx.key(q.ns, q.local));
        if (!r) return [...occurs(el, ind), `${ind}<${q.local}>?</${q.local}>`];
        return [...occurs(el, ind), ...element(r.el, r.tns, r.qualified, ind, depth + 1, true)];
      }
      const name = X.attr(el, 'name');
      // elemento global: sempre no namespace do schema (default xmlns no topo); locais: só se qualified
      let tag;
      if (top && depth === 0) tag = rec.qualified ? name : pfx(tns) + name;
      else if (top || qualified) tag = tns === ctx.rootNs ? name : pfx(tns) + name;
      else tag = ctx.rootNs ? `${name}` : name;
      return [...occurs(el, ind), ...content(el, tag, tns, qualified, ind, depth)];
    };
    const content = (el, tag, tns, qualified, ind, depth) => {
      let ct = X.children(el, 'complexType')[0];
      let st = X.children(el, 'simpleType')[0];
      const type = X.attr(el, 'type');
      if (type) {
        const q = qname(el, type);
        if (q.ns === NS.xs) return [`${ind}<${tag}>${XS_SAMPLE[q.local] ?? '?'}</${tag}>`];
        const t = idx.types.get(idx.key(q.ns, q.local));
        if (!t) return [`${ind}<${tag}>?</${tag}>`];
        if (t.el.local === 'simpleType') st = t.el; else { ct = t.el; tns = t.tns; qualified = t.qualified; }
      }
      if (st) return [`${ind}<${tag}>${simpleSample(st)}</${tag}>`];
      if (!ct) return [`${ind}<${tag}>?</${tag}>`];
      const attrs = collectAttrs(ct).map((a) => ` ${X.attr(a, 'name') || qname(a, X.attr(a, 'ref')).local}="${X.attr(a, 'fixed') || X.attr(a, 'default') || '?'}"`).join('');
      let textValue = '';
      const kids = particle(ct, tns, qualified, ind + '  ', depth, (v) => { textValue = v; });
      if (!kids.length) return [`${ind}<${tag}${attrs}>${textValue}</${tag}>`];
      return [`${ind}<${tag}${attrs}>`, ...kids, `${ind}</${tag}>`];
    };
    const particle = (p, tns, qualified, ind, depth, setText) => {
      const out = [];
      for (const c of X.elements(p)) {
        if (X.nsUri(c) !== NS.xs) continue;
        if (c.local === 'sequence' || c.local === 'all') out.push(...particle(c, tns, qualified, ind, depth, setText));
        else if (c.local === 'choice') {
          out.push(`${ind}<!--Escolha uma das opções:-->`);
          const first = X.elements(c).find((x) => x.local === 'element' || x.local === 'sequence');
          if (first) out.push(...(first.local === 'element' ? element(first, tns, qualified, ind, depth + 1, false) : particle(first, tns, qualified, ind, depth, setText)));
        } else if (c.local === 'element') out.push(...element(c, tns, qualified, ind, depth + 1, false));
        else if (c.local === 'any') out.push(`${ind}<!-- conteúdo XML livre -->`);
        else if (c.local === 'group' && X.attr(c, 'ref')) { const q = qname(c, X.attr(c, 'ref')); const g = idx.groups.get(idx.key(q.ns, q.local)); if (g) out.push(...particle(g.el, g.tns, g.qualified, ind, depth, setText)); }
        else if (c.local === 'complexContent' || c.local === 'simpleContent') {
          const ext = X.elements(c).find((x) => x.local === 'extension' || x.local === 'restriction');
          if (!ext) continue;
          const base = X.attr(ext, 'base');
          if (ext.local === 'extension' && base) {
            const q = qname(ext, base);
            const bt = idx.types.get(idx.key(q.ns, q.local));
            if (bt && bt.el.local === 'complexType' && depth < 12) out.push(...particle(bt.el, bt.tns, bt.qualified, ind, depth + 1, setText));
            else if (c.local === 'simpleContent') setText(q.ns === NS.xs ? XS_SAMPLE[q.local] ?? '?' : '?');
          }
          out.push(...particle(ext, tns, qualified, ind, depth, setText));
        }
      }
      return out;
    };
    ctx.rootNs = rec.tns;
    const lines = element(rec.el, rec.tns, rec.qualified, ctx.ind, 0, true);
    // o elemento raiz declara o namespace do schema como padrão
    const i = lines.findIndex((l) => /^\s*<[^!]/.test(l));
    if (i >= 0 && rec.tns && rec.qualified) lines[i] = lines[i].replace(/^(\s*<[\w.-]+)/, `$1 xmlns="${rec.tns}"`);
    return lines.join('\n');
  }
  function collectAttrs(ct) { return X.findAll(ct, 'attribute').filter((a) => X.nsUri(a) === NS.xs && X.attr(a, 'use') !== 'prohibited'); }
  function simpleSample(st) {
    const enums = X.findAll(st, 'enumeration').map((e) => X.attr(e, 'value'));
    if (enums.length) return enums[0];
    const r = X.findAll(st, 'restriction')[0];
    if (r && X.attr(r, 'base')) { const local = qname(r, X.attr(r, 'base')).local; return XS_SAMPLE[local] ?? '?'; }
    return '?';
  }

  // ---------- Modelos conhecidos (conteúdo da mensagem em serviços da NF-e 4.00) ----------
  const NFE = 'http://www.portalfiscal.inf.br/nfe';
  const NFE_SAMPLES = {
    NFeStatusServico4: `<consStatServ xmlns="${NFE}" versao="4.00"><tpAmb>2</tpAmb><cUF>35</cUF><xServ>STATUS</xServ></consStatServ>`,
    NFeConsultaProtocolo4: `<consSitNFe xmlns="${NFE}" versao="4.00"><tpAmb>2</tpAmb><xServ>CONSULTAR</xServ><chNFe>{{chaveNFe}}</chNFe></consSitNFe>`,
    NFeRecepcaoEvento4: `<envEvento xmlns="${NFE}" versao="1.00"><idLote>1</idLote><evento versao="1.00"><infEvento Id="ID110111{{chaveNFe}}01"><cOrgao>35</cOrgao><tpAmb>2</tpAmb><CNPJ>{{cnpj}}</CNPJ><chNFe>{{chaveNFe}}</chNFe><dhEvento>2026-01-01T10:00:00-03:00</dhEvento><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>Cancelamento</descEvento><nProt>{{protocolo}}</nProt><xJust>Justificativa com pelo menos quinze caracteres</xJust></detEvento></infEvento></evento></envEvento>`,
    NFeInutilizacao4: `<inutNFe xmlns="${NFE}" versao="4.00"><infInut Id="ID35260000000000000000550010000000010000000010"><tpAmb>2</tpAmb><xServ>INUTILIZAR</xServ><cUF>35</cUF><ano>26</ano><CNPJ>{{cnpj}}</CNPJ><mod>55</mod><serie>1</serie><nNFIni>1</nNFIni><nNFFin>1</nNFFin><xJust>Justificativa com pelo menos quinze caracteres</xJust></infInut></inutNFe>`,
    CadConsultaCadastro4: `<ConsCad xmlns="${NFE}" versao="2.00"><infCons><xServ>CONS-CAD</xServ><UF>SP</UF><CNPJ>{{cnpj}}</CNPJ></infCons></ConsCad>`,
    NFeRetAutorizacao4: `<consReciNFe xmlns="${NFE}" versao="4.00"><tpAmb>2</tpAmb><nRec>{{recibo}}</nRec></consReciNFe>`,
    NFeAutorizacao4: `<enviNFe xmlns="${NFE}" versao="4.00"><idLote>1</idLote><indSinc>1</indSinc><!-- cole aqui a <NFe> assinada --></enviNFe>`,
  };
  const knownSample = (ns) => { const m = String(ns).match(/\/wsdl\/(\w+)$/); return m && NFE_SAMPLES[m[1]] ? { service: m[1], xml: NFE_SAMPLES[m[1]] } : null; };

  // ---------- WSDL → modelo ----------
  function fromWsdl(text, sourceUrl = '', extraDocs = []) {
    const doc = X.parse(text);
    const defs = doc.root;
    if (defs.local !== 'definitions') throw new Error('Não é um WSDL 1.1 (raiz <definitions>).');
    const tns = X.attr(defs, 'targetNamespace') || '';
    const all = [doc, ...extraDocs.map((t) => { try { return X.parse(t); } catch { return null; } }).filter(Boolean)];
    const idx = schemaIndex(all);
    const defsAll = all.map((d) => d.root).filter((r) => r.local === 'definitions');
    const pick = (local) => defsAll.flatMap((d) => byLocal(d, local, NS.wsdl));
    const messages = new Map(pick('message').map((m) => [X.attr(m, 'name'), m]));
    const portTypes = new Map(pick('portType').map((p) => [X.attr(p, 'name'), p]));
    const bindings = new Map(pick('binding').map((b) => [X.attr(b, 'name'), b]));
    const docOf = (el) => X.text(X.children(el, 'documentation')[0] || { children: [] }).trim();
    const title = X.attr(defs, 'name') || (pick('service')[0] && X.attr(pick('service')[0], 'name')) || 'Serviço SOAP';

    // Endereços: service/port → binding
    const ports = [];
    for (const svc of pick('service')) {
      for (const port of byLocal(svc, 'port', NS.wsdl)) {
        const b = bindings.get(qname(port, X.attr(port, 'binding')).local);
        if (!b) continue;
        const addr = X.elements(port).find((e) => e.local === 'address');
        const ver = X.elements(b).find((e) => e.local === 'binding' && (X.nsUri(e) === NS.soap12 || X.nsUri(e) === NS.soap11));
        if (!ver) continue; // binding HTTP GET/POST — ignorado
        ports.push({ service: X.attr(svc, 'name'), port: X.attr(port, 'name'), binding: b, soap: X.nsUri(ver) === NS.soap12 ? '1.2' : '1.1', style: X.attr(ver, 'style') || 'document', address: addr ? X.attr(addr, 'location') : '' });
      }
    }
    if (!ports.length) throw new Error('O WSDL não tem endpoints SOAP (service/port com binding SOAP).');
    // Prefere SOAP 1.2 quando o mesmo serviço oferece os dois (padrão da SEFAZ 4.00).
    const chosen = [];
    for (const p of ports) {
      const twin = chosen.find((c) => c.service === p.service && c.binding !== p.binding && X.attr(c.binding, 'type') === X.attr(p.binding, 'type'));
      if (twin) { if (p.soap === '1.2' && twin.soap === '1.1') chosen.splice(chosen.indexOf(twin), 1, p); continue; }
      chosen.push(p);
    }
    const multiService = new Set(chosen.map((p) => p.service)).size > 1 || chosen.length > 1;
    let baseUrl = '';
    try { const u = new URL(chosen[0].address); baseUrl = `${u.protocol}//${u.host}`; } catch { /* sem endereço */ }

    const endpoints = [];
    for (const p of chosen) {
      const pt = portTypes.get(qname(p.binding, X.attr(p.binding, 'type')).local);
      for (const bop of byLocal(p.binding, 'operation', NS.wsdl)) {
        const name = X.attr(bop, 'name');
        const sop = X.elements(bop).find((e) => e.local === 'operation' && (X.nsUri(e) === NS.soap12 || X.nsUri(e) === NS.soap11));
        const action = sop ? X.attr(sop, 'soapAction') || '' : '';
        const style = (sop && X.attr(sop, 'style')) || p.style;
        const ptop = pt && byLocal(pt, 'operation', NS.wsdl).find((o) => X.attr(o, 'name') === name);
        const input = ptop && byLocal(ptop, 'input', NS.wsdl)[0];
        const msg = input && messages.get(qname(input, X.attr(input, 'message')).local);
        const bin = byLocal(bop, 'input', NS.wsdl)[0];
        const sbody = bin && X.elements(bin).find((e) => e.local === 'body');
        const headerParts = bin ? X.elements(bin).filter((e) => e.local === 'header') : [];
        const ctx = { prefixes: new Map(), ind: '    ' };
        const parts = msg ? byLocal(msg, 'part', NS.wsdl) : [];
        const headerPartNames = new Set(headerParts.map((hp) => X.attr(hp, 'part')));
        const bodyParts = parts.filter((pp) => !headerPartNames.has(X.attr(pp, 'name')));
        const renderPart = (pp, ind) => {
          const c = { ...ctx, ind };
          if (X.attr(pp, 'element')) {
            const q = qname(pp, X.attr(pp, 'element'));
            const rec = idx.elements.get(idx.key(q.ns, q.local));
            const known = knownSample(q.ns);
            if (known && rec) return `${ind}<${q.local} xmlns="${q.ns}">\n${ind}  ${known.xml}\n${ind}</${q.local}>`;
            return rec ? sampleElement(idx, rec, c) : `${ind}<${q.local} xmlns="${q.ns}">?</${q.local}>`;
          }
          const tq = qname(pp, X.attr(pp, 'type'));
          return `${ind}<${X.attr(pp, 'name')}>${tq.ns === NS.xs ? XS_SAMPLE[tq.local] ?? '?' : '?'}</${X.attr(pp, 'name')}>`;
        };
        let bodyXml;
        if (style === 'rpc') {
          const opNs = (sbody && X.attr(sbody, 'namespace')) || tns;
          bodyXml = `    <op:${name} xmlns:op="${opNs}">\n${bodyParts.map((pp) => renderPart(pp, '      ')).join('\n')}\n    </op:${name}>`;
        } else bodyXml = bodyParts.map((pp) => renderPart(pp, '    ')).join('\n');
        const headerXml = headerParts.map((hp) => { const m = messages.get(qname(hp, X.attr(hp, 'message')).local); const part = m && byLocal(m, 'part', NS.wsdl).find((x) => X.attr(x, 'name') === X.attr(hp, 'part')); return part ? renderPart(part, '    ') : ''; }).filter(Boolean).join('\n');
        // prefixos usados pelos exemplos (elementos não qualificados com ns de tipos)
        const nsDecl = [...ctx.prefixes].map(([ns, pf]) => ` xmlns:${pf}="${ns}"`).join('');
        const env = p.soap === '1.2' ? 'soap12' : 'soap';
        const envNs = p.soap === '1.2' ? NS.env12 : NS.env11;
        const xml = `<?xml version="1.0" encoding="utf-8"?>\n<${env}:Envelope xmlns:${env}="${envNs}"${nsDecl}>\n  ${headerXml ? `<${env}:Header>\n${headerXml}\n  </${env}:Header>` : `<${env}:Header/>`}\n  <${env}:Body>\n${bodyXml}\n  </${env}:Body>\n</${env}:Envelope>`;
        const headers = p.soap === '1.2'
          ? [{ key: 'Content-Type', value: `application/soap+xml; charset=utf-8${action ? `; action="${action}"` : ''}`, enabled: true }]
          : [{ key: 'Content-Type', value: 'text/xml; charset=utf-8', enabled: true }, { key: 'SOAPAction', value: `"${action}"`, enabled: true }];
        let url = p.address || '';
        if (baseUrl && url.startsWith(baseUrl)) url = '{{baseUrl}}' + url.slice(baseUrl.length);
        const known = msg && bodyParts.map((pp) => X.attr(pp, 'element') ? knownSample(qname(pp, X.attr(pp, 'element')).ns) : null).find(Boolean);
        endpoints.push({
          name: chosen.filter((c) => byLocal(c.binding, 'operation', NS.wsdl).some((o) => X.attr(o, 'name') === name)).length > 1 && multiService ? `${name} (${p.port})` : name,
          folder: multiService ? [p.service] : null, group: multiService ? p.service : null, method: 'POST', url,
          path: (() => { try { return new URL(p.address).pathname; } catch { return '/' + name; } })() + ' · ' + name,
          headers, params: [], body: { type: 'xml', raw: xml, form: [] },
          description: [ptop && docOf(ptop), docOf(bop), known ? `Exemplo de mensagem da NF-e (${known.service}) — confira o leiaute vigente; documentos fiscais precisam ser assinados (botão Assinar no Body).` : ''].filter(Boolean).join('\n'),
          soap: { version: p.soap, action, style, port: p.port },
        });
      }
    }
    const services = [...new Set(chosen.map((p) => p.service))];
    return {
      format: `WSDL 1.1 (SOAP ${[...new Set(chosen.map((p) => p.soap))].join(' / ')})`, source: sourceUrl, title, version: '',
      description: docOf(defs) || `Webservice SOAP ${services.join(', ')} com ${endpoints.length} operação(ões).`,
      baseUrl, endpoints, collectionAuth: null, authKinds: [], extraVars: [],
      soap: true,
    };
  }

  return { isWsdl, fromWsdl, externalRefs, knownSample };
});
