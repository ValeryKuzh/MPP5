'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const Redis = require('ioredis');
const { WebSocketServer } = require('ws');
const { useServer } = require('graphql-ws/use/ws');
const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@as-integrations/express5');
const { ApolloServerPluginDrainHttpServer } = require('@apollo/server/plugin/drainHttpServer');
const { ApolloServerPluginLandingPageLocalDefault } = require('@apollo/server/plugin/landingPage/default');
const { ApolloGateway, IntrospectAndCompose, RemoteGraphQLDataSource } = require('@apollo/gateway');
const depthLimit = require('graphql-depth-limit');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');

const {
  logger,
  metrics,
  httpMetricsMiddleware,
  apolloMetricsPlugin,
  metricsHandler,
  createBlockingRedis,
  env,
  int,
  retry,
} = require('@devpulse/common');
const { shutdownTracing } = require('@devpulse/common/tracing');
const { complexityPlugin } = require('./complexity');
const { createPubSub, createSubscriptionSchema } = require('./subscriptions');

const PORT = int('PORT', 4000);
const SUBGRAPH_TIMEOUT_MS = int('SUBGRAPH_TIMEOUT_MS', 10000);
const MAX_DEPTH = int('MAX_QUERY_DEPTH', 12);
const MAX_INFLIGHT = int('MAX_INFLIGHT_REQUESTS', 200);
const RATE_LIMIT_PER_MIN = int('RATE_LIMIT_PER_MIN', 600);

const SUBGRAPHS = [
  { name: 'repos', url: env('REPOS_URL', 'http://localhost:4001/graphql') },
  { name: 'news', url: env('NEWS_URL', 'http://localhost:4002/graphql') },
  { name: 'packages', url: env('PACKAGES_URL', 'http://localhost:4003/graphql') },
];

/** Источник данных подграфа: таймаут запроса + проброс идентификатора запроса. */
class SubgraphDataSource extends RemoteGraphQLDataSource {
  constructor(config) {
    super({
      ...config,
      fetcher: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(SUBGRAPH_TIMEOUT_MS) }),
    });
  }
  willSendRequest({ request, context }) {
    if (context?.requestId) request.http.headers.set('x-request-id', context.requestId);
  }
}

function createGateway() {
  return new ApolloGateway({
    supergraphSdl: new IntrospectAndCompose({
      subgraphs: SUBGRAPHS,
      // схема подграфов перечитывается: новые поля появляются без рестарта шлюза
      pollIntervalInMs: int('SUPERGRAPH_POLL_MS', 30000),
      subgraphHealthCheck: false,
    }),
    buildService: ({ url }) => new SubgraphDataSource({ url }),
  });
}

/** Ограничение одновременных запросов (load shedding): лучше быстро ответить 503, чем "лечь". */
function inflightLimiter(max) {
  let inflight = 0;
  return (req, res, next) => {
    if (req.method !== 'POST') return next();
    if (inflight >= max) {
      metrics.rateLimited.inc({ reason: 'overload' });
      res.set('Retry-After', '1');
      return res.status(503).json({ errors: [{ message: 'Server is overloaded, retry later', extensions: { code: 'SERVICE_UNAVAILABLE' } }] });
    }
    inflight++;
    res.on('close', () => inflight--);
    next();
  };
}

async function checkSubgraphs() {
  const results = await Promise.all(
    SUBGRAPHS.map(async ({ name, url }) => {
      try {
        const res = await fetch(url.replace(/\/graphql$/, '/health'), { signal: AbortSignal.timeout(2000) });
        return [name, res.ok ? 'ok' : `HTTP ${res.status}`];
      } catch (err) {
        return [name, err.message];
      }
    }),
  );
  return Object.fromEntries(results);
}

async function main() {
  const redis = new Redis(env('REDIS_URL', 'redis://localhost:6379'), { maxRetriesPerRequest: 1, connectTimeout: 3000 });
  redis.on('error', (err) => logger.debug({ err: err.message }, 'redis error'));
  const pubsub = createPubSub(createBlockingRedis());

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  const httpServer = http.createServer(app);

  app.use(httpMetricsMiddleware);
  app.use(cors({ origin: env('CORS_ORIGIN', '*').split(','), exposedHeaders: ['RateLimit', 'RateLimit-Policy', 'Retry-After'] }));
  app.get('/metrics', metricsHandler);

  let gatewayReady = false;
  app.get('/health', async (_req, res) => {
    const subgraphs = await checkSubgraphs();
    const allOk = Object.values(subgraphs).every((s) => s === 'ok');
    // шлюз "жив", даже если часть подграфов недоступна — он отдаёт частичные ответы
    res.status(gatewayReady ? 200 : 503).json({ status: gatewayReady ? (allOk ? 'ok' : 'degraded') : 'starting', subgraphs });
  });

  // --- WebSocket: GraphQL Subscriptions ---
  const wsServer = new WebSocketServer({ server: httpServer, path: '/graphql', maxPayload: 64 * 1024 });
  const wsCleanup = useServer(
    { schema: createSubscriptionSchema(pubsub) },
    wsServer,
  );

  // --- Федеративный шлюз (повторяем запуск, пока подграфы не станут доступны) ---
  const server = await retry(
    async () => {
      const s = new ApolloServer({
        gateway: createGateway(),
        introspection: true,
        includeStacktraceInErrorResponses: false,
        persistedQueries: { ttl: 900 }, // Automatic Persisted Queries
        validationRules: [depthLimit(MAX_DEPTH)],
        plugins: [
          ApolloServerPluginDrainHttpServer({ httpServer }),
          {
            async serverWillStart() {
              return {
                async drainServer() {
                  await wsCleanup.dispose();
                },
              };
            },
          },
          ApolloServerPluginLandingPageLocalDefault({ embed: true, includeCookies: false }),
          apolloMetricsPlugin(),
          complexityPlugin({ redis }),
          {
            async requestDidStart({ request, contextValue }) {
              const started = Date.now();
              return {
                async willSendResponse({ errors }) {
                  logger.info(
                    {
                      requestId: contextValue.requestId,
                      operation: request.operationName,
                      durationMs: Date.now() - started,
                      complexity: contextValue.cost?.complexity,
                      errors: errors?.map((e) => e.extensions?.code || e.message),
                    },
                    'graphql request',
                  );
                },
              };
            },
          },
        ],
      });
      await s.start();
      return s;
    },
    {
      retries: 60,
      delayMs: 2000,
      maxDelayMs: 5000,
      onRetry: (err, attempt) => logger.warn({ attempt, err: err.message }, 'supergraph not ready, retrying'),
    },
  );
  gatewayReady = true;

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: RATE_LIMIT_PER_MIN,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    passOnStoreError: true, // Redis недоступен -> не блокируем пользователей
    keyGenerator: (req) => ipKeyGenerator(req.ip || 'unknown'),
    store: new RedisStore({ prefix: 'ratelimit:req:', sendCommand: (...args) => redis.call(...args) }),
    handler: (_req, res) => {
      metrics.rateLimited.inc({ reason: 'requests' });
      res.status(429).json({ errors: [{ message: 'Too many requests', extensions: { code: 'RATE_LIMITED' } }] });
    },
  });

  app.use(
    '/graphql',
    inflightLimiter(MAX_INFLIGHT),
    limiter,
    express.json({ limit: '256kb' }),
    expressMiddleware(server, {
      context: async ({ req }) => ({
        requestId: req.headers['x-request-id'] || crypto.randomUUID(),
        clientId: req.ip || 'unknown',
      }),
    }),
  );

  await new Promise((resolve) => httpServer.listen(PORT, resolve));
  logger.info({ port: PORT }, `gateway ready at http://localhost:${PORT}/graphql (HTTP + WebSocket)`);

  const shutdown = async (signal) => {
    logger.info({ signal }, 'gateway shutting down');
    const force = setTimeout(() => process.exit(1), 15000);
    force.unref();
    await server.stop().catch(() => {});
    redis.disconnect();
    await shutdownTracing();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'gateway failed to start');
  process.exit(1);
});
