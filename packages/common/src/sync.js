'use strict';

const express = require('express');
const { Queue, Worker } = require('bullmq');
const { logger } = require('./logger');
const { metrics, metricsHandler } = require('./metrics');
const { createDb } = require('./db');
const { createBlockingRedis, createCacheRedis, createCache } = require('./redis');
const { env, int, bool } = require('./config');
const { mapSyncRun } = require('./schema');

/** Канал Redis Pub/Sub, из которого шлюз отдаёт GraphQL-подписку syncProgress. */
const SYNC_CHANNEL = 'devpulse:sync-progress';

const syncRunsSql = `
CREATE TABLE IF NOT EXISTS sync_runs (
  id          SERIAL PRIMARY KEY,
  source      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'QUEUED',
  processed   INT  NOT NULL DEFAULT 0,
  message     TEXT,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sync_runs_status_idx ON sync_runs (status);
`;

const queueName = (source) => `sync-${source}`;

function publishProgress(redis, run, extra = {}) {
  const event = {
    source: run.source,
    runId: String(run.id),
    status: run.status,
    processed: run.processed ?? 0,
    message: run.message ?? null,
    error: run.error ?? null,
    at: new Date().toISOString(),
    ...extra,
  };
  return redis.publish(SYNC_CHANNEL, JSON.stringify(event)).catch(() => {});
}

/**
 * Ставит синхронизацию в очередь. Идемпотентно: если запуск уже в очереди или
 * выполняется — возвращается он же (защита от "спама" мутацией).
 */
async function requestSync({ db, queue, redis, source }) {
  const active = await db.query(
    `SELECT * FROM sync_runs WHERE status IN ('QUEUED','RUNNING') ORDER BY id DESC LIMIT 1`,
  );
  if (active.rows[0]) return mapSyncRun(active.rows[0]);
  const { rows } = await db.query(`INSERT INTO sync_runs (source, status) VALUES ($1, 'QUEUED') RETURNING *`, [source]);
  const run = rows[0];
  await queue.add(
    'sync',
    { runId: run.id },
    { attempts: 3, backoff: { type: 'exponential', delay: 60000 }, removeOnComplete: 50, removeOnFail: 50 },
  );
  if (redis) await publishProgress(redis, run);
  return mapSyncRun(run);
}

async function listSyncRuns(db, limit = 10) {
  const { rows } = await db.query('SELECT * FROM sync_runs ORDER BY id DESC LIMIT $1', [Math.min(limit, 100)]);
  return rows.map(mapSyncRun);
}

/**
 * Процесс-воркер сбора данных (отдельный контейнер).
 *  - задания приходят из BullMQ (мутация sync*, расписание cron, первичная загрузка);
 *  - прогресс пишется в sync_runs и публикуется в Redis Pub/Sub;
 *  - при сбое задание повторяется (attempts + exponential backoff), а сбор
 *    идемпотентен (UPSERT), поэтому повтор безопасно "докачивает" данные.
 */
async function startWorker({ source, migrations, collect, isEmpty }) {
  const db = createDb({ connectionString: env('DATABASE_URL') });
  await db.migrate(migrations + syncRunsSql);

  const connection = createBlockingRedis();
  const pub = createBlockingRedis();
  const cache = createCache(createCacheRedis(), { prefix: source });
  const queue = new Queue(queueName(source), { connection });

  // Периодический автоматический сбор
  const cron = env('SYNC_CRON', '0 */6 * * *');
  await queue.upsertJobScheduler(`${source}-scheduled`, { pattern: cron }, { name: 'sync', data: {} });
  logger.info({ cron }, 'sync schedule registered');

  // Запуски, прерванные падением процесса, помечаем — BullMQ перезапустит задание
  await db.query(
    `UPDATE sync_runs SET status = 'FAILED', error = 'Interrupted (worker restart)', finished_at = now() WHERE status = 'RUNNING'`,
  );

  if (bool('AUTO_SYNC_ON_START', true) && (await isEmpty(db))) {
    logger.info('database is empty — scheduling initial data collection');
    await requestSync({ db, queue, redis: pub, source });
  }

  const worker = new Worker(
    queueName(source),
    async (job) => {
      let run;
      if (job.data.runId) {
        const { rows } = await db.query(
          `UPDATE sync_runs SET status = 'RUNNING', started_at = now(), error = NULL WHERE id = $1 RETURNING *`,
          [job.data.runId],
        );
        run = rows[0];
      }
      if (!run) {
        const { rows } = await db.query(
          `INSERT INTO sync_runs (source, status, started_at) VALUES ($1, 'RUNNING', now()) RETURNING *`,
          [source],
        );
        run = rows[0];
      }
      const log = logger.child({ runId: run.id, attempt: job.attemptsMade + 1 });
      log.info('sync started');
      await publishProgress(pub, run);
      const stopTimer = metrics.syncDuration.startTimer({ source });

      let lastPublish = 0;
      const progress = async (processed, message) => {
        run.processed = processed;
        run.message = message;
        const now = Date.now();
        if (now - lastPublish < 1000) return;
        lastPublish = now;
        // прогресс — некритичная информация: его сбой не должен прерывать сбор данных
        await db
          .query(`UPDATE sync_runs SET processed = $2, message = $3 WHERE id = $1 AND status = 'RUNNING'`, [
            run.id,
            processed,
            message,
          ])
          .catch((err) => log.warn({ err: err.message }, 'failed to store sync progress'));
        await job.updateProgress(processed).catch(() => {});
        await publishProgress(pub, run);
      };

      try {
        const total = await collect({ db, log, progress, job });
        const { rows } = await db.query(
          `UPDATE sync_runs SET status = 'COMPLETED', processed = $2, message = 'done', finished_at = now() WHERE id = $1 RETURNING *`,
          [run.id, total],
        );
        stopTimer();
        metrics.syncRuns.inc({ source, status: 'COMPLETED' });
        const cleared = await cache.clear().catch(() => 0);
        log.info({ total, cacheKeysCleared: cleared }, 'sync completed');
        await publishProgress(pub, rows[0]);
        return total;
      } catch (err) {
        stopTimer();
        metrics.syncRuns.inc({ source, status: 'FAILED' });
        log.error({ err }, 'sync failed');
        const { rows } = await db.query(
          `UPDATE sync_runs SET status = 'FAILED', error = $2, finished_at = now() WHERE id = $1 RETURNING *`,
          [run.id, String(err.message).slice(0, 1000)],
        );
        await publishProgress(pub, rows[0]);
        throw err;
      }
    },
    { connection: createBlockingRedis(), concurrency: 1, lockDuration: 120000 },
  );
  worker.on('error', (err) => logger.error({ err }, 'worker error'));

  // /metrics и /health воркера для Prometheus и docker healthcheck
  const app = express();
  app.get('/metrics', metricsHandler);
  app.get('/health', async (_req, res) => {
    try {
      await db.ping();
      res.json({ status: 'ok', running: worker.isRunning() });
    } catch (err) {
      res.status(503).json({ status: 'error', error: err.message });
    }
  });
  const port = int('METRICS_PORT', 9100);
  const server = app.listen(port, () => logger.info({ port }, 'worker metrics server listening'));

  const shutdown = async (signal) => {
    logger.info({ signal }, 'worker shutting down');
    server.close();
    await worker.close().catch(() => {});
    await queue.close().catch(() => {});
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { SYNC_CHANNEL, syncRunsSql, requestSync, listSyncRuns, startWorker, queueName, publishProgress };
