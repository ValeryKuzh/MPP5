'use strict';

const http = require('node:http');
const express = require('express');
const { ApolloServer } = require('@apollo/server');
const { ApolloServerPluginDrainHttpServer } = require('@apollo/server/plugin/drainHttpServer');
const { expressMiddleware } = require('@as-integrations/express5');
const { buildSubgraphSchema } = require('@apollo/subgraph');
const gql = require('graphql-tag');
const { Queue } = require('bullmq');

const { logger } = require('./logger');
const { httpMetricsMiddleware, apolloMetricsPlugin, metricsHandler } = require('./metrics');
const { createDb } = require('./db');
const { createCacheRedis, createBlockingRedis, createCache } = require('./redis');
const { env, int } = require('./config');
const { syncRunsSql, queueName } = require('./sync');
const { shutdownTracing } = require('./tracing');

/**
 * Запуск подграфа Apollo Federation:
 *   POST /graphql — GraphQL API (используется только шлюзом)
 *   GET  /health  — проверка БД и Redis (docker healthcheck)
 *   GET  /metrics — метрики Prometheus
 */
async function startSubgraph({ source, typeDefs, resolvers, migrations, createLoaders }) {
  const port = int('PORT', 4001);
  const db = createDb({ connectionString: env('DATABASE_URL') });
  await db.migrate(migrations + syncRunsSql);

  const cacheRedis = createCacheRedis();
  const cache = createCache(cacheRedis, { prefix: source });
  const pub = createBlockingRedis();
  const queue = new Queue(queueName(source), { connection: createBlockingRedis() });

  const app = express();
  const httpServer = http.createServer(app);
  app.disable('x-powered-by');
  app.use(httpMetricsMiddleware);

  app.get('/metrics', metricsHandler);
  app.get('/health', async (_req, res) => {
    const checks = {};
    try {
      await db.ping();
      checks.postgres = 'ok';
    } catch (err) {
      checks.postgres = err.message;
    }
    try {
      await cacheRedis.ping();
      checks.redis = 'ok';
    } catch (err) {
      checks.redis = err.message; // кэш опционален — сервис продолжает работать
    }
    const ok = checks.postgres === 'ok';
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', checks });
  });

  const server = new ApolloServer({
    schema: buildSubgraphSchema([{ typeDefs: gql(typeDefs), resolvers }]),
    introspection: true,
    includeStacktraceInErrorResponses: false,
    plugins: [ApolloServerPluginDrainHttpServer({ httpServer }), apolloMetricsPlugin()],
    formatError(formatted, error) {
      const code = formatted.extensions?.code;
      if (!code || code === 'INTERNAL_SERVER_ERROR') {
        logger.error({ err: error?.originalError || error, path: formatted.path }, 'resolver error');
        return { ...formatted, message: 'Internal server error' };
      }
      return formatted;
    },
  });
  await server.start();

  app.use(
    '/graphql',
    express.json({ limit: '1mb' }),
    expressMiddleware(server, {
      context: async () => ({
        db,
        cache,
        queue,
        redis: pub,
        source,
        loaders: createLoaders ? createLoaders(db) : {},
      }),
    }),
  );

  await new Promise((resolve) => httpServer.listen(port, resolve));
  logger.info({ port }, `subgraph "${source}" ready at http://localhost:${port}/graphql`);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'graceful shutdown');
    const force = setTimeout(() => process.exit(1), 15000);
    force.unref();
    await server.stop().catch(() => {});
    await queue.close().catch(() => {});
    await db.close().catch(() => {});
    cacheRedis.disconnect();
    pub.disconnect();
    await shutdownTracing();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return { app, server, db };
}

module.exports = { startSubgraph };
