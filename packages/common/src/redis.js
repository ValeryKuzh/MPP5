'use strict';

const crypto = require('node:crypto');
const Redis = require('ioredis');
const { logger } = require('./logger');
const { metrics } = require('./metrics');
const { env } = require('./config');

const redisUrl = () => env('REDIS_URL', 'redis://localhost:6379');

/**
 * Клиент для кэша: без офлайн-очереди и с одной попыткой, чтобы при недоступности
 * Redis запросы мгновенно шли в обход кэша, а не зависали (graceful degradation).
 */
function createCacheRedis(url = redisUrl()) {
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 3000,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
  client.on('error', (err) => logger.debug({ err: err.message }, 'redis (cache) error'));
  return client;
}

/** Клиент для BullMQ / pub-sub: ждёт восстановления соединения. */
function createBlockingRedis(url = redisUrl()) {
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
  client.on('error', (err) => logger.debug({ err: err.message }, 'redis error'));
  return client;
}

/** Кэш "read-through" поверх Redis с JSON-сериализацией. */
function createCache(redis, { prefix }) {
  const fullKey = (key) => `cache:${prefix}:${key}`;

  async function wrap(key, ttlSeconds, fn) {
    const k = fullKey(key);
    try {
      const hit = await redis.get(k);
      if (hit !== null) {
        metrics.cacheOps.inc({ cache: prefix, result: 'hit' });
        return JSON.parse(hit);
      }
      metrics.cacheOps.inc({ cache: prefix, result: 'miss' });
    } catch {
      metrics.cacheOps.inc({ cache: prefix, result: 'error' });
    }
    const value = await fn();
    redis.set(k, JSON.stringify(value), 'EX', ttlSeconds).catch(() => {});
    return value;
  }

  /** Удаляет все ключи кэша сервиса (после синхронизации данных). */
  async function clear() {
    let cursor = '0';
    let removed = 0;
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `cache:${prefix}:*`, 'COUNT', 500);
      cursor = next;
      if (keys.length) removed += await redis.del(...keys);
    } while (cursor !== '0');
    return removed;
  }

  return { wrap, clear };
}

const hashKey = (...parts) => crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex');

module.exports = { createCacheRedis, createBlockingRedis, createCache, hashKey, redisUrl };
