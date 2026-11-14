'use strict';

const client = require('prom-client');
const { serviceName } = require('./config');

/** Реестр Prometheus-метрик сервиса. Экспортируется по GET /metrics. */
const register = new client.Registry();
register.setDefaultLabels({ service: serviceName() });
client.collectDefaultMetrics({ register });

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const metrics = {
  httpDuration: new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Длительность HTTP-запросов',
    labelNames: ['method', 'route', 'status'],
    buckets: LATENCY_BUCKETS,
    registers: [register],
  }),
  httpInflight: new client.Gauge({
    name: 'http_inflight_requests',
    help: 'Количество одновременно обрабатываемых HTTP-запросов',
    registers: [register],
  }),
  gqlDuration: new client.Histogram({
    name: 'graphql_operation_duration_seconds',
    help: 'Длительность GraphQL-операций',
    labelNames: ['operation', 'type', 'status'],
    buckets: LATENCY_BUCKETS,
    registers: [register],
  }),
  gqlErrors: new client.Counter({
    name: 'graphql_errors_total',
    help: 'Ошибки GraphQL по коду',
    labelNames: ['operation', 'code'],
    registers: [register],
  }),
  gqlComplexity: new client.Histogram({
    name: 'graphql_query_complexity',
    help: 'Вычисленная сложность входящих запросов',
    buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
    registers: [register],
  }),
  rateLimited: new client.Counter({
    name: 'rate_limited_requests_total',
    help: 'Отклонённые запросы (контроль нагрузки)',
    labelNames: ['reason'],
    registers: [register],
  }),
  dbDuration: new client.Histogram({
    name: 'db_query_duration_seconds',
    help: 'Длительность SQL-запросов',
    labelNames: ['status'],
    buckets: LATENCY_BUCKETS,
    registers: [register],
  }),
  cacheOps: new client.Counter({
    name: 'cache_operations_total',
    help: 'Операции кэша Redis (hit/miss/error)',
    labelNames: ['cache', 'result'],
    registers: [register],
  }),
  externalRequests: new client.Counter({
    name: 'external_api_requests_total',
    help: 'Запросы к внешним API-источникам',
    labelNames: ['source', 'status'],
    registers: [register],
  }),
  externalDuration: new client.Histogram({
    name: 'external_api_request_duration_seconds',
    help: 'Длительность запросов к внешним API',
    labelNames: ['source'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
    registers: [register],
  }),
  breakerState: new client.Gauge({
    name: 'circuit_breaker_state',
    help: 'Состояние circuit breaker: 0 — closed, 1 — half-open, 2 — open',
    labelNames: ['name'],
    registers: [register],
  }),
  collectedRecords: new client.Counter({
    name: 'collector_records_total',
    help: 'Количество собранных записей по источникам',
    labelNames: ['source', 'entity'],
    registers: [register],
  }),
  syncRuns: new client.Counter({
    name: 'sync_runs_total',
    help: 'Запуски синхронизации данных',
    labelNames: ['source', 'status'],
    registers: [register],
  }),
  syncDuration: new client.Histogram({
    name: 'sync_run_duration_seconds',
    help: 'Длительность синхронизации источника',
    labelNames: ['source'],
    buckets: [10, 30, 60, 120, 300, 600, 1200, 2400, 3600],
    registers: [register],
  }),
};

/** Express middleware: латентность и in-flight запросы. */
function httpMetricsMiddleware(req, res, next) {
  metrics.httpInflight.inc();
  const end = metrics.httpDuration.startTimer();
  res.on('finish', () => {
    metrics.httpInflight.dec();
    end({ method: req.method, route: req.baseUrl || req.path, status: res.statusCode });
  });
  next();
}

/** Плагин Apollo Server: длительность и ошибки каждой операции. */
function apolloMetricsPlugin() {
  return {
    async requestDidStart() {
      const end = metrics.gqlDuration.startTimer();
      return {
        async didEncounterErrors(ctx) {
          const operation = ctx.operationName || 'anonymous';
          for (const err of ctx.errors) {
            metrics.gqlErrors.inc({ operation, code: err.extensions?.code || 'INTERNAL_SERVER_ERROR' });
          }
        },
        async willSendResponse(ctx) {
          end({
            operation: ctx.operationName || 'anonymous',
            type: ctx.operation?.operation || 'unknown',
            status: ctx.errors?.length ? 'error' : 'ok',
          });
        },
      };
    },
  };
}

async function metricsHandler(_req, res) {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}

module.exports = { register, metrics, httpMetricsMiddleware, apolloMetricsPlugin, metricsHandler };
