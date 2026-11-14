'use strict';

/** Генерирует дашборд Grafana: node scripts/gen-dashboard.js */
const fs = require('node:fs');
const path = require('node:path');

let id = 1;
const ds = { type: 'prometheus', uid: 'prometheus' };

const target = (expr, legend, refId = 'A') => ({ datasource: ds, expr, legendFormat: legend, refId });

function stat(title, expr, { unit = 'short', x, y, w = 4, h = 4, thresholds } = {}) {
  return {
    id: id++,
    type: 'stat',
    title,
    datasource: ds,
    gridPos: { x, y, w, h },
    targets: [target(expr, title)],
    fieldConfig: {
      defaults: {
        unit,
        decimals: 2,
        thresholds: thresholds || { mode: 'absolute', steps: [{ color: 'green', value: null }] },
      },
      overrides: [],
    },
    options: { reduceOptions: { calcs: ['lastNotNull'] }, colorMode: 'value', graphMode: 'area' },
  };
}

function ts(title, targets, { unit = 'short', x, y, w = 12, h = 8, stack = false } = {}) {
  return {
    id: id++,
    type: 'timeseries',
    title,
    datasource: ds,
    gridPos: { x, y, w, h },
    targets: targets.map((t, i) => target(t[0], t[1], String.fromCharCode(65 + i))),
    fieldConfig: {
      defaults: {
        unit,
        custom: { lineWidth: 1, fillOpacity: stack ? 30 : 10, stacking: { mode: stack ? 'normal' : 'none' } },
      },
      overrides: [],
    },
    options: { legend: { displayMode: 'table', placement: 'right', calcs: ['lastNotNull', 'max'] }, tooltip: { mode: 'multi' } },
  };
}

const row = (title, y) => ({ id: id++, type: 'row', title, collapsed: false, gridPos: { x: 0, y, w: 24, h: 1 }, panels: [] });

const panels = [
  row('Шлюз (GraphQL Federation)', 0),
  stat('Запросов/с', 'sum(rate(graphql_operation_duration_seconds_count{service="gateway"}[1m]))', { x: 0, y: 1, unit: 'reqps' }),
  stat('p95 латентность', 'histogram_quantile(0.95, sum by (le) (rate(graphql_operation_duration_seconds_bucket{service="gateway"}[5m])))', {
    x: 4, y: 1, unit: 's',
    thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'orange', value: 0.5 }, { color: 'red', value: 1 }] },
  }),
  stat('Доля ошибок', 'sum(rate(graphql_errors_total{service="gateway"}[5m])) / clamp_min(sum(rate(graphql_operation_duration_seconds_count{service="gateway"}[5m])), 0.0001)', {
    x: 8, y: 1, unit: 'percentunit',
    thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'red', value: 0.05 }] },
  }),
  stat('Отклонено (контроль нагрузки)/мин', 'sum(increase(rate_limited_requests_total[1m]))', { x: 12, y: 1 }),
  stat('Сервисов UP', 'sum(up)', { x: 16, y: 1 }),
  stat('Сервисов DOWN', 'count(up == 0) or vector(0)', {
    x: 20, y: 1,
    thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'red', value: 1 }] },
  }),
  ts('Операции/с по имени', [['sum by (operation) (rate(graphql_operation_duration_seconds_count{service="gateway"}[1m]))', '{{operation}}']], { x: 0, y: 5, unit: 'reqps' }),
  ts('Латентность шлюза', [
    ['histogram_quantile(0.5, sum by (le) (rate(graphql_operation_duration_seconds_bucket{service="gateway"}[5m])))', 'p50'],
    ['histogram_quantile(0.95, sum by (le) (rate(graphql_operation_duration_seconds_bucket{service="gateway"}[5m])))', 'p95'],
    ['histogram_quantile(0.99, sum by (le) (rate(graphql_operation_duration_seconds_bucket{service="gateway"}[5m])))', 'p99'],
  ], { x: 12, y: 5, unit: 's' }),
  ts('Ошибки по коду', [['sum by (service, code) (rate(graphql_errors_total[5m]))', '{{service}} {{code}}']], { x: 0, y: 13 }),
  ts('Контроль нагрузки: отклонённые запросы', [['sum by (reason) (rate(rate_limited_requests_total[1m]))', '{{reason}}']], { x: 12, y: 13, stack: true }),
  ts('Сложность запросов (p50 / p95)', [
    ['histogram_quantile(0.5, sum by (le) (rate(graphql_query_complexity_bucket[5m])))', 'p50'],
    ['histogram_quantile(0.95, sum by (le) (rate(graphql_query_complexity_bucket[5m])))', 'p95'],
  ], { x: 0, y: 21 }),
  ts('Одновременные HTTP-запросы', [['sum by (service) (http_inflight_requests)', '{{service}}']], { x: 12, y: 21 }),

  row('Подграфы и хранилища', 29),
  ts('p95 латентность подграфов', [['histogram_quantile(0.95, sum by (le, service) (rate(graphql_operation_duration_seconds_bucket{service!="gateway"}[5m])))', '{{service}}']], { x: 0, y: 30, unit: 's' }),
  ts('p95 SQL-запросов', [['histogram_quantile(0.95, sum by (le, service) (rate(db_query_duration_seconds_bucket[5m])))', '{{service}}']], { x: 12, y: 30, unit: 's' }),
  ts('Кэш Redis: hit ratio', [['sum by (cache) (rate(cache_operations_total{result="hit"}[5m])) / clamp_min(sum by (cache) (rate(cache_operations_total{result=~"hit|miss"}[5m])), 0.0001)', '{{cache}}']], { x: 0, y: 38, unit: 'percentunit' }),
  ts('Память процессов', [['process_resident_memory_bytes', '{{service}} {{instance}}']], { x: 12, y: 38, unit: 'bytes' }),
  ts('Event loop lag p99', [['nodejs_eventloop_lag_p99_seconds', '{{service}} {{instance}}']], { x: 0, y: 46, unit: 's' }),
  ts('CPU', [['rate(process_cpu_seconds_total[1m])', '{{service}} {{instance}}']], { x: 12, y: 46, unit: 'percentunit' }),

  row('Сбор данных', 54),
  ts('Собрано записей/с', [['sum by (source, entity) (rate(collector_records_total[1m]))', '{{source}} / {{entity}}']], { x: 0, y: 55, stack: true }),
  ts('Запросы к внешним API', [['sum by (source, status) (rate(external_api_requests_total[1m]))', '{{source}} {{status}}']], { x: 12, y: 55 }),
  ts('Circuit breaker (0 closed, 1 half-open, 2 open)', [['max by (name) (circuit_breaker_state)', '{{name}}']], { x: 0, y: 63 }),
  ts('Синхронизации', [['sum by (source, status) (increase(sync_runs_total[1h]))', '{{source}} {{status}}']], { x: 12, y: 63 }),
];

const dashboard = {
  uid: 'devpulse-overview',
  title: 'DevPulse — обзор системы',
  tags: ['devpulse', 'graphql'],
  timezone: 'browser',
  schemaVersion: 39,
  version: 1,
  refresh: '10s',
  time: { from: 'now-30m', to: 'now' },
  panels,
};

const out = path.join(__dirname, '..', 'infra', 'grafana', 'dashboards', 'devpulse.json');
fs.writeFileSync(out, JSON.stringify(dashboard, null, 2));
console.log(`dashboard written: ${out} (${panels.length} panels)`);
