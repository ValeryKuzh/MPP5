# Единый образ для backend-сервисов (подграфы, воркеры, шлюз).
# Конкретный процесс выбирается командой в docker-compose.yml.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/common/package.json packages/common/
COPY services/repos/package.json services/repos/
COPY services/news/package.json services/news/
COPY services/packages/package.json services/packages/
COPY gateway/package.json gateway/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages packages
COPY services services
COPY gateway gateway
USER node
CMD ["node", "-r", "@devpulse/common/tracing", "gateway/src/index.js"]
