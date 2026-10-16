// Coleção ↔ arquivos numa pasta (para versionar no Git junto com o código).
//   mono.collection.json          → dados da coleção: nome, auth, variáveis, scripts, pastas e a ordem
//   <pasta>/<requisição>.req.json → uma requisição por arquivo (diffs pequenos e legíveis no Git)
// JSON com 2 espaços e quebra de linha no fim, sempre na mesma ordem: o Git só mostra o que mudou de verdade.
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.MonoGitfs = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const META = 'mono.collection.json';
  const LOCAL = ['open', 'gitDir', 'gitPrint', 'overviewMeta', 'importReport'];
  const json = (o) => JSON.stringify(o, null, 2) + '\n';
  const slug = (s) => String(s || 'sem-nome').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'sem-nome';
  const hideSecrets = (vars) => (vars || []).map((v) => (v && v.secret ? { ...v, value: '' } : v)).map((v) => { if (!v) return v; const o = { ...v }; for (const k of Object.keys(o)) if (k.startsWith('_v') || k === 'vault') delete o[k]; return o; });
  const pick = (o, drop) => { const c = JSON.parse(JSON.stringify(o || {})); for (const k of drop) delete c[k]; return c; };

  function toFiles(col) {
    const folders = col.folders || [];
    const byId = new Map(folders.map((f) => [f.id, f]));
    // nome de diretório único por pasta, respeitando a hierarquia
    const dirOf = new Map();
    const used = new Map();
    const unique = (parent, name) => { const key = parent + '/' + name; const n = (used.get(key) || 0) + 1; used.set(key, n); return n === 1 ? name : `${name}-${n}`; };
    const dirFor = (fid) => {
      if (!fid || !byId.has(fid)) return '';
      if (dirOf.has(fid)) return dirOf.get(fid);
      const f = byId.get(fid);
      const parent = dirFor(f.parentId || null);
      const d = (parent ? parent + '/' : '') + unique(parent, slug(f.name));
      dirOf.set(fid, d);
      return d;
    };
    folders.forEach((f) => dirFor(f.id));
    const files = [];
    const order = (col.requests || []).map((r) => r.id); // ordem da árvore
    const taken = new Set();
    for (const r of col.requests || []) {
      const dir = dirFor(r.folderId || null);
      let base = (dir ? dir + '/' : '') + slug(r.name);
      let p = base + '.req.json', i = 2;
      while (taken.has(p)) p = `${base}-${i++}.req.json`;
      taken.add(p);
      files.push({ path: p, content: json(pick(r, [])) });
    }
    const meta = {
      format: 'mono-collection', version: 1,
      ...pick(col, ['requests', 'folders', ...LOCAL]),
      variables: hideSecrets(col.variables),
      folders: folders.map((f) => pick(f, ['open'])),
      order,
    };
    files.unshift({ path: META, content: json(meta) });
    return files;
  }

  // files: [{ path, content }] lidos da pasta → coleção.
  function fromFiles(files) {
    const metaFile = files.find((f) => f.path === META);
    if (!metaFile) throw new Error(`A pasta não tem ${META}.`);
    let meta;
    try { meta = JSON.parse(metaFile.content); } catch (e) { throw new Error(`${META} não é um JSON válido: ${e.message}`); }
    if (meta.format !== 'mono-collection') throw new Error(`${META} não é uma coleção do Mono.`);
    const reqs = [];
    for (const f of files) {
      if (!/\.req\.json$/.test(f.path)) continue;
      try { const r = JSON.parse(f.content); if (r && r.id) reqs.push(r); }
      catch (e) { throw new Error(`${f.path} não é um JSON válido (conflito de merge?): ${e.message}`); }
    }
    const pos = new Map();
    (Array.isArray(meta.order) ? meta.order : []).forEach((id, i) => pos.set(id, i));
    reqs.sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : 1e9) - (pos.has(b.id) ? pos.get(b.id) : 1e9) || String(a.name).localeCompare(String(b.name)));
    const { format, version, order, ...rest } = meta;
    return { ...rest, folders: meta.folders || [], requests: reqs };
  }

  // Impressão do que vai para os arquivos (para saber se precisa regravar).
  const fingerprint = (col) => toFiles(col).map((f) => f.path + '\u0000' + f.content).join('\u0001');

  return { META, toFiles, fromFiles, fingerprint, slug, LOCAL };
});
