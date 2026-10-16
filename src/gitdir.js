// Pastas de coleções (Git): gravar/ler os arquivos de uma coleção e avisar quando mudam por fora (git pull).
// Só mexe em pastas que a pessoa escolheu na janela do sistema, e só em arquivos do Mono (*.req.json e mono.collection.json).
'use strict';
const fs = require('fs');
const path = require('path');

const MANAGED = (name) => name === 'mono.collection.json' || name.endsWith('.req.json');
const MAX_FILES = 5000, MAX_BYTES = 50 * 1024 * 1024;

function createGitDir({ isAllowed, onChange = () => {} }) {
  const watchers = new Map(); // dir → { w, quietUntil, timer }
  const check = (dir) => {
    const full = path.resolve(String(dir || ''));
    if (!isAllowed(full)) throw new Error('Escolha a pasta de novo neste computador (Vincular a uma pasta).');
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) throw new Error(`Pasta não encontrada: ${full}`);
    return full;
  };
  const inside = (root, rel) => {
    const p = path.resolve(root, String(rel));
    if (p !== root && !p.startsWith(root + path.sep)) throw new Error(`Caminho fora da pasta: ${rel}`);
    return p;
  };
  function walk(root) {
    const out = [];
    const stack = [root];
    while (stack.length) {
      const d = stack.pop();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile() && MANAGED(e.name)) out.push(p);
        if (out.length > MAX_FILES) throw new Error('Arquivos demais na pasta.');
      }
    }
    return out;
  }
  function write(dir, files) {
    const root = check(dir);
    const keep = new Set();
    let written = 0, removed = 0;
    for (const f of files) {
      if (!MANAGED(path.basename(f.path))) throw new Error(`Arquivo não gerenciado: ${f.path}`);
      const p = inside(root, f.path);
      keep.add(p);
      const content = String(f.content);
      if (fs.existsSync(p) && fs.readFileSync(p, 'utf8') === content) continue;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf8');
      written++;
    }
    for (const p of walk(root)) if (!keep.has(p)) { fs.unlinkSync(p); removed++; }
    // remove pastas que ficaram vazias (só as que não têm mais nada)
    const prune = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && e.name !== '.git') { const p = path.join(d, e.name); prune(p); if (!fs.readdirSync(p).length) fs.rmdirSync(p); } };
    prune(root);
    const w = watchers.get(root);
    if (w) w.quietUntil = Date.now() + 1500; // as próprias gravações não contam como mudança externa
    return { written, removed };
  }
  function read(dir) {
    const root = check(dir);
    let total = 0;
    return walk(root).map((p) => {
      const content = fs.readFileSync(p, 'utf8');
      total += content.length;
      if (total > MAX_BYTES) throw new Error('Pasta grande demais.');
      return { path: path.relative(root, p).split(path.sep).join('/'), content };
    });
  }
  function watch(dir) {
    const root = check(dir);
    if (watchers.has(root)) return true;
    const entry = { quietUntil: 0, timer: null, w: null };
    try {
      entry.w = fs.watch(root, { recursive: true }, (_e, file) => {
        if (!file || /(^|[\\/])\.git([\\/]|$)/.test(file) || !MANAGED(path.basename(String(file)))) return;
        if (Date.now() < entry.quietUntil) return;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => onChange({ dir: root }), 600);
      });
    } catch { return false; }
    watchers.set(root, entry);
    return true;
  }
  function unwatch(dir) { const root = path.resolve(String(dir || '')); const e = watchers.get(root); if (e) { e.w?.close(); clearTimeout(e.timer); watchers.delete(root); } return true; }
  const closeAll = () => { for (const d of [...watchers.keys()]) unwatch(d); };
  return { write, read, watch, unwatch, closeAll };
}

module.exports = { createGitDir };
