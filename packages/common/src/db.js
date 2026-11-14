'use strict';

const { Pool, types } = require('pg');
const { logger } = require('./logger');
const { metrics } = require('./metrics');
const { retry } = require('./util');
const { int } = require('./config');

// NUMERIC -> number (агрегаты avg/sum), BIGINT оставляем строкой для id, но count(*)::int приводим явно
types.setTypeParser(1700, (v) => (v === null ? null : Number.parseFloat(v)));

const MIGRATION_LOCK_ID = 774411;

/**
 * Пул соединений PostgreSQL c метриками, транзакциями и защитой от "тяжёлых"
 * запросов (statement_timeout).
 */
function createDb({ connectionString, max = int('PG_POOL_MAX', 15), statementTimeoutMs = int('PG_STATEMENT_TIMEOUT_MS', 15000) }) {
  const pool = new Pool({
    connectionString,
    max,
    statement_timeout: statementTimeoutMs,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  pool.on('error', (err) => logger.error({ err }, 'pg pool error'));

  async function query(text, params) {
    const end = metrics.dbDuration.startTimer();
    try {
      const res = await pool.query(text, params);
      end({ status: 'ok' });
      return res;
    } catch (err) {
      end({ status: 'error' });
      throw err;
    }
  }

  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Идемпотентные миграции под advisory lock (API и воркер стартуют одновременно). */
  async function migrate(sql) {
    await retry(
      async () => {
        const client = await pool.connect();
        try {
          await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
          try {
            await client.query(sql);
          } finally {
            await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
          }
        } finally {
          client.release();
        }
      },
      {
        retries: 30,
        delayMs: 1000,
        onRetry: (err, attempt) => logger.warn({ err: err.message, attempt }, 'database not ready, retrying migration'),
      },
    );
    logger.info('database migrations applied');
  }

  async function ping() {
    await pool.query('SELECT 1');
  }

  return { pool, query, tx, migrate, ping, close: () => pool.end() };
}

module.exports = { createDb };
