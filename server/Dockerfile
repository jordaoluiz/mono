# Imagem do servidor do Mono (Railway, AWS, qualquer lugar com Docker). Contexto do build: raiz do repositório.
FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/
RUN npm install --prefix server --omit=dev --no-audit --no-fund
COPY server/ server/
COPY src/shared/sync.js src/shared/sync.js
ENV NODE_ENV=production
EXPOSE 8787
USER node
CMD ["node", "server/index.js"]
