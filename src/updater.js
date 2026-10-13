// Atualização automática (instalado pelo .exe): procura versões novas no GitHub Releases,
// baixa em segundo plano e instala ao reiniciar. Em desenvolvimento (npm run dev) fica desligada.
'use strict';
const { app, ipcMain } = require('electron');

let updater = null;
let last = { state: app.isPackaged ? 'idle' : 'dev', version: app.getVersion() };

function init(getWindow, guard) {
  const send = (s) => {
    last = { ...s, current: app.getVersion() };
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send('update:status', last);
  };
  ipcMain.handle('update:status', guard(() => ({ ...last, current: app.getVersion(), packaged: app.isPackaged })));
  ipcMain.handle('update:check', guard(async () => {
    if (!updater) return { ok: false, error: app.isPackaged ? 'Atualizador indisponível.' : 'Atualizações só funcionam no app instalado (não no npm run dev).' };
    try { await updater.checkForUpdates(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
  }));
  ipcMain.handle('update:install', guard(() => { if (updater && last.state === 'ready') { setImmediate(() => updater.quitAndInstall(false, true)); return true; } return false; }));
  if (!app.isPackaged) return;
  try { ({ autoUpdater: updater } = require('electron-updater')); } catch (e) { console.error('[mono] electron-updater ausente:', e.message); return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('checking-for-update', () => send({ state: 'checking' }));
  updater.on('update-available', (i) => send({ state: 'downloading', version: i.version, percent: 0 }));
  updater.on('update-not-available', () => send({ state: 'latest' }));
  updater.on('download-progress', (p) => send({ state: 'downloading', version: last.version, percent: Math.round(p.percent || 0) }));
  updater.on('update-downloaded', (i) => send({ state: 'ready', version: i.version, notes: typeof i.releaseNotes === 'string' ? i.releaseNotes.replace(/<[^>]+>/g, '').slice(0, 600) : '' }));
  updater.on('error', (e) => send({ state: 'error', error: String(e && e.message || e).split('\n')[0] }));
  const check = () => updater.checkForUpdates().catch(() => {});
  setTimeout(check, 8000);
  setInterval(check, 4 * 60 * 60 * 1000);
}

module.exports = { init };
