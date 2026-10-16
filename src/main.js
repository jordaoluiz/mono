'use strict';
const { app, BrowserWindow, ipcMain, clipboard, shell, safeStorage, protocol, nativeTheme, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('./http');
const { createStore } = require('./store');
const network = require('./network');
const certs = require('./certs');
const xmlsign = require('./xmlsign');
const updater = require('./updater');
const { createCloud } = require('./cloud');

// Arquivos que a interface pode mandar numa requisição (form-data, binário, certificados):
// só os que o usuário escolheu na janela do sistema. Coleções importadas não conseguem apontar para outros arquivos.
let allowedFiles = null;
const allowedFile = () => path.join(app.getPath('userData'), 'allowed-files.json');
function allowed() {
  if (!allowedFiles) { try { allowedFiles = new Set(JSON.parse(fs.readFileSync(allowedFile(), 'utf8'))); } catch { allowedFiles = new Set(); } }
  return allowedFiles;
}
function allowFile(p) {
  const set = allowed();
  set.add(path.resolve(p));
  try { fs.writeFileSync(allowedFile(), JSON.stringify([...set].slice(-500))); } catch { /* best effort */ }
}
function readAllowed(p) {
  const full = path.resolve(String(p || ''));
  if (!allowed().has(full)) throw new Error(`O arquivo "${path.basename(full)}" precisa ser escolhido de novo neste computador (botão "Escolher arquivo").`);
  if (!fs.existsSync(full)) throw new Error(`Arquivo não encontrado: ${full}`);
  const st = fs.statSync(full);
  if (st.size > 200 * 1024 * 1024) throw new Error('Arquivo maior que 200 MB.');
  return fs.readFileSync(full);
}

let win;
let store;
const DEV = process.argv.includes('--dev') && !app.isPackaged;

process.on('uncaughtException', (e) => console.error('[mono] erro no processo principal:', e));
console.log(`[mono] iniciando · Electron ${process.versions.electron} · ${process.platform}`);

// Preview de respostas HTML: servido por um protocolo próprio com CSP que bloqueia scripts.
protocol.registerSchemesAsPrivileged([{ scheme: 'mono-preview', privileges: { standard: true, secure: true } }]);
const previews = new Map();
const PREVIEW_CSP = "default-src * data: blob:; style-src * data: 'unsafe-inline'; img-src * data: blob:; font-src * data:; script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'";
function createPreview(html, baseUrl) {
  const id = Math.random().toString(36).slice(2, 12);
  const base = baseUrl ? `<base href="${String(baseUrl).replace(/"/g, '&quot;')}">` : '';
  const doc = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + base) : base + html;
  previews.set(id, doc);
  while (previews.size > 20) previews.delete(previews.keys().next().value);
  return `mono-preview://${id}/`;
}

const THEMES = {
  dark: { bg: '#000000', fg: '#f5f5f5' },
  light: { bg: '#ffffff', fg: '#0a0a0a' },
  blue: { bg: '#0a1020', fg: '#e8eefb' },
};

function createWindow() {
  const theme = THEMES[store.load().theme] || THEMES.dark;
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: theme.bg,
    title: 'Mono',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    // Barra de título integrada: a topbar do app vira a área de arrastar e o
    // Windows desenha só os botões nativos (mantém Snap Layouts e duplo clique).
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: theme.bg, symbolColor: theme.fg, height: 48 },
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Diagnóstico: tudo que der errado aparece no terminal.
  const wc = win.webContents;
  wc.on('did-fail-load', (_e, code, desc, url) => console.error(`[mono] falha ao carregar ${url}: ${code} ${desc}`));
  wc.on('render-process-gone', (_e, d) => console.error(`[mono] processo da interface encerrou: ${d.reason} (código ${d.exitCode})`));
  wc.on('preload-error', (_e, file, err) => console.error(`[mono] erro no preload ${file}:`, err));
  wc.on('console-message', (_e, level, message, line, source) => { if (level >= 2) console.error(`[mono] interface: ${message} (${source}:${line})`); });
  wc.on('did-finish-load', () => console.log('[mono] interface carregada'));
  if (process.argv.includes('--devtools')) wc.openDevTools({ mode: 'detach' });

  // Links externos abrem no navegador; nada de novas janelas dentro do app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// Só aceita mensagens da nossa própria janela.
function guard(handler) {
  return (event, ...args) => {
    if (!win || event.sender.id !== win.webContents.id) throw new Error('Remetente não autorizado');
    return handler(...args);
  };
}

app.whenReady().then(() => {
  store = createStore(app.getPath('userData'), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
    decrypt: (b) => safeStorage.decryptString(Buffer.from(b, 'base64')),
  });
  ipcMain.handle('store:load', guard(() => store.load()));
  ipcMain.handle('store:save', guard((data) => store.save(data)));
  ipcMain.handle('http:send', guard((req, vars) => {
    const r = network.get().request;
    return http.send(req, vars, { transport: network.transport, timeoutMs: Number(r.timeoutMs) || 30000, followRedirects: r.followRedirects !== false, readFile: readAllowed });
  }));
  // Arquivos: exportar/importar coleções e visão geral.
  ipcMain.handle('file:save', guard(async ({ name, content, filters }) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), String(name || 'export.json')), filters: filters || [] });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, String(content), 'utf8');
    return { ok: true, path: r.filePath };
  }));
  ipcMain.handle('file:open', guard(async ({ filters } = {}) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: filters || [] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    const file = r.filePaths[0];
    if (fs.statSync(file).size > 30 * 1024 * 1024) return { ok: false, error: 'Arquivo maior que 30 MB.' };
    return { ok: true, name: path.basename(file), path: file, content: fs.readFileSync(file, 'utf8') };
  }));
  // Escolher arquivo para enviar (form-data/binário) ou certificado .pfx: entra na lista de permitidos.
  ipcMain.handle('file:pick', guard(async ({ filters, title } = {}) => {
    const r = await dialog.showOpenDialog(win, { title, properties: ['openFile'], filters: filters || [] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    const file = r.filePaths[0];
    allowFile(file);
    return { ok: true, path: file, name: path.basename(file), size: fs.statSync(file).size };
  }));
  // Assinatura XML (XMLDSig) com o certificado A1 cadastrado.
  ipcMain.handle('xml:sign', guard(({ xml, tag, certPath, passphrase, alg, minify }) => {
    try { return { ok: true, xml: xmlsign.sign(String(xml || ''), { tag: tag || '', pfx: readAllowed(certPath), passphrase, alg, minify: minify !== false }) }; }
    catch (e) { return { ok: false, error: e.message }; }
  }));
  ipcMain.handle('xml:verify', guard((xml) => {
    try { return xmlsign.verify(String(xml || '')); } catch (e) { return { ok: false, error: e.message, results: [] }; }
  }));
  ipcMain.handle('cert:inspect', guard(({ path: p, passphrase }) => {
    try { return certs.inspect(readAllowed(p), passphrase); } catch (e) { return { ok: false, error: e.message }; }
  }));
  ipcMain.handle('file:reveal', guard((p) => { shell.showItemInFolder(String(p)); return true; }));
  // IA opcional (Anthropic): usada para resumir APIs e entender documentação fora dos formatos conhecidos.
  // IA: Claude (Anthropic) ou ChatGPT (OpenAI). Sai pela mesma rede/proxy do app.
  ipcMain.handle('ai:complete', guard(async ({ provider, apiKey, model, system, prompt, maxTokens }) => {
    const openai = provider === 'openai';
    if (!apiKey) return { ok: false, error: `Configure a chave ${openai ? 'da OpenAI' : 'da Anthropic'} em Configurações › IA.` };
    const json = (o) => ({ type: 'json', raw: JSON.stringify(o) });
    const req = openai
      ? {
        method: 'POST', url: 'https://api.openai.com/v1/chat/completions', params: null,
        headers: [{ key: 'Authorization', value: 'Bearer ' + apiKey, enabled: true }, { key: 'content-type', value: 'application/json', enabled: true }],
        body: json({ model: model || 'gpt-5-mini', max_completion_tokens: maxTokens || 4000, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
        auth: { type: 'none' },
      }
      : {
        method: 'POST', url: 'https://api.anthropic.com/v1/messages', params: null,
        headers: [{ key: 'x-api-key', value: apiKey, enabled: true }, { key: 'anthropic-version', value: '2023-06-01', enabled: true }, { key: 'content-type', value: 'application/json', enabled: true }],
        body: json({ model: model || 'claude-sonnet-5-5', max_tokens: maxTokens || 4000, system, messages: [{ role: 'user', content: prompt }] }),
        auth: { type: 'none' },
      };
    const res = await http.send(req, {}, { transport: network.transport, timeoutMs: 120000 });
    if (!res.ok) return { ok: false, error: res.error };
    let j; try { j = JSON.parse(res.body || '{}'); } catch { return { ok: false, error: `Resposta inesperada da IA (${res.status}).` }; }
    if (res.status >= 400) return { ok: false, error: (j.error && j.error.message) || `Erro ${res.status} da IA.` };
    const text = openai ? ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '')
      : (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    return { ok: true, text };
  }));
  ipcMain.handle('settings:apply', guard((settings) => network.apply(settings)));
  ipcMain.handle('proxy:resolve', guard((url) => network.resolveProxy(String(url))));
  ipcMain.handle('http:curl', guard((req, vars) => {
    try { return { ok: true, curl: http.toCurl(req, vars) }; } catch (e) { return { ok: false, error: e.message }; }
  }));
  ipcMain.handle('preview:create', guard((html, baseUrl) => createPreview(String(html ?? ''), baseUrl)));
  ipcMain.handle('window:theme', guard((name) => {
    const t = THEMES[name] || THEMES.dark;
    win.setBackgroundColor(t.bg);
    if (process.platform !== 'darwin') win.setTitleBarOverlay({ color: t.bg, symbolColor: t.fg, height: 48 });
    nativeTheme.themeSource = name === 'light' ? 'light' : 'dark';
    return true;
  }));
  // Servidor do Mono (workspaces compartilhados). O app nunca fala direto com o banco.
  const cloud = createCloud({
    fetchImpl: (url, opts) => network.fetch(url, opts),
    emit: (type, payload) => { if (win && !win.isDestroyed()) win.webContents.send('cloud:' + type, payload); },
  });
  ipcMain.handle('cloud:call', guard((opts) => cloud.call(opts)));
  ipcMain.handle('cloud:connect', guard((opts) => { cloud.connect(opts); return true; }));
  ipcMain.handle('cloud:disconnect', guard(() => { cloud.disconnect(); return true; }));
  ipcMain.handle('crypto:available', guard(() => safeStorage.isEncryptionAvailable()));
  ipcMain.handle('clipboard:write', guard((text) => { clipboard.writeText(String(text)); return true; }));
  protocol.handle('mono-preview', (req) => {
    const id = new URL(req.url).hostname;
    const html = previews.get(id);
    return new Response(html ?? '<p>Preview expirado. Envie a requisição de novo.</p>', {
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PREVIEW_CSP },
    });
  });
  network.setFileReader(readAllowed);
  network.apply(store.load().settings).catch((e) => console.error('[mono] proxy:', e.message));
  createWindow();
  updater.init(() => win, guard);
  if (DEV) startHotReload();
  console.log('[mono] janela criada');
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// ---------- Hot reload (só em desenvolvimento: npm run dev) ----------
// Interface (src/renderer) → recarrega a janela. Processo principal/preload → reinicia o app.
function startHotReload() {
  const fs = require('fs');
  const src = __dirname;
  const timers = {};
  const debounce = (key, fn, ms = 120) => { clearTimeout(timers[key]); timers[key] = setTimeout(fn, ms); };
  console.log('[mono] hot reload ligado — observando', src);
  fs.watch(src, { recursive: true }, (_event, file) => {
    if (!file || /(^|[\\/])\.|~$|\.tmp$/.test(file)) return;
    const name = file.replace(/\\/g, '/');
    if (name.startsWith('renderer/')) {
      debounce('renderer', () => {
        if (!win || win.isDestroyed()) return;
        if (name.endsWith('.css')) {
          // CSS: troca a folha de estilo sem recarregar a página (mantém respostas e abas).
          win.webContents.executeJavaScript(`document.querySelectorAll('link[rel=stylesheet]').forEach(l => { l.href = l.href.split('?')[0] + '?v=' + Date.now(); })`).catch(() => {});
          console.log('[mono] CSS atualizado:', name);
        } else {
          win.webContents.reloadIgnoringCache();
          console.log('[mono] interface recarregada:', name);
        }
      });
    } else if (/\.js$/.test(name)) {
      debounce('main', () => {
        console.log('[mono] processo principal mudou (' + name + ') — reiniciando…');
        app.relaunch();
        app.exit(0);
      }, 250);
    }
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
