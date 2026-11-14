'use strict';

const pino = require('pino');
const { trace } = require('@opentelemetry/api');
const { env, serviceName } = require('./config');

/** Структурированный JSON-логгер; в каждую запись добавляется trace_id активного спана. */
const logger = pino({
  level: env('LOG_LEVEL', 'info'),
  base: { service: serviceName() },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin() {
    const span = trace.getActiveSpan();
    if (!span) return {};
    const { traceId, spanId } = span.spanContext();
    return { trace_id: traceId, span_id: spanId };
  },
});

module.exports = { logger };
