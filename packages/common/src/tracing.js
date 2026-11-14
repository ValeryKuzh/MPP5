'use strict';

/**
 * Инициализация OpenTelemetry. Подключается флагом `node -r @devpulse/common/tracing`
 * ДО загрузки остальных модулей, чтобы автоинструментация успела пропатчить
 * http, express, graphql, pg, ioredis, undici (fetch).
 *
 * Трейсы отправляются по OTLP/HTTP (по умолчанию в Jaeger: http://jaeger:4318).
 * Сэмплирование настраивается стандартными переменными OTEL_TRACES_SAMPLER(_ARG).
 */
if (process.env.OTEL_SDK_DISABLED === 'true' || process.env.OTEL_ENABLED === 'false') {
  module.exports = { shutdownTracing: async () => {} };
} else {
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');

  const IGNORED_PATHS = ['/metrics', '/health'];

  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME || process.env.SERVICE_NAME || 'devpulse',
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (req) => IGNORED_PATHS.some((p) => (req.url || '').startsWith(p)),
        },
        // BullMQ постоянно опрашивает Redis — пишем спаны только внутри запросов
        '@opentelemetry/instrumentation-ioredis': { requireParentSpan: true },
        '@opentelemetry/instrumentation-pg': { enhancedDatabaseReporting: false },
        '@opentelemetry/instrumentation-graphql': { mergeItems: true, ignoreTrivialResolveSpans: true },
      }),
    ],
  });

  try {
    sdk.start();
  } catch (err) {
    // трассировка не должна ронять сервис
    console.error('OpenTelemetry init failed', err);
  }

  module.exports = {
    shutdownTracing: () => sdk.shutdown().catch(() => {}),
  };
}
