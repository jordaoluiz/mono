// Sandbox dos scripts (Antes da requisição / Após a resposta): roda num Web Worker, sem DOM e sem acesso à ponte do app.
// A interface encerra o worker se ele passar do tempo limite, então loops infinitos não travam nada.
// pm.sendRequest pede à interface para enviar (pela mesma rede/proxy do app) e espera a resposta.
'use strict';
importScripts('../shared/sandbox.js');

let seq = 0;
const waiting = new Map();

self.onmessage = async ({ data }) => {
  if (data.type === 'sendResult') {
    const done = waiting.get(data.rid);
    if (done) { waiting.delete(data.rid); done(data.res); }
    return;
  }
  if (data.type !== 'run') return;
  const hooks = {
    send: (req, vars) => new Promise((resolve) => {
      const rid = ++seq;
      waiting.set(rid, resolve);
      self.postMessage({ type: 'send', id: data.id, rid, req, vars });
    }),
  };
  hooks.sign = (opts) => new Promise((resolve) => {
    const rid = ++seq;
    waiting.set(rid, resolve);
    self.postMessage({ type: 'sign', id: data.id, rid, opts });
  });
  let out;
  try { out = await self.MonoSandbox.run(data.input, hooks); }
  catch (e) { out = { results: [], logs: [], error: { message: e && e.message ? e.message : String(e) } }; }
  self.postMessage({ type: 'done', id: data.id, ...JSON.parse(JSON.stringify(out)) });
};
