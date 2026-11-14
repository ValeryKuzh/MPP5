'use strict';

const CircuitBreaker = require('opossum');
const { logger } = require('./logger');
const { metrics } = require('./metrics');
const { sleep } = require('./util');
const { int } = require('./config');

const USER_AGENT = 'DevPulse-lab/1.0 (educational project)';

/**
 * HTTP-клиент для внешних источников данных с механизмами отказоустойчивости:
 *  - троттлинг (минимальный интервал между запросами) — бережём лимиты API;
 *  - таймаут каждого запроса;
 *  - повторы с экспоненциальной задержкой и jitter для 5xx/сетевых ошибок;
 *  - корректное ожидание при rate limit (429 / 403 + X-RateLimit-Reset / Retry-After);
 *  - circuit breaker (opossum): при серии ошибок источник временно "отключается".
 */
function createHttpClient({
  name,
  baseUrl = '',
  headers = {},
  timeoutMs = int('EXTERNAL_API_TIMEOUT_MS', 90000),
  retries = 4,
  minIntervalMs = 0,
  maxRateLimitWaits = 20,
  breakerOptions = {},
}) {
  let nextSlot = 0;

  async function throttle() {
    if (!minIntervalMs) return;
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + minIntervalMs;
    if (wait) await sleep(wait);
  }

  async function request(url) {
    await throttle();
    const end = metrics.externalDuration.startTimer({ source: name });
    let res;
    let body;
    try {
      res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      // тело читается под тем же таймаутом: обрыв на этапе загрузки тоже считается сетевой ошибкой
      body = await res.text();
    } catch (cause) {
      metrics.externalRequests.inc({ source: name, status: cause.name === 'TimeoutError' ? 'timeout' : 'network_error' });
      const err = new Error(`${name}: network error: ${cause.message}`);
      err.retryable = true;
      throw err;
    } finally {
      end();
    }
    metrics.externalRequests.inc({ source: name, status: String(res.status) });
    if (res.ok) {
      try {
        return JSON.parse(body);
      } catch {
        const err = new Error(`${name}: invalid JSON from ${url}`);
        err.retryable = true;
        throw err;
      }
    }

    const err = new Error(`${name}: HTTP ${res.status} for ${url}: ${body.slice(0, 200)}`);
    err.status = res.status;
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    const retryAfter = res.headers.get('retry-after');
    if (res.status === 429 || (res.status === 403 && (remaining === '0' || retryAfter))) {
      err.rateLimited = true;
      if (retryAfter) err.waitMs = Number(retryAfter) * 1000;
      else if (reset) err.waitMs = Math.max(1000, Number(reset) * 1000 - Date.now() + 1000);
      else err.waitMs = 60000;
    }
    err.retryable = res.status >= 500 || Boolean(err.rateLimited);
    throw err;
  }

  const breaker = new CircuitBreaker(request, {
    name,
    timeout: false, // таймаут обеспечивает AbortSignal
    errorThresholdPercentage: 50,
    volumeThreshold: 8,
    resetTimeout: 30000,
    // 404 и rate limit — не признак неисправности источника
    errorFilter: (err) => err.status === 404 || err.status === 422 || Boolean(err.rateLimited),
    ...breakerOptions,
  });
  metrics.breakerState.set({ name }, 0);
  breaker.on('open', () => {
    metrics.breakerState.set({ name }, 2);
    logger.warn({ source: name }, 'circuit breaker OPEN — source temporarily disabled');
  });
  breaker.on('halfOpen', () => {
    metrics.breakerState.set({ name }, 1);
    logger.info({ source: name }, 'circuit breaker HALF-OPEN — probing source');
  });
  breaker.on('close', () => {
    metrics.breakerState.set({ name }, 0);
    logger.info({ source: name }, 'circuit breaker CLOSED — source recovered');
  });

  async function getJson(pathOrUrl, { allow404 = false } = {}) {
    const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : baseUrl + pathOrUrl;
    let attempt = 0;
    let rateLimitWaits = 0;
    for (;;) {
      try {
        return await breaker.fire(url);
      } catch (err) {
        if (allow404 && err.status === 404) return null;
        if (err.rateLimited && rateLimitWaits < maxRateLimitWaits) {
          rateLimitWaits++;
          const wait = Math.min(err.waitMs, 15 * 60 * 1000);
          logger.warn({ source: name, waitSec: Math.round(wait / 1000) }, 'rate limited by source, waiting');
          await sleep(wait);
          continue;
        }
        const breakerOpen = err.code === 'EOPENBREAKER';
        if ((!err.retryable && !breakerOpen) || attempt >= retries) throw err;
        attempt++;
        const delay = breakerOpen ? 31000 : Math.min(30000, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2);
        logger.warn({ source: name, attempt, delayMs: Math.round(delay), err: err.message }, 'request failed, retrying');
        await sleep(delay);
      }
    }
  }

  return { getJson, breaker };
}

module.exports = { createHttpClient };
