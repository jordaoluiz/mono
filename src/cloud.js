// Conexão com o servidor do Mono (contas e workspaces compartilhados), no processo principal.
// Usa a mesma sessão de rede das requisições — respeita o proxy configurado no app.
// `fetchImpl` é injetado: no app é session.fetch do Electron; nos testes, o fetch do Node.
'use strict';

const BACKOFF = [1000, 2000, 5000, 10000, 20000, 30000];
const STALL_MS = 70000; // o servidor manda um "ping" a cada 25 s

function baseOf(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { throw new Error('Endereço do servidor inválido.'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('O servidor precisa ser http:// ou https://.');
  return u.origin + u.pathname.replace(/\/+$/, '');
}

function createCloud({ fetchImpl, emit }) {
  let conn = null; // { ctrl, stopped }

  async function call({ url, token, method = 'GET', path, body } = {}) {
    try {
      if (!/^\/(v1\/[\w\-/.%]*|health)(\?.*)?$/.test(String(path || ''))) throw new Error('Caminho inválido.');
      const base = baseOf(url);
      const headers = { accept: 'application/json' };
      if (token) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetchImpl(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* resposta não-JSON */ }
      if (!res.ok) return { ok: false, status: res.status, error: (json && json.error) || `O servidor respondeu ${res.status}.` };
      return { ok: true, status: res.status, data: json };
    } catch (e) {
      const msg = e && e.name === 'TimeoutError' ? 'o servidor demorou demais' : (e && e.message) || String(e);
      return { ok: false, status: 0, error: `Sem conexão com o servidor do Mono (${msg}).` };
    }
  }

  function disconnect() {
    if (conn) { conn.stopped = true; conn.ctrl?.abort(); conn = null; }
  }

  // Fica conectado ao fluxo de eventos e reconecta sozinho. Estados: connecting, online, offline, unauthorized.
  function connect({ url, token, clientId }) {
    disconnect();
    let base;
    try { base = baseOf(url); } catch (e) { emit('state', { state: 'offline', error: e.message }); return; }
    const me = { stopped: false, ctrl: null };
    conn = me;
    (async () => {
      let attempt = 0;
      while (!me.stopped) {
        emit('state', { state: 'connecting' });
        me.ctrl = new AbortController();
        let stall;
        const kick = () => { clearTimeout(stall); stall = setTimeout(() => me.ctrl.abort(), STALL_MS); };
        try {
          kick();
          const res = await fetchImpl(`${base}/v1/events?clientId=${encodeURIComponent(clientId || '')}`, {
            headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream', 'cache-control': 'no-cache' }, signal: me.ctrl.signal,
          });
          if (res.status === 401) { clearTimeout(stall); emit('state', { state: 'unauthorized' }); me.stopped = true; break; }
          if (!res.ok || !res.body) throw new Error(`O servidor respondeu ${res.status}.`);
          attempt = 0;
          emit('state', { state: 'online' });
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            kick();
            buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i); buf = buf.slice(i + 2);
              let event = 'message'; const data = [];
              for (const line of block.split('\n')) {
                if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
              }
              if (!data.length) continue;
              let payload; try { payload = JSON.parse(data.join('\n')); } catch { continue; }
              emit('event', { event, data: payload });
            }
          }
          throw new Error('conexão encerrada');
        } catch (e) {
          clearTimeout(stall);
          if (me.stopped) break;
          emit('state', { state: 'offline', error: e && e.message });
          const wait = BACKOFF[Math.min(attempt++, BACKOFF.length - 1)];
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    })();
  }

  return { call, connect, disconnect, baseOf };
}

module.exports = { createCloud };
