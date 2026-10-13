'use strict';
// Ponte mínima e explícita: a interface só enxerga estas funções.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mono', {
  load: () => ipcRenderer.invoke('store:load'),
  save: (data) => ipcRenderer.invoke('store:save', data),
  send: (req, vars) => ipcRenderer.invoke('http:send', req, vars),
  curl: (req, vars) => ipcRenderer.invoke('http:curl', req, vars),
  preview: (html, baseUrl) => ipcRenderer.invoke('preview:create', html, baseUrl),
  setTheme: (name) => ipcRenderer.invoke('window:theme', name),
  applySettings: (settings) => ipcRenderer.invoke('settings:apply', settings),
  resolveProxy: (url) => ipcRenderer.invoke('proxy:resolve', url),
  saveFile: (opts) => ipcRenderer.invoke('file:save', opts),
  openFile: (opts) => ipcRenderer.invoke('file:open', opts),
  revealFile: (p) => ipcRenderer.invoke('file:reveal', p),
  pickFile: (opts) => ipcRenderer.invoke('file:pick', opts),
  inspectCert: (opts) => ipcRenderer.invoke('cert:inspect', opts),
  signXml: (opts) => ipcRenderer.invoke('xml:sign', opts),
  verifyXml: (xml) => ipcRenderer.invoke('xml:verify', xml),
  ai: (opts) => ipcRenderer.invoke('ai:complete', opts),
  secureStorage: () => ipcRenderer.invoke('crypto:available'),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: (cb) => { const fn = (_e, s) => cb(s); ipcRenderer.on('update:status', fn); return () => ipcRenderer.removeListener('update:status', fn); },
  platform: process.platform,
});
