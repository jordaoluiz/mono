// Respostas guardadas por requisição (para comparar "hoje × ontem" e "homologação × produção").
// Um arquivo por requisição na pasta de dados do usuário, cifrado pelo Windows quando possível
// (respostas costumam ter dados de clientes e tokens). Só neste computador — não sincroniza.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEEP = 20;              // respostas por requisição (as fixadas não contam)
const MAX_FILES = 600;        // requisições com respostas guardadas
const MAX_BODY = 1024 * 1024; // 1 MB por corpo

function createRespLog(dir, cipher = null) {
  const can = () => cipher && cipher.available();
  const fileOf = (key) => path.join(dir, crypto.createHash('sha1').update(String(key)).digest('hex') + '.json');
  const read = (key) => {
    try {
      const raw = fs.readFileSync(fileOf(key), 'utf8');
      const doc = raw.startsWith('{') ? JSON.parse(raw) : JSON.parse(cipher.decrypt(raw));
      return doc && doc.key === String(key) && Array.isArray(doc.entries) ? doc : { key: String(key), entries: [] };
    } catch { return { key: String(key), entries: [] }; }
  };
  const write = (doc) => {
    fs.mkdirSync(dir, { recursive: true });
    const f = fileOf(doc.key);
    if (!doc.entries.length) { try { fs.unlinkSync(f); } catch { /* já não existe */ } return; }
    const json = JSON.stringify(doc);
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, can() ? cipher.encrypt(json) : json);
    fs.renameSync(tmp, f);
  };
  const meta = (e) => { const { body, headers, ...m } = e; return { ...m, hasBody: body != null }; };
  function prune() {
    let files;
    try { files = fs.readdirSync(dir).filter((f) => /^[0-9a-f]{40}\.json$/.test(f)); } catch { return; }
    if (files.length <= MAX_FILES) return;
    const withTime = files.map((f) => { try { return [f, fs.statSync(path.join(dir, f)).mtimeMs]; } catch { return [f, 0]; } }).sort((a, b) => a[1] - b[1]);
    for (const [f] of withTime.slice(0, files.length - MAX_FILES)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignora */ } }
  }

  return {
    add(key, e) {
      if (!key) throw new Error('Chave inválida.');
      const doc = read(key);
      let body = e.body == null ? null : String(e.body);
      const truncated = body != null && body.length > MAX_BODY;
      if (truncated) body = body.slice(0, MAX_BODY);
      const entry = {
        id: 'r' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'), at: Date.now(),
        envId: e.envId || '', envName: String(e.envName || '').slice(0, 120), method: String(e.method || '').slice(0, 20), url: String(e.url || '').slice(0, 2000),
        status: e.status ?? null, statusText: String(e.statusText || '').slice(0, 120), time: e.time ?? null, size: e.size ?? null,
        contentType: String(e.contentType || '').slice(0, 200), headers: (e.headers || []).slice(0, 200).map((x) => ({ key: String(x.key), value: String(x.value) })),
        body, truncated, binary: e.body == null && e.size > 0, label: String(e.label || '').slice(0, 120), pinned: false,
      };
      doc.entries.unshift(entry);
      let free = 0;
      doc.entries = doc.entries.filter((x) => x.pinned || ++free <= KEEP);
      write(doc); prune();
      return { entry: meta(entry), list: doc.entries.map(meta) };
    },
    list(key) { return read(key).entries.map(meta); },
    get(key, ids) { const want = new Set(ids || []); return read(key).entries.filter((x) => want.has(x.id)); },
    update(key, id, patch) {
      const doc = read(key);
      const e = doc.entries.find((x) => x.id === id);
      if (!e) throw new Error('Resposta não encontrada.');
      if ('pinned' in patch) e.pinned = !!patch.pinned;
      if ('label' in patch) e.label = String(patch.label || '').slice(0, 120);
      write(doc);
      return doc.entries.map(meta);
    },
    remove(key, id) { const doc = read(key); doc.entries = doc.entries.filter((x) => x.id !== id); write(doc); return doc.entries.map(meta); },
    clear(key) { const doc = read(key); doc.entries = doc.entries.filter((x) => x.pinned); write(doc); return doc.entries.map(meta); },
    rename(from, to) { // requisição salva depois de enviada como rascunho: as respostas vão junto
      const a = read(from); if (!a.entries.length || from === to) return;
      const b = read(to);
      b.entries = [...a.entries, ...b.entries].sort((x, y) => y.at - x.at);
      write(b); a.entries = []; write(a);
    },
    KEEP, MAX_BODY,
  };
}

module.exports = { createRespLog };
