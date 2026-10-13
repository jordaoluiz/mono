// Leitura de especificações OpenAPI 3.x / Swagger 2.0 e validação de respostas contra o contrato.
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.MonoOpenApi = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
  const isV2 = (spec) => typeof spec.swagger === 'string' && spec.swagger.startsWith('2');

  function resolveRef(spec, ref) {
    if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
    let cur = spec;
    for (const part of ref.slice(2).split('/')) {
      cur = cur?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
      if (cur === undefined) return null;
    }
    return cur;
  }
  // Segue $ref (inclusive encadeados) com proteção contra ciclos.
  function deref(spec, obj, seen = new Set()) {
    let cur = obj;
    while (cur && cur.$ref) {
      if (seen.has(cur.$ref)) return {};
      seen.add(cur.$ref);
      cur = resolveRef(spec, cur.$ref) || {};
    }
    return cur || {};
  }

  function baseUrlOf(spec, specUrl) {
    if (isV2(spec)) {
      if (!spec.host) return specUrl ? new URL(spec.basePath || '/', specUrl).toString().replace(/\/$/, '') : '';
      const scheme = (spec.schemes && spec.schemes[0]) || 'https';
      return `${scheme}://${spec.host}${spec.basePath || ''}`.replace(/\/$/, '');
    }
    const server = spec.servers && spec.servers[0];
    if (!server || !server.url) return specUrl ? new URL('/', specUrl).toString().replace(/\/$/, '') : '';
    let url = server.url.replace(/\{([^}]+)\}/g, (m, k) => (server.variables?.[k]?.default ?? m));
    if (specUrl && !/^[a-z]+:\/\//i.test(url)) { try { url = new URL(url, specUrl).toString(); } catch { /* mantém */ } }
    return url.replace(/\/$/, '');
  }

  // ---------- Exemplo a partir de schema (para montar bodies) ----------
  function sample(spec, schema, depth = 0, seen = new Set()) {
    if (!schema || depth > 6) return null;
    if (schema.$ref) {
      if (seen.has(schema.$ref)) return {};
      const next = new Set(seen); next.add(schema.$ref);
      return sample(spec, resolveRef(spec, schema.$ref), depth + 1, next);
    }
    if (schema.example !== undefined) return schema.example;
    if (schema.default !== undefined) return schema.default;
    if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
    if (schema.allOf) return Object.assign({}, ...schema.allOf.map((s) => sample(spec, s, depth + 1, seen)).filter((x) => x && typeof x === 'object'));
    if (schema.oneOf || schema.anyOf) return sample(spec, (schema.oneOf || schema.anyOf)[0], depth + 1, seen);
    const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
    switch (type || (schema.properties ? 'object' : schema.items ? 'array' : undefined)) {
      case 'object': {
        const o = {};
        for (const [k, s] of Object.entries(schema.properties || {})) { if (!s.readOnly) o[k] = sample(spec, s, depth + 1, seen); }
        return o;
      }
      case 'array': return [sample(spec, schema.items, depth + 1, seen)];
      case 'integer': return 0;
      case 'number': return 0;
      case 'boolean': return false;
      case 'string':
        if (schema.format === 'date-time') return '2026-01-01T00:00:00Z';
        if (schema.format === 'date') return '2026-01-01';
        if (schema.format === 'uuid') return '00000000-0000-0000-0000-000000000000';
        if (schema.format === 'email') return 'usuario@exemplo.com';
        return 'string';
      default: return null;
    }
  }

  // ---------- Spec → requisições ----------
  function parseSpec(spec, specUrl) {
    if (!spec || typeof spec !== 'object' || (!spec.openapi && !spec.swagger)) throw new Error('Isto não parece uma especificação OpenAPI/Swagger (faltam os campos "openapi" ou "swagger").');
    if (!spec.paths || typeof spec.paths !== 'object') throw new Error('A especificação não tem "paths".');
    const requests = [];
    for (const [path, item0] of Object.entries(spec.paths)) {
      const item = deref(spec, item0);
      for (const method of METHODS) {
        const op = item[method];
        if (!op) continue;
        const params = [...(item.parameters || []), ...(op.parameters || [])].map((p) => deref(spec, p));
        const ex = (p) => {
          const s = deref(spec, p.schema || {});
          const v = p.example ?? s.example ?? p.default ?? s.default ?? (s.enum && s.enum[0]) ?? (p.enum && p.enum[0]);
          return v === undefined ? '' : String(v);
        };
        const urlPath = path.replace(/\{([^}]+)\}/g, (m, name) => {
          const p = params.find((x) => x.in === 'path' && x.name === name);
          const v = p && ex(p);
          return v ? v : `{{${name}}}`;
        });
        const query = params.filter((p) => p.in === 'query').map((p) => ({ key: p.name, value: ex(p), enabled: !!p.required }));
        const headers = params.filter((p) => p.in === 'header').map((p) => ({ key: p.name, value: ex(p), enabled: !!p.required }));
        let body = { type: 'none', raw: '', form: [] };
        if (isV2(spec)) {
          const bp = params.find((p) => p.in === 'body');
          if (bp) body = { type: 'json', raw: JSON.stringify(sample(spec, bp.schema), null, 2), form: [] };
          const fp = params.filter((p) => p.in === 'formData');
          if (fp.length) body = { type: 'form', raw: '', form: fp.map((p) => ({ key: p.name, value: ex(p), enabled: true })) };
        } else if (op.requestBody) {
          const rb = deref(spec, op.requestBody);
          const content = rb.content || {};
          const jsonKey = Object.keys(content).find((k) => /json/i.test(k));
          if (jsonKey) {
            const c = content[jsonKey];
            const exVal = c.example ?? (c.examples && deref(spec, Object.values(c.examples)[0]).value) ?? sample(spec, c.schema);
            body = { type: 'json', raw: JSON.stringify(exVal, null, 2), form: [] };
          } else if (content['application/x-www-form-urlencoded']) {
            const s = deref(spec, content['application/x-www-form-urlencoded'].schema || {});
            body = { type: 'form', raw: '', form: Object.keys(s.properties || {}).map((k) => ({ key: k, value: '', enabled: true })) };
          }
        }
        const tag = op.tags && op.tags[0];
        requests.push({
          name: op.summary || op.operationId || `${method.toUpperCase()} ${path}`,
          tag: tag || '',
          method: method.toUpperCase(),
          url: '{{baseUrl}}' + urlPath + (query.filter((q) => q.enabled).length ? '?' + query.filter((q) => q.enabled).map((q) => `${q.key}=${q.value}`).join('&') : ''),
          params: query,
          headers,
          body,
          contract: { method, path },
          deprecated: !!op.deprecated,
        });
      }
    }
    requests.sort((a, b) => (a.tag || '').localeCompare(b.tag || '') || a.contract.path.localeCompare(b.contract.path));
    return {
      title: (spec.info && spec.info.title) || 'API',
      version: (spec.info && spec.info.version) || '',
      baseUrl: baseUrlOf(spec, specUrl),
      requests,
    };
  }

  // ---------- Contrato da resposta ----------
  function findResponseSchema(spec, contract, status) {
    const item = deref(spec, spec.paths?.[contract.path] || {});
    const op = item[contract.method];
    if (!op || !op.responses) return { found: false, reason: 'Operação não encontrada no contrato.' };
    const s = String(status);
    const key = [s, `${s[0]}XX`, `${s[0]}xx`, 'default'].find((k) => op.responses[k]);
    if (!key) return { found: false, documented: Object.keys(op.responses), reason: `Status ${s} não está documentado (documentados: ${Object.keys(op.responses).join(', ')}).` };
    const resp = deref(spec, op.responses[key]);
    let schema = null;
    if (isV2(spec)) schema = resp.schema || null;
    else {
      const content = resp.content || {};
      const k = Object.keys(content).find((x) => /json/i.test(x)) || Object.keys(content)[0];
      schema = k ? content[k].schema || null : null;
    }
    return { found: true, key, schema };
  }

  function mergeAllOf(spec, schema, seen = new Set()) {
    const s = deref(spec, schema, new Set(seen));
    if (!s.allOf) return s;
    const out = { ...s, properties: { ...(s.properties || {}) }, required: [...(s.required || [])] };
    delete out.allOf;
    for (const part of s.allOf) {
      const p = mergeAllOf(spec, part, seen);
      Object.assign(out.properties, p.properties || {});
      out.required.push(...(p.required || []));
      if (!out.type && p.type) out.type = p.type;
      if (p.additionalProperties === false) out.additionalProperties = false;
    }
    return out;
  }

  const jsType = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  function typeMatches(expected, v) {
    const t = jsType(v);
    if (expected === 'number') return t === 'number' || t === 'integer';
    return expected === t;
  }

  function validate(spec, schema, value, path = '$', issues = [], depth = 0) {
    if (!schema || issues.length >= 200 || depth > 40) return issues;
    const s = mergeAllOf(spec, schema);
    const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
    const nullable = s.nullable === true || s['x-nullable'] === true || types.includes('null');
    if (value === null) {
      if (!nullable && (types.length || s.properties || s.items)) issues.push({ level: 'erro', path, msg: 'veio null, mas o campo não é nullable' });
      return issues;
    }
    if (s.oneOf || s.anyOf) {
      const branches = (s.oneOf || s.anyOf).map((b) => validate(spec, b, value, path, [], depth + 1));
      const ok = branches.some((b) => !b.some((x) => x.level === 'erro'));
      if (!ok) {
        const best = branches.reduce((a, b) => (b.length < a.length ? b : a));
        issues.push({ level: 'erro', path, msg: `não corresponde a nenhuma opção de ${s.oneOf ? 'oneOf' : 'anyOf'}` }, ...best.slice(0, 5));
      }
      return issues;
    }
    const realTypes = types.filter((t) => t !== 'null');
    const inferred = realTypes.length ? realTypes : s.properties ? ['object'] : s.items ? ['array'] : [];
    if (inferred.length && !inferred.some((t) => typeMatches(t, value))) {
      issues.push({ level: 'erro', path, msg: `esperado ${inferred.join(' | ')}, veio ${jsType(value)}` });
      return issues;
    }
    if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
      issues.push({ level: 'erro', path, msg: `valor ${JSON.stringify(value).slice(0, 40)} fora do enum (${s.enum.slice(0, 6).map((e) => JSON.stringify(e)).join(', ')}${s.enum.length > 6 ? '…' : ''})` });
    }
    if (jsType(value) === 'object') {
      const props = s.properties || {};
      for (const r of s.required || []) if (!(r in value)) issues.push({ level: 'erro', path: `${path}.${r}`, msg: 'campo obrigatório ausente' });
      for (const [k, v] of Object.entries(value)) {
        const p = /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`;
        if (props[k]) validate(spec, props[k], v, p, issues, depth + 1);
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') validate(spec, s.additionalProperties, v, p, issues, depth + 1);
        else if (Object.keys(props).length) issues.push({ level: s.additionalProperties === false ? 'erro' : 'aviso', path: p, msg: 'campo não documentado no contrato' });
      }
    } else if (Array.isArray(value) && s.items) {
      value.slice(0, 50).forEach((v, i) => validate(spec, s.items, v, `${path}[${i}]`, issues, depth + 1));
    }
    return issues;
  }

  function checkResponse(spec, contract, status, bodyText) {
    const r = findResponseSchema(spec, contract, status);
    if (!r.found) return { status: 'undocumented', message: r.reason, issues: [] };
    if (!r.schema) return { status: 'ok', key: r.key, message: `Status ${r.key} documentado sem corpo.`, issues: [] };
    let value;
    try { value = JSON.parse(bodyText); } catch { return { status: 'mismatch', key: r.key, message: 'O contrato espera JSON, mas a resposta não é JSON válido.', issues: [{ level: 'erro', path: '$', msg: 'corpo não é JSON' }] }; }
    const issues = validate(spec, r.schema, value);
    const errors = issues.filter((i) => i.level === 'erro').length;
    return { status: errors ? 'mismatch' : 'ok', key: r.key, issues, message: errors ? `${errors} divergência(s) com o contrato` : issues.length ? `Bate com o contrato (${issues.length} aviso(s))` : 'Bate com o contrato' };
  }

  return { parseSpec, findResponseSchema, validate, checkResponse, sample, baseUrlOf };
});
