// Inicia o servidor do Mono. Configuração por variáveis de ambiente (veja .env.example):
//   MONGODB_URI  string de conexão do Atlas (obrigatória em produção)
//   MONGODB_DB   nome do banco (padrão: mono)
//   PORT         porta HTTP (padrão: 8787; a hospedagem costuma definir sozinha)
//   MONO_DB=memory  roda sem banco, só para testar (os dados somem ao reiniciar)
'use strict';
const { createApp } = require('./app');

(async () => {
  let db;
  if (process.env.MONO_DB === 'memory' || !process.env.MONGODB_URI) {
    if (process.env.NODE_ENV === 'production' && process.env.MONO_DB !== 'memory') {
      console.error('[mono-server] MONGODB_URI não definida.'); process.exit(1);
    }
    db = require('./db-memory').createMemoryDb();
  } else {
    db = require('./db-mongo').createMongoDb(process.env.MONGODB_URI, process.env.MONGODB_DB || 'mono');
  }
  await db.init();
  const server = createApp({ db, log: (m) => console.log('[mono-server]', m) });
  const port = Number(process.env.PORT) || 8787;
  server.listen(port, () => console.log(`[mono-server] ouvindo na porta ${port} · banco: ${db.kind}`));
  const stop = () => { server.closeStreams(); server.close(() => db.close().finally(() => process.exit(0))); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
})().catch((e) => {
  const msg = String((e && e.message) || e);
  console.error('[mono-server] não iniciou:', msg);
  if (/alert internal error|alert number 80|Server selection timed out|ECONNREFUSED|ETIMEDOUT/i.test(msg)) {
    console.error('[mono-server] O MongoDB Atlas recusou a conexão. Em Network Access, libere o IP deste servidor (no Railway: 0.0.0.0/0).');
  } else if (/bad auth|Authentication failed/i.test(msg)) {
    console.error('[mono-server] Usuário ou senha do MongoDB incorretos na MONGODB_URI.');
  }
  process.exit(1);
});
