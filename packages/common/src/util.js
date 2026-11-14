'use strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Параллельная обработка массива с ограничением числа одновременных задач. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    // после первой ошибки остальные исполнители прекращают брать задачи (без "осиротевшей" работы)
    while (!failed && next < items.length) {
      const idx = next++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Повтор с экспоненциальной задержкой — используется при старте (ожидание БД и т.п.). */
async function retry(fn, { retries = 20, delayMs = 1000, maxDelayMs = 10000, onRetry } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      attempt++;
      if (attempt > retries) throw err;
      const delay = Math.min(maxDelayMs, delayMs * 1.5 ** (attempt - 1));
      if (onRetry) onRetry(err, attempt, delay);
      await sleep(delay);
    }
  }
}

function uniqueBy(items, keyFn) {
  const map = new Map();
  for (const item of items) map.set(keyFn(item), item);
  return [...map.values()];
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * HTML (Hacker News отдаёт тексты в HTML) -> безопасный plain text.
 * Клиент никогда не получает разметку, поэтому XSS исключён.
 */
function htmlToText(html) {
  if (!html) return html ?? null;
  return html
    .replace(/<p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>.*?<\/a>/gis, (_m, href) => href)
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .trim();
}

const GITHUB_RESERVED = new Set([
  'orgs', 'topics', 'features', 'sponsors', 'marketplace', 'collections', 'about', 'pricing',
  'blog', 'settings', 'apps', 'search', 'trending', 'explore', 'site', 'enterprise', 'login',
  'join', 'readme', 'events', 'customer-stories', 'security', 'notifications', 'new',
]);

/** Извлекает "owner/name" (в нижнем регистре) из любой ссылки на GitHub-репозиторий. */
function parseGithubRepo(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/github\.com[/:]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)/i);
  if (!m) return null;
  const owner = m[1].toLowerCase();
  const name = m[2].toLowerCase().replace(/\.git$/, '');
  if (GITHUB_RESERVED.has(owner) || !name || name === '.' || name === '..') return null;
  return `${owner}/${name}`;
}

function hostOf(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

module.exports = { sleep, mapLimit, chunk, retry, uniqueBy, htmlToText, parseGithubRepo, hostOf };
