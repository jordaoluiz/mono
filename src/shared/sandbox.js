// Scripts no estilo Postman (pm.*): "Antes da requisição" e "Após a resposta".
// Roda dentro de um Web Worker (sem DOM e sem acesso ao app). Também carrega no Node para os testes.
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.MonoSandbox = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- utilidades ----------
  const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : v instanceof Date ? 'date' : v instanceof RegExp ? 'regexp' : typeof v);
  function fmt(v) {
    try {
      if (typeof v === 'string') return JSON.stringify(v);
      if (v === undefined) return 'undefined';
      if (typeof v === 'function') return '[função]';
      if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
      const s = JSON.stringify(v);
      if (s === undefined) return String(v);
      return s.length > 160 ? s.slice(0, 157) + '…' : s;
    } catch { return String(v); }
  }
  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  // Valor que vai para o disco: texto puro (objetos viram JSON).
  const persistable = (v) => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));

  // ---------- variáveis dinâmicas ({{$guid}}, {{$timestamp}}…) ----------
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const rint = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  function uuid() {
    const c = typeof crypto !== 'undefined' ? crypto : null;
    if (c && c.randomUUID) return c.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => { const r = Math.random() * 16 | 0; return (ch === 'x' ? r : (r & 3) | 8).toString(16); });
  }
  const FIRST = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elisa', 'Felipe', 'Gabriela', 'Hugo', 'Isabela', 'João', 'Larissa', 'Marcos', 'Natália', 'Otávio', 'Paula', 'Rafael'];
  const LAST = ['Silva', 'Souza', 'Oliveira', 'Santos', 'Pereira', 'Lima', 'Costa', 'Rodrigues', 'Almeida', 'Carvalho', 'Gomes', 'Ribeiro'];
  const WORDS = ['alpha', 'nuvem', 'rio', 'pedra', 'luz', 'vento', 'mar', 'sol', 'ponte', 'trilha', 'fogo', 'campo'];
  const CITIES = ['São Paulo', 'Rio de Janeiro', 'Belo Horizonte', 'Curitiba', 'Recife', 'Porto Alegre', 'Salvador', 'Fortaleza'];
  const COMPANIES = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Stark', 'Wayne', 'Soylent', 'Hooli'];
  const alnum = (n) => Array.from({ length: n }, () => pick('abcdefghijklmnopqrstuvwxyz0123456789')).join('');
  const DYNAMIC = {
    $guid: uuid, $randomUUID: uuid,
    $timestamp: () => String(Math.floor(Date.now() / 1000)),
    $isoTimestamp: () => new Date().toISOString(),
    $randomInt: () => String(rint(0, 1000)),
    $randomBoolean: () => String(Math.random() < 0.5),
    $randomFirstName: () => pick(FIRST), $randomLastName: () => pick(LAST),
    $randomFullName: () => `${pick(FIRST)} ${pick(LAST)}`,
    $randomUserName: () => `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase()}${rint(1, 99)}`.normalize('NFD').replace(/[̀-ͯ]/g, ''),
    $randomEmail: () => `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase()}${rint(1, 999)}@exemplo.com`.normalize('NFD').replace(/[̀-ͯ]/g, ''),
    $randomPhoneNumber: () => `(${rint(11, 99)}) 9${rint(1000, 9999)}-${rint(1000, 9999)}`,
    $randomAlphaNumeric: () => alnum(1), $randomWord: () => pick(WORDS), $randomCity: () => pick(CITIES),
    $randomCompanyName: () => pick(COMPANIES), $randomPrice: () => (Math.random() * 1000).toFixed(2),
    $randomIP: () => [rint(1, 255), rint(0, 255), rint(0, 255), rint(1, 254)].join('.'),
    $randomColor: () => pick(['red', 'green', 'blue', 'yellow', 'purple', 'orange', 'black', 'white']),
    $randomUrl: () => `https://${pick(WORDS)}.exemplo.com`,
    $randomLoremWord: () => pick(['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing']),
    $randomHexColor: () => '#' + rint(0, 0xffffff).toString(16).padStart(6, '0'),
    $randomDateFuture: () => new Date(Date.now() + rint(1, 365) * 864e5).toISOString(),
    $randomDatePast: () => new Date(Date.now() - rint(1, 365) * 864e5).toISOString(),
  };
  const dynamicVar = (name) => (hasOwn(DYNAMIC, name) ? DYNAMIC[name]() : undefined);
  const VAR_RE = /\{\{\s*(\$?[\w.-]+)\s*\}\}/g;
  function replaceVars(str, lookup) {
    return String(str ?? '').replace(VAR_RE, (m, k) => {
      const v = lookup(k);
      if (v !== undefined) return persistable(v);
      const d = k[0] === '$' ? dynamicVar(k) : undefined;
      return d !== undefined ? d : m;
    });
  }

  // ---------- JSON Schema (subconjunto) ----------
  function validateSchema(schema, value, path = '$', errors = []) {
    if (!schema || typeof schema !== 'object' || errors.length > 20) return errors;
    const t = typeOf(value);
    const is = (type) => type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' : type === 'object' ? t === 'object' : type === t;
    if (value === null && schema.nullable) return errors;
    if (schema.type) {
      const types = [].concat(schema.type);
      if (!types.some(is)) { errors.push(`${path}: esperado ${types.join(' | ')}, recebido ${t}`); return errors; }
    }
    if (hasOwn(schema, 'const') && !deepEqual(schema.const, value)) errors.push(`${path}: esperado ${fmt(schema.const)}`);
    if (schema.enum && !schema.enum.some((e) => deepEqual(e, value))) errors.push(`${path}: ${fmt(value)} não está em ${fmt(schema.enum)}`);
    if (typeof value === 'number') {
      if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: menor que ${schema.minimum}`);
      if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: maior que ${schema.maximum}`);
    }
    if (typeof value === 'string') {
      if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: menos de ${schema.minLength} caracteres`);
      if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path}: mais de ${schema.maxLength} caracteres`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: não corresponde a ${schema.pattern}`);
    }
    if (t === 'array') {
      if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path}: menos de ${schema.minItems} itens`);
      if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path}: mais de ${schema.maxItems} itens`);
      if (schema.items) value.forEach((v, i) => validateSchema(schema.items, v, `${path}[${i}]`, errors));
    }
    if (t === 'object') {
      for (const k of schema.required || []) if (!hasOwn(value, k)) errors.push(`${path}.${k}: obrigatório`);
      const props = schema.properties || {};
      for (const [k, s] of Object.entries(props)) if (hasOwn(value, k)) validateSchema(s, value[k], `${path}.${k}`, errors);
      if (schema.additionalProperties === false) for (const k of Object.keys(value)) if (!hasOwn(props, k)) errors.push(`${path}.${k}: campo não permitido`);
    }
    if (schema.allOf) schema.allOf.forEach((s) => validateSchema(s, value, path, errors));
    if (schema.anyOf && !schema.anyOf.some((s) => !validateSchema(s, value, path, []).length)) errors.push(`${path}: não satisfaz nenhum anyOf`);
    if (schema.oneOf && schema.oneOf.filter((s) => !validateSchema(s, value, path, []).length).length !== 1) errors.push(`${path}: deve satisfazer exatamente um oneOf`);
    return errors;
  }

  // ---------- Asserções (subconjunto do Chai usado no Postman + atalhos estilo Jest) ----------
  class AssertionError extends Error { constructor(m) { super(m); this.name = 'AssertionError'; } }
  function Assertion(obj, flags) { this._obj = obj; this._f = flags || {}; }
  const AP = Assertion.prototype;
  for (const c of ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'but', 'does', 'still', 'also']) {
    Object.defineProperty(AP, c, { get() { return this; } });
  }
  for (const f of ['not', 'deep', 'own', 'nested', 'any', 'all', 'ordered']) {
    Object.defineProperty(AP, f, { get() { this._f[f] = !(f === 'not' && this._f.not); return this; } });
  }
  AP.assert = function (ok, text, actual) {
    const pass = this._f.not ? !ok : !!ok;
    if (!pass) throw new AssertionError(`${this._f.label ? this._f.label + ': ' : ''}esperado ${actual !== undefined ? actual : (isResponse(this._obj) ? `resposta ${this._obj.code}` : fmt(this._obj))} ${this._f.not ? 'não ' : ''}${text}`);
  };
  const isResponse = (o) => o && o.__monoResponse === true;
  const subject = (a) => (a._f.doLength ? (a._obj == null ? undefined : a._obj.length) : a._obj);
  function method(names, fn) { for (const n of [].concat(names)) AP[n] = function (...a) { fn.apply(this, a); return this; }; }
  function prop(names, fn) { for (const n of [].concat(names)) Object.defineProperty(AP, n, { get() { fn.call(this); return this; } }); }
  // Propriedade que também é função (ex.: include / include.members, length / length.above).
  function chainable(names, fn, flag) {
    for (const n of [].concat(names)) Object.defineProperty(AP, n, {
      get() {
        const self = this;
        self._f[flag] = true;
        const f = function (...a) { fn.apply(self, a); return self; };
        Object.setPrototypeOf(f, self);
        return f;
      },
    });
  }

  method(['equal', 'equals', 'eq'], function (v) {
    const s = subject(this);
    this.assert(this._f.deep ? deepEqual(s, v) : s === v || (Number.isNaN(s) && Number.isNaN(v)), `${this._f.deep ? 'ser profundamente igual a' : 'ser igual a'} ${fmt(v)}`, this._f.doLength ? `tamanho ${fmt(s)}` : undefined);
  });
  method(['eql', 'eqls'], function (v) { this.assert(deepEqual(subject(this), v), `ser igual (profundo) a ${fmt(v)}`); });
  method(['above', 'gt', 'greaterThan'], function (n) { const s = subject(this); this.assert(s > n, `ser maior que ${n}`, this._f.doLength ? `tamanho ${s}` : undefined); });
  method(['least', 'gte'], function (n) { const s = subject(this); this.assert(s >= n, `ser no mínimo ${n}`, this._f.doLength ? `tamanho ${s}` : undefined); });
  method(['below', 'lt', 'lessThan'], function (n) { const s = subject(this); this.assert(s < n, `ser menor que ${n}`, this._f.doLength ? `tamanho ${s}` : undefined); });
  method(['most', 'lte'], function (n) { const s = subject(this); this.assert(s <= n, `ser no máximo ${n}`, this._f.doLength ? `tamanho ${s}` : undefined); });
  method('within', function (a, b) { const s = subject(this); this.assert(s >= a && s <= b, `estar entre ${a} e ${b}`); });
  method(['closeTo', 'approximately'], function (v, d) { this.assert(Math.abs(this._obj - v) <= d, `estar a ±${d} de ${v}`); });
  method(['a', 'an'], function (type) {
    const t = String(type).toLowerCase();
    this.assert(typeOf(this._obj) === t, `ser do tipo ${t}`, `${fmt(this._obj)} (${typeOf(this._obj)})`);
  });
  method(['instanceOf', 'instanceof'], function (C) { this.assert(this._obj instanceof C, `ser instância de ${C && C.name}`); });
  method(['match', 'matches'], function (re) { this.assert(new RegExp(re).test(String(this._obj)), `corresponder a ${re}`); });
  method('string', function (s) { this.assert(typeof this._obj === 'string' && this._obj.includes(s), `conter ${fmt(s)}`); });
  method('oneOf', function (list) { this.assert(list.some((x) => (this._f.deep ? deepEqual(x, this._obj) : x === this._obj)), `ser um de ${fmt(list)}`); });
  method('satisfy', function (fn) { this.assert(fn(this._obj), 'satisfazer a condição'); });
  method(['throw', 'throws', 'Throw'], function (expected) {
    let err = null;
    try { this._obj(); } catch (e) { err = e; }
    const match = !err ? false : expected == null ? true : expected instanceof RegExp ? expected.test(err.message) : typeof expected === 'string' ? String(err.message).includes(expected) : typeof expected === 'function' ? err instanceof expected : true;
    this.assert(match, `lançar erro${expected != null ? ' ' + fmt(String(expected)) : ''}`, '[função]');
  });
  chainable(['include', 'includes', 'contain', 'contains'], function (v) {
    const o = this._obj;
    let ok;
    if (typeof o === 'string') ok = o.includes(v);
    else if (Array.isArray(o)) ok = o.some((x) => (this._f.deep || (v && typeof v === 'object') ? deepEqual(x, v) : x === v));
    else if (o && typeof o === 'object' && v && typeof v === 'object') ok = Object.keys(v).every((k) => hasOwn(o, k) && (this._f.deep ? deepEqual(o[k], v[k]) : o[k] === v[k] || deepEqual(o[k], v[k])));
    else if (o instanceof Set || o instanceof Map) ok = o.has(v);
    else ok = false;
    this.assert(ok, `incluir ${fmt(v)}`);
  }, 'contains');
  chainable(['length', 'lengthOf'], function (n) {
    const len = this._obj == null ? undefined : this._obj.length;
    this.assert(len === n, `ter tamanho ${n}`, `${fmt(this._obj)} (tamanho ${len})`);
  }, 'doLength');
  method('property', function (name, ...val) {
    const o = this._obj;
    let has, v;
    if (this._f.nested) {
      v = o; has = true;
      for (const part of String(name).replace(/\[(\d+)\]/g, '.$1').split('.')) { if (v != null && part in Object(v)) v = v[part]; else { has = false; break; } }
    } else {
      has = this._f.own ? hasOwn(o, name) : o != null && name in Object(o);
      v = has ? o[name] : undefined;
    }
    if (val.length) this.assert(has && (this._f.deep ? deepEqual(v, val[0]) : v === val[0]), `ter a propriedade ${fmt(name)} igual a ${fmt(val[0])}`);
    else this.assert(has, `ter a propriedade ${fmt(name)}`);
    if (!this._f.not) { this._obj = v; this._f.deep = false; this._f.nested = false; this._f.own = false; }
  });
  method(['ownProperty', 'haveOwnProperty'], function (name) { this.assert(hasOwn(this._obj, name), `ter a propriedade própria ${fmt(name)}`); });
  method(['keys', 'key'], function (...ks) {
    const keys = ks.length === 1 && Array.isArray(ks[0]) ? ks[0] : ks.length === 1 && ks[0] && typeof ks[0] === 'object' ? Object.keys(ks[0]) : ks;
    const actual = this._obj instanceof Map ? [...this._obj.keys()] : Object.keys(this._obj || {});
    let ok;
    if (this._f.any) ok = keys.some((k) => actual.includes(k));
    else if (this._f.contains) ok = keys.every((k) => actual.includes(k));
    else ok = keys.every((k) => actual.includes(k)) && actual.length === keys.length;
    this.assert(ok, `ter ${this._f.any ? 'alguma das' : 'as'} chaves ${fmt(keys)}`);
  });
  method('members', function (list) {
    const o = this._obj || [];
    const eq = (a, b) => deepEqual(a, b);
    const ok = this._f.contains ? list.every((x) => o.some((y) => eq(x, y)))
      : this._f.ordered ? o.length === list.length && list.every((x, i) => eq(x, o[i]))
        : o.length === list.length && list.every((x) => o.some((y) => eq(x, y)));
    this.assert(ok, `ter os membros ${fmt(list)}`);
  });
  method('jsonSchema', function (schema) {
    let v = this._obj;
    if (isResponse(v)) { try { v = v.json(); } catch { this.assert(false, 'ter corpo JSON'); return; } }
    const errs = validateSchema(schema, v);
    this.assert(!errs.length, `seguir o schema${errs.length ? ' — ' + errs.slice(0, 3).join('; ') : ''}`);
  });
  prop('ok', function () { if (isResponse(this._obj)) this.assert(this._obj.code === 200, 'ter status 200', `status ${this._obj.code}`); else this.assert(!!this._obj, 'ser verdadeiro (truthy)'); });
  prop('true', function () { this.assert(this._obj === true, 'ser true'); });
  prop('false', function () { this.assert(this._obj === false, 'ser false'); });
  prop('null', function () { this.assert(this._obj === null, 'ser null'); });
  prop('undefined', function () { this.assert(this._obj === undefined, 'ser undefined'); });
  prop('NaN', function () { this.assert(Number.isNaN(this._obj), 'ser NaN'); });
  prop(['exist', 'exists'], function () { this.assert(this._obj != null, 'existir'); });
  prop('empty', function () {
    const o = this._obj;
    const empty = typeof o === 'string' || Array.isArray(o) ? o.length === 0 : o instanceof Map || o instanceof Set ? o.size === 0 : o && typeof o === 'object' ? Object.keys(o).length === 0 : false;
    this.assert(empty, 'estar vazio');
  });
  prop('finite', function () { this.assert(Number.isFinite(this._obj), 'ser finito'); });

  // Asserções de resposta: pm.response.to.have.status(200), pm.response.to.be.success…
  const rangeProp = (name, test, text) => prop(name, function () { const r = this._obj; this.assert(isResponse(r) && test(r.code), text, `status ${r && r.code}`); });
  rangeProp('info', (c) => c >= 100 && c < 200, 'ser 1xx');
  rangeProp('success', (c) => c >= 200 && c < 300, 'ser 2xx (sucesso)');
  rangeProp('redirection', (c) => c >= 300 && c < 400, 'ser 3xx (redirecionamento)');
  rangeProp('clientError', (c) => c >= 400 && c < 500, 'ser 4xx (erro do cliente)');
  rangeProp('serverError', (c) => c >= 500, 'ser 5xx (erro do servidor)');
  rangeProp('error', (c) => c >= 400, 'ser erro (4xx/5xx)');
  rangeProp('accepted', (c) => c === 202, 'ser 202');
  rangeProp('badRequest', (c) => c === 400, 'ser 400');
  rangeProp('unauthorized', (c) => c === 401, 'ser 401');
  rangeProp('forbidden', (c) => c === 403, 'ser 403');
  rangeProp('notFound', (c) => c === 404, 'ser 404');
  rangeProp('rateLimited', (c) => c === 429, 'ser 429');
  const ctProp = (name, re) => prop(name, function () { const r = this._obj; this.assert(isResponse(r) && re.test(r.headers.get('content-type') || ''), `ser ${name.toUpperCase()}`, `content-type ${fmt(r && r.headers.get('content-type'))}`); });
  ctProp('json', /json/i); ctProp('html', /html/i); ctProp('xml', /xml/i);
  prop('withBody', function () { this.assert(isResponse(this._obj) && this._obj.text().length > 0, 'ter corpo'); });
  method('status', function (s) {
    const r = this._obj;
    const ok = typeof s === 'number' ? r.code === s : String(r.status).toLowerCase() === String(s).toLowerCase();
    this.assert(ok, `ter status ${fmt(s)}`, `resposta com status ${r.code}${r.status ? ' ' + r.status : ''}`);
  });
  method('header', function (k, ...v) {
    const r = this._obj;
    const has = r.headers.has(k);
    if (v.length) this.assert(has && r.headers.get(k) === v[0], `ter o header ${k}: ${v[0]}`, `resposta (header ${k} = ${fmt(r.headers.get(k))})`);
    else this.assert(has, `ter o header ${k}`, 'resposta');
  });
  method('body', function (...v) {
    const t = this._obj.text();
    if (!v.length) this.assert(t.length > 0, 'ter corpo', 'resposta');
    else if (v[0] instanceof RegExp) this.assert(v[0].test(t), `ter corpo que corresponde a ${v[0]}`, 'resposta');
    else this.assert(t === String(v[0]), `ter corpo ${fmt(String(v[0]).slice(0, 80))}`, 'resposta');
  });
  method('jsonBody', function (path, ...v) {
    let body;
    try { body = this._obj.json(); } catch { this.assert(false, 'ter corpo JSON', 'resposta'); return; }
    if (path === undefined) return;
    if (typeof path === 'object') { this.assert(deepEqual(body, path), `ter JSON igual a ${fmt(path)}`, 'resposta'); return; }
    let cur = body, has = true;
    for (const p of String(path).replace(/\[(\d+)\]/g, '.$1').split('.')) { if (cur != null && p in Object(cur)) cur = cur[p]; else { has = false; break; } }
    if (v.length) this.assert(has && deepEqual(cur, v[0]), `ter ${path} = ${fmt(v[0])}`, `resposta (${path} = ${fmt(cur)})`);
    else this.assert(has, `ter ${path} no JSON`, 'resposta');
  });
  method('responseTime', function () { /* compat */ });

  // Atalhos estilo Jest (scripts antigos do Mono: expect(x).toBe(y)).
  const jest = {
    toBe(v) { this.assert(this._obj === v, `ser ${fmt(v)}`); },
    toEqual(v) { this.assert(deepEqual(this._obj, v), `ser igual a ${fmt(v)}`); },
    toStrictEqual(v) { this.assert(deepEqual(this._obj, v), `ser igual a ${fmt(v)}`); },
    toBeDefined() { this.assert(this._obj !== undefined, 'estar definido'); },
    toBeUndefined() { this.assert(this._obj === undefined, 'ser undefined'); },
    toBeNull() { this.assert(this._obj === null, 'ser null'); },
    toBeTruthy() { this.assert(!!this._obj, 'ser verdadeiro'); },
    toBeFalsy() { this.assert(!this._obj, 'ser falso'); },
    toContain(x) { this.assert(this._obj != null && this._obj.includes(x), `conter ${fmt(x)}`); },
    toMatch(re) { this.assert(new RegExp(re).test(String(this._obj)), `corresponder a ${re}`); },
    toBeLessThan(n) { this.assert(this._obj < n, `ser menor que ${n}`); },
    toBeGreaterThan(n) { this.assert(this._obj > n, `ser maior que ${n}`); },
    toBeLessThanOrEqual(n) { this.assert(this._obj <= n, `ser no máximo ${n}`); },
    toBeGreaterThanOrEqual(n) { this.assert(this._obj >= n, `ser no mínimo ${n}`); },
    toHaveProperty(k) { this.assert(this._obj != null && hasOwn(this._obj, k), `ter a propriedade ${fmt(k)}`); },
    toHaveLength(n) { this.assert(this._obj != null && this._obj.length === n, `ter tamanho ${n}`); },
  };
  for (const [k, fn] of Object.entries(jest)) AP[k] = function (...a) { fn.apply(this, a); return this; };

  const expect = (v, msg) => new Assertion(v, msg ? { label: String(msg) } : {});

  // ---------- Listas de chave/valor (headers, query) ----------
  class PropertyList {
    constructor(items, caseInsensitive) {
      this._ci = !!caseInsensitive;
      this.members = (items || []).map((x) => ({ key: String(x.key ?? ''), value: x.value == null ? '' : x.value, disabled: x.disabled != null ? !!x.disabled : x.enabled === false }));
    }
    _is(k) { const want = String(k); return this._ci ? (m) => m.key.toLowerCase() === want.toLowerCase() : (m) => m.key === want; }
    _norm(item) {
      if (typeof item === 'string') { const i = item.indexOf(':'); return { key: (i < 0 ? item : item.slice(0, i)).trim(), value: i < 0 ? '' : item.slice(i + 1).trim() }; }
      return { key: String(item.key ?? ''), value: item.value == null ? '' : item.value, disabled: !!item.disabled };
    }
    get(k) { const m = this.members.find((x) => !x.disabled && this._is(k)(x)); return m ? m.value : undefined; }
    one(k) { return this.members.find(this._is(k)); }
    has(k, v) { const m = this.members.find((x) => !x.disabled && this._is(k)(x)); return !!m && (v === undefined || m.value === v); }
    add(item) { const n = this._norm(item); this.members.push({ key: n.key, value: n.value, disabled: !!n.disabled }); }
    upsert(item) { const n = this._norm(item); const m = this.one(n.key); if (m) { m.value = n.value; m.disabled = !!n.disabled; } else this.add(n); }
    remove(k) {
      const pred = typeof k === 'function' ? k : this._is(k && typeof k === 'object' ? k.key : k);
      this.members = this.members.filter((m) => !pred(m));
    }
    clear() { this.members = []; }
    count() { return this.members.length; }
    all() { return this.members.slice(); }
    each(fn) { this.members.forEach(fn); }
    map(fn) { return this.members.map(fn); }
    filter(fn) { return this.members.filter(fn); }
    find(fn) { return this.members.find(fn); }
    indexOf(k) { return this.members.findIndex(this._is(k)); }
    toObject() { const o = {}; for (const m of this.members) if (!m.disabled) o[m.key] = m.value; return o; }
    toJSON() { return this.members; }
    toString() { return this.members.filter((m) => !m.disabled).map((m) => `${m.key}: ${m.value}`).join('\n'); }
    get length() { return this.members.length; }
  }

  function parseQuery(q) {
    return q ? q.split('&').filter(Boolean).map((part) => {
      const j = part.indexOf('=');
      const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
      return { key: dec(j < 0 ? part : part.slice(0, j)), value: j < 0 ? '' : dec(part.slice(j + 1)) };
    }) : [];
  }
  class Url {
    constructor(raw, params) {
      this.update(raw);
      if (Array.isArray(params)) this.query = new PropertyList(params);
    }
    update(raw) {
      const s = String(raw ?? '');
      const i = s.indexOf('?');
      this._base = i < 0 ? s : s.slice(0, i);
      this.query = new PropertyList(i < 0 ? [] : parseQuery(s.slice(i + 1)));
    }
    getQueryString() { return this.query.members.filter((m) => !m.disabled).map((m) => (m.value === '' ? m.key : `${m.key}=${m.value}`)).join('&'); }
    toString() { const q = this.getQueryString(); return this._base + (q ? '?' + q : ''); }
    toJSON() { return this.toString(); }
    getHost() { const m = this._base.match(/^(?:[a-z][\w+.-]*:\/\/)?([^/:?#]*)/i); return m ? m[1] : ''; }
    getPath() { const m = this._base.match(/^(?:[a-z][\w+.-]*:\/\/)?[^/?#]*(\/[^?#]*)?/i); return (m && m[1]) || '/'; }
    getPathWithQuery() { const q = this.getQueryString(); return this.getPath() + (q ? '?' + q : ''); }
    get protocol() { const m = this._base.match(/^([a-z][\w+.-]*):\/\//i); return m ? m[1] : ''; }
    get host() { return this.getHost().split('.'); }
    get path() { return this.getPath().split('/').filter(Boolean); }
    addQueryParams(p) { for (const x of [].concat(typeof p === 'string' ? parseQuery(p) : p)) this.query.add(x); }
    removeQueryParams(names) { for (const n of [].concat(names)) this.query.remove(typeof n === 'object' ? n.key : n); }
  }

  // ---------- Corpo da requisição ----------
  function makeBody(b) {
    b = b || { type: 'none' };
    const body = {
      mode: b.type === 'graphql' ? 'graphql' : b.type === 'form' ? 'urlencoded' : b.type === 'multipart' ? 'formdata' : b.type === 'binary' ? 'file' : b.type === 'json' || b.type === 'text' || b.type === 'xml' ? 'raw' : undefined,
      raw: b.type === 'graphql' ? JSON.stringify({ query: (b.graphql || {}).query || '', variables: (b.graphql || {}).variables || '' }) : b.raw || '',
      graphql: b.type === 'graphql' ? { query: (b.graphql || {}).query || '', variables: (b.graphql || {}).variables || '' } : undefined,
      urlencoded: new PropertyList(b.form || []),
      formdata: new PropertyList((b.multipart || []).map((m) => ({ key: m.key, value: m.kind === 'file' ? (m.fileName || '') : m.value, disabled: m.enabled === false, type: m.kind === 'file' ? 'file' : 'text' }))),
      options: { raw: { language: b.type === 'json' ? 'json' : b.type === 'xml' ? 'xml' : 'text' } },
      _orig: b.type, _source: b, _changed: false,
      update(x) {
        this._changed = true;
        if (typeof x === 'string') { this.mode = 'raw'; this.raw = x; return; }
        if (!x) return;
        if (x.mode) this.mode = x.mode;
        if (x.raw !== undefined) { this.raw = typeof x.raw === 'string' ? x.raw : JSON.stringify(x.raw); if (!x.mode) this.mode = 'raw'; }
        if (x.urlencoded) { this.urlencoded = new PropertyList(x.urlencoded); if (!x.mode) this.mode = 'urlencoded'; }
        if (x.options) this.options = x.options;
      },
      isEmpty() { return !this.mode || (this.mode === 'raw' ? !this.raw : !this.urlencoded.count()); },
      toString() { return this.mode === 'urlencoded' ? this.urlencoded.members.map((m) => `${m.key}=${m.value}`).join('&') : this.raw; },
    };
    return body;
  }
  function serializeBody(body) {
    // form-data com arquivos e binário não são reconstruídos pelo script: o corpo original segue intacto.
    if (!body._changed && (body._orig === 'multipart' || body._orig === 'binary' || body._orig === 'graphql')) return JSON.parse(JSON.stringify(body._source));
    if (!body.mode || body.mode === 'none') return { type: 'none', raw: body.raw || '', form: [] };
    if (body.mode === 'urlencoded' || body.mode === 'formdata') return { type: 'form', raw: '', form: (body.mode === 'formdata' ? new PropertyList(body.formdata || []) : body.urlencoded).members.map((m) => ({ key: m.key, value: persistable(m.value), enabled: !m.disabled })) };
    const lang = body.options && body.options.raw && body.options.raw.language;
    if (lang === 'xml' || (body._orig === 'xml' && (!lang || lang === 'text'))) return { type: 'xml', raw: body.raw || '', form: [] };
    let json = lang === 'json';
    if (!lang || lang === 'text') json = body._orig === 'json' || (body._orig !== 'text' && /^\s*[[{]/.test(body.raw || ''));
    return { type: json ? 'json' : 'text', raw: body.raw || '', form: [] };
  }

  // ---------- Requisição ----------
  function makeRequest(r) {
    r = r || {};
    let url = new Url(r.url || '', Array.isArray(r.params) && r.params.length ? r.params.filter((p) => p.key || p.value) : undefined);
    const req = {
      id: r.id, name: r.name || '', method: String(r.method || 'GET').toUpperCase(),
      headers: new PropertyList((r.headers || []).filter((x) => x.key || x.value), true),
      body: makeBody(r.body),
      auth: r.auth ? JSON.parse(JSON.stringify(r.auth)) : undefined,
      addHeader(x) { this.headers.add(x); },
      removeHeader(k) { this.headers.remove(k); },
      upsertHeader(x) { this.headers.upsert(x); },
      addQueryParams(p) { url.addQueryParams(p); },
      removeQueryParams(n) { url.removeQueryParams(n); },
      toJSON() { return { method: this.method, url: url.toString(), header: this.headers.members, body: this.body.toString() }; },
    };
    Object.defineProperty(req, 'url', {
      enumerable: true,
      get() { return url; },
      set(v) { url = v instanceof Url ? v : new Url(typeof v === 'object' && v ? v.raw || v.toString() : v); },
    });
    return req;
  }
  function serializeRequest(req, original) {
    return {
      ...original,
      method: String(req.method || 'GET').toUpperCase(),
      url: req.url.toString(),
      params: req.url.query.members.map((m) => ({ key: m.key, value: persistable(m.value), enabled: !m.disabled })),
      headers: req.headers.members.map((m) => ({ key: m.key, value: persistable(m.value), enabled: !m.disabled })),
      body: serializeBody(req.body),
      ...(req.auth ? { auth: req.auth } : {}),
    };
  }

  // ---------- Resposta ----------
  const STATUS = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 418: "I'm a teapot", 422: 'Unprocessable Entity', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };
  function parseCookies(headers) {
    const list = [];
    for (const h of headers || []) {
      if (String(h.key).toLowerCase() !== 'set-cookie') continue;
      for (const c of String(h.value).split(/\n|,(?=\s*[^;,=\s]+=)/)) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        if (i > 0) list.push({ key: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim() });
      }
    }
    return list;
  }
  function makeCookies(list) {
    const pl = new PropertyList(list);
    return { get: (k) => pl.get(k), has: (k) => pl.has(k), toObject: () => pl.toObject(), all: () => pl.all(), each: (f) => pl.each(f), count: () => pl.count() };
  }
  function makeResponse(r) {
    const body = r.body == null ? '' : String(r.body);
    let parsed, parsedOk = null;
    const resp = {
      __monoResponse: true,
      code: r.status, status: r.statusText || STATUS[r.status] || '',
      responseTime: r.time, responseSize: r.size,
      headers: new PropertyList(r.headers || [], true),
      cookies: makeCookies(parseCookies(r.headers)),
      text: () => body,
      json() {
        if (parsedOk === null) { try { parsed = JSON.parse(body); parsedOk = true; } catch (e) { parsedOk = false; parsed = e; } }
        if (!parsedOk) throw new Error('A resposta não é JSON válido: ' + parsed.message);
        return parsed;
      },
      reason: () => r.statusText || STATUS[r.status] || '',
      get to() { return new Assertion(resp, { msgObj: undefined }); },
      get not() { return new Assertion(resp, {}).not; },
      toJSON() { return { code: resp.code, status: resp.status, responseTime: resp.responseTime, headers: resp.headers.members, body }; },
    };
    // o assert usa fmt(obj); para resposta, mostre algo legível
    Object.defineProperty(resp, 'toString', { value: () => `resposta ${resp.code}` });
    return resp;
  }

  // ---------- Template do visualizador (subconjunto do Handlebars) ----------
  function renderTemplate(tpl, data) {
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const tokens = [];
    const re = /\{\{\{\s*([^}]+?)\s*\}\}\}|\{\{(!--[\s\S]*?--|![\s\S]*?)\}\}|\{\{\s*([#/^]?)(?:\s*)(else\b)?\s*([^}]*?)\s*\}\}/g;
    let last = 0, m;
    while ((m = re.exec(tpl))) {
      if (m.index > last) tokens.push({ t: 'text', v: tpl.slice(last, m.index) });
      if (m[1]) tokens.push({ t: 'raw', v: m[1] });
      else if (m[2]) { /* comentário */ }
      else if (m[4]) tokens.push({ t: 'else' });
      else if (m[3] === '#') { const [name, ...rest] = m[5].split(/\s+/); tokens.push({ t: 'open', name, arg: rest.join(' ') }); }
      else if (m[3] === '/') tokens.push({ t: 'close', name: m[5] });
      else tokens.push({ t: 'var', v: m[5] });
      last = re.lastIndex;
    }
    if (last < tpl.length) tokens.push({ t: 'text', v: tpl.slice(last) });
    let i = 0;
    function parse(stopNames) {
      const nodes = [];
      while (i < tokens.length) {
        const tk = tokens[i];
        if (tk.t === 'close' || (tk.t === 'else' && stopNames)) return nodes;
        i++;
        if (tk.t === 'open') {
          const body = parse(true);
          let alt = [];
          if (tokens[i] && tokens[i].t === 'else') { i++; alt = parse(true); }
          if (tokens[i] && tokens[i].t === 'close') i++;
          nodes.push({ t: 'block', name: tk.name, arg: tk.arg, body, alt });
        } else nodes.push(tk);
      }
      return nodes;
    }
    const tree = parse(false);
    function lookup(path, ctx) {
      path = path.trim();
      let frame = ctx;
      while (path.startsWith('../')) { frame = frame.parent || frame; path = path.slice(3); }
      if (path === 'this' || path === '.') return frame.value;
      if (path[0] === '@') return frame.meta ? frame.meta[path.slice(1)] : undefined;
      const parts = path.replace(/^this\./, '').split('.');
      let f = frame;
      while (f) {
        let v = f.value, ok = true;
        for (const p of parts) { if (v != null && typeof v === 'object' && p in v) v = v[p]; else { ok = false; break; } }
        if (ok) return v;
        if (path.startsWith('this.')) return undefined;
        f = f.parent;
      }
      return undefined;
    }
    const truthy = (v) => (Array.isArray(v) ? v.length > 0 : !!v);
    const str = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    function render(nodes, ctx) {
      let out = '';
      for (const n of nodes) {
        if (n.t === 'text') out += n.v;
        else if (n.t === 'var') out += esc(str(lookup(n.v, ctx)));
        else if (n.t === 'raw') out += str(lookup(n.v, ctx));
        else if (n.t === 'block') {
          const v = lookup(n.arg || 'this', ctx);
          if (n.name === 'each') {
            const entries = Array.isArray(v) ? v.map((x, k) => [k, x]) : v && typeof v === 'object' ? Object.entries(v) : [];
            if (!entries.length) out += render(n.alt, ctx);
            entries.forEach(([k, x], idx) => { out += render(n.body, { value: x, parent: ctx, meta: { index: idx, key: k, first: idx === 0, last: idx === entries.length - 1 } }); });
          } else if (n.name === 'if') out += render(truthy(v) ? n.body : n.alt, ctx);
          else if (n.name === 'unless') out += render(!truthy(v) ? n.body : n.alt, ctx);
          else if (n.name === 'with') out += v != null ? render(n.body, { value: v, parent: ctx }) : render(n.alt, ctx);
          else out += render(n.body, ctx);
        }
      }
      return out;
    }
    return render(tree, { value: data, parent: null });
  }

  // ---------- Execução ----------
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const HEADER_LINES = 3; // "async function anonymous(…" + ") {" + '"use strict";'
  function errorInfo(e) {
    const message = e && e.message ? e.message : String(e);
    let line = null;
    const m = e && e.stack && String(e.stack).match(/(?:<anonymous>|anonymous):(\d+):(\d+)/);
    if (m) { const l = Number(m[1]) - HEADER_LINES; if (l > 0) line = l; }
    return { message, line, name: e && e.name };
  }

  /*
   input: {
     event: 'prerequest' | 'test',
     scripts: [{ code, source }],         // coleção → pastas → requisição
     request, response?,                  // formato do Mono
     vars: { globals, collection, environment }, local?: {},
     info?: { requestName, requestId }
   }
   hooks: { send(req, vars) → Promise<resposta do Mono> }
  */
  async function run(input, hooks = {}) {
    const event = input.event === 'prerequest' ? 'prerequest' : 'test';
    const results = [], logs = [];
    let source = '';
    const scopes = {
      globals: { ...(input.vars && input.vars.globals) },
      collection: { ...(input.vars && input.vars.collection) },
      environment: { ...(input.vars && input.vars.environment) },
    };
    const local = { ...(input.local || {}) };
    const dataRow = { ...(input.data || {}) };
    const changes = { globals: {}, collection: {}, environment: {} };
    const resolve = (k) => (hasOwn(local, k) ? local[k] : hasOwn(dataRow, k) ? dataRow[k] : hasOwn(scopes.environment, k) ? scopes.environment[k] : hasOwn(scopes.collection, k) ? scopes.collection[k] : hasOwn(scopes.globals, k) ? scopes.globals[k] : undefined);
    const merged = () => ({ ...scopes.globals, ...scopes.collection, ...scopes.environment, ...dataRow, ...local });
    const replaceIn = (s) => replaceVars(s, resolve);

    const scope = (name) => {
      const vals = scopes[name];
      return {
        get: (k) => vals[k],
        set: (k, v) => { vals[k] = v; changes[name][k] = { value: persistable(v) }; },
        unset: (k) => { delete vals[k]; changes[name][k] = { unset: true }; },
        has: (k) => hasOwn(vals, k),
        clear: () => { for (const k of Object.keys(vals)) { delete vals[k]; changes[name][k] = { unset: true }; } },
        toObject: () => ({ ...vals }),
        toJSON: () => ({ ...vals }),
        replaceIn,
        values: { each: (fn) => Object.entries(vals).forEach(([key, value]) => fn({ key, value })) },
        name: { globals: 'globais', collection: 'coleção', environment: 'ambiente' }[name],
      };
    };

    // Pendências (testes assíncronos, timers, sendRequest): a execução espera todas terminarem.
    const pending = new Set();
    const track = (p) => { const q = Promise.resolve(p).catch(() => {}).finally(() => pending.delete(q)); pending.add(q); return p; };

    const log = (level) => (...a) => logs.push({ level, source, text: a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? `${x.name}: ${x.message}` : (() => { try { return JSON.stringify(x, null, 2) ?? String(x); } catch { return String(x); } })())).join(' ') });
    const consoleObj = { log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug'), table: log('log'), dir: log('log'), trace: log('debug'), clear() {}, time() {}, timeEnd() {}, assert: (c, ...a) => { if (!c) log('error')('Asserção falhou:', ...a); } };

    const testFn = (name, fn) => {
      const entry = { name: String(name), pass: true, source };
      results.push(entry);
      const fail = (e) => { entry.pass = false; entry.error = e && e.message ? e.message : String(e); };
      if (typeof fn !== 'function') return;
      try {
        if (fn.length > 0) {
          track(new Promise((res) => { try { fn((err) => { if (err) fail(err); res(); }); } catch (e) { fail(e); res(); } }));
        } else {
          const out = fn();
          if (out && typeof out.then === 'function') track(out.then(() => {}, fail));
        }
      } catch (e) { fail(e); }
    };
    testFn.skip = (name) => { results.push({ name: String(name), pass: true, skipped: true, source }); };

    const reqObj = makeRequest(input.request);
    const resObj = event === 'test' && input.response ? makeResponse(input.response) : undefined;
    let skipRequest = false, visualizer = null, nextRequest; // undefined = segue a ordem; null = encerra a iteração

    function toMonoRequest(x) {
      if (typeof x === 'string') return { method: 'GET', url: x, headers: [], body: { type: 'none', raw: '', form: [] }, auth: { type: 'none' } };
      const header = Array.isArray(x.header) ? x.header : x.header && typeof x.header === 'object' ? Object.entries(x.header).map(([key, value]) => ({ key, value })) : x.headers && typeof x.headers === 'object' ? (Array.isArray(x.headers) ? x.headers : Object.entries(x.headers).map(([key, value]) => ({ key, value }))) : [];
      const b = x.body || {};
      let body = { type: 'none', raw: '', form: [] };
      if (b.mode === 'urlencoded' || b.mode === 'formdata') body = { type: 'form', raw: '', form: (b[b.mode] || []).map((f) => ({ key: f.key, value: persistable(f.value), enabled: !f.disabled })) };
      else if (b.mode === 'raw' || b.raw !== undefined) { const raw = typeof b.raw === 'string' ? b.raw : JSON.stringify(b.raw); body = { type: /^\s*[[{]/.test(raw) ? 'json' : 'text', raw, form: [] }; }
      const url = typeof x.url === 'string' ? x.url : x.url instanceof Url ? x.url.toString() : x.url && x.url.raw ? x.url.raw : String(x.url || '');
      return { method: String(x.method || 'GET').toUpperCase(), url, headers: header.map((h) => ({ key: h.key, value: persistable(h.value), enabled: !h.disabled })), body, auth: { type: 'none' } };
    }
    function sendRequest(x, cb) {
      const mreq = toMonoRequest(x);
      const from = source;
      const p = (async () => {
        if (!hooks.send) throw new Error('pm.sendRequest não está disponível aqui.');
        const r = await hooks.send(mreq, merged());
        logs.push({ level: 'net', source: from, text: `${mreq.method} ${replaceIn(mreq.url)} → ${r.ok ? `${r.status} · ${r.time} ms` : 'erro: ' + r.error}` });
        if (!r.ok) throw new Error(r.error || 'Falha na requisição');
        return makeResponse(r);
      })();
      const prevSource = source;
      const out = p.then((res) => { if (cb) { source = from; try { cb(null, res); } catch (e) { logs.push({ level: 'error', source: from, text: 'Erro no callback do sendRequest: ' + e.message }); } source = prevSource; } return res; },
        (err) => { if (cb) { source = from; try { cb(err, null); } catch (e) { logs.push({ level: 'error', source: from, text: 'Erro no callback do sendRequest: ' + e.message }); } source = prevSource; return null; } throw err; });
      out.catch(() => {});
      track(out);
      return out;
    }

    const pm = {
      info: { eventName: event, requestName: (input.info && input.info.requestName) || reqObj.name, requestId: (input.info && input.info.requestId) || reqObj.id, iteration: input.iteration || 0, iterationCount: input.iterationCount || 1 },
      environment: scope('environment'), globals: scope('globals'), collectionVariables: scope('collection'),
      variables: {
        get: resolve, has: (k) => resolve(k) !== undefined,
        set: (k, v) => { local[k] = v; }, unset: (k) => { delete local[k]; },
        replaceIn, toObject: merged, toJSON: merged,
      },
      iterationData: { get: (k) => dataRow[k], has: (k) => hasOwn(dataRow, k), toObject: () => ({ ...dataRow }), toJSON: () => ({ ...dataRow }), unset: (k) => { delete dataRow[k]; }, set: (k, v) => { dataRow[k] = v; }, replaceIn },
      request: reqObj,
      response: resObj,
      cookies: makeCookies(resObj ? parseCookies(input.response.headers) : []),
      test: testFn,
      expect,
      sendRequest,
      visualizer: {
        set: (template, data) => { visualizer = { html: renderTemplate(String(template || ''), data || {}), source }; },
        clear: () => { visualizer = null; },
      },
      execution: {
        skipRequest: () => { if (event !== 'prerequest') throw new Error('pm.execution.skipRequest() só funciona em "Antes da requisição".'); skipRequest = true; },
        setNextRequest: (name) => { nextRequest = name == null ? null : String(name); },
        location: [],
      },
      require: (n) => requireFn(n),
      // Assina XML com o certificado digital configurado para o host da requisição (Configurações › Certificados).
      xml: {
        sign: (xml, tag = '', opts = {}) => {
          if (!hooks.sign) return Promise.reject(new Error('pm.xml.sign não está disponível aqui.'));
          const from = source;
          const p = hooks.sign({ xml: String(xml ?? ''), tag, alg: opts.alg || 'sha1', minify: opts.minify !== false, url: reqObj.url.toString(), vars: merged() })
            .then((r) => { if (!r.ok) throw new Error(r.error); logs.push({ level: 'info', source: from, text: `XML assinado${tag ? ` (<${tag}>)` : ''} com ${r.cert || 'o certificado'}` }); return r.xml; });
          p.catch(() => {});
          track(p);
          return p;
        },
      },
    };

    // Timers rastreados: o script só termina quando todos dispararem (ou forem cancelados).
    const timers = new Map();
    const sTimeout = (fn, ms, ...a) => {
      let done;
      const p = new Promise((r) => { done = r; });
      const id = setTimeout(() => { timers.delete(id); try { fn(...a); } catch (e) { logs.push({ level: 'error', source, text: 'Erro no setTimeout: ' + e.message }); } done(); }, ms);
      timers.set(id, done); track(p);
      return id;
    };
    const sClear = (id) => { const d = timers.get(id); if (d) { clearTimeout(id); timers.delete(id); d(); } };
    const sInterval = (fn, ms, ...a) => {
      let done;
      const p = new Promise((r) => { done = r; });
      const id = setInterval(() => { try { fn(...a); } catch (e) { logs.push({ level: 'error', source, text: 'Erro no setInterval: ' + e.message }); } }, ms);
      timers.set(id, () => { clearInterval(id); done(); }); track(p);
      return id;
    };
    const sClearInterval = (id) => { const d = timers.get(id); if (d) { timers.delete(id); d(); } };

    function requireFn(name) {
      if (name === 'chai') return { expect, assert: (c, m) => { if (!c) throw new AssertionError(m || 'asserção falhou'); } };
      if (name === 'uuid') return { v4: uuid };
      throw new Error(`O pacote "${name}" não está disponível no Mono. Disponíveis: chai, uuid. Use crypto, atob/btoa, JSON e Date nativos.`);
    }

    // Compatibilidade: API antiga do Postman (postman.*, tests[], responseBody) e a do Mono (test, expect, res, log, env).
    const legacyTests = {};
    const postman = {
      setEnvironmentVariable: (k, v) => pm.environment.set(k, v), getEnvironmentVariable: (k) => pm.environment.get(k), clearEnvironmentVariable: (k) => pm.environment.unset(k),
      setGlobalVariable: (k, v) => pm.globals.set(k, v), getGlobalVariable: (k) => pm.globals.get(k), clearGlobalVariable: (k) => pm.globals.unset(k),
      setNextRequest: (n) => pm.execution.setNextRequest(n),
      getResponseHeader: (k) => (resObj ? resObj.headers.get(k) : undefined),
    };
    const monoRes = resObj ? {
      status: resObj.code, time: resObj.responseTime, size: resObj.responseSize, body: resObj.text(),
      headers: Object.fromEntries(resObj.headers.members.map((x) => [x.key.toLowerCase(), x.value])),
      json: () => resObj.json(),
    } : undefined;

    const names = ['pm', 'postman', 'console', 'require', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      'tests', 'responseBody', 'responseCode', 'responseTime', 'responseHeaders', 'environment', 'globals', 'request', 'xml2Json',
      'test', 'expect', 'res', 'log', 'env'];
    const values = () => [pm, postman, consoleObj, requireFn, sTimeout, sClear, sInterval, sClearInterval,
      legacyTests, resObj ? resObj.text() : undefined, resObj ? { code: resObj.code, name: resObj.status, detail: resObj.status } : undefined,
      resObj ? resObj.responseTime : undefined, resObj ? resObj.headers.toObject() : undefined, { ...scopes.environment }, { ...scopes.globals },
      { url: reqObj.url.toString(), method: reqObj.method, headers: reqObj.headers.toObject(), data: reqObj.body.toString() },
      () => { throw new Error('xml2Json não está disponível no Mono.'); },
      testFn, expect, monoRes, consoleObj.log, { set: (k, v) => pm.environment.set(k, v), get: (k) => pm.environment.get(k) }];

    let error = null;
    for (const s of input.scripts || []) {
      if (!s || !String(s.code || '').trim()) continue;
      source = s.source || '';
      try {
        const fn = new AsyncFunction(...names, '"use strict";\n' + s.code);
        await fn(...values());
        while (pending.size) await Promise.race([...pending]);
        for (const [k, v] of Object.entries(legacyTests)) results.push({ name: k, pass: !!v, source });
        for (const k of Object.keys(legacyTests)) delete legacyTests[k];
      } catch (e) {
        const info = errorInfo(e);
        error = { ...info, source };
        while (pending.size) await Promise.race([...pending]);
        break;
      }
    }

    return {
      event, results, logs, error, skipRequest, visualizer, local, nextRequest: nextRequest === undefined ? undefined : nextRequest,
      request: serializeRequest(reqObj, input.request || {}),
      changes,
    };
  }

  return { run, replaceVars, dynamicVar, DYNAMIC_NAMES: Object.keys(DYNAMIC), validateSchema, renderTemplate, expect, PropertyList, Url, makeResponse, makeRequest, serializeRequest, AssertionError };
});
