'use strict';

const { createHttpClient, metrics, int, env, uniqueBy } = require('@devpulse/common');

/**
 * Сбор репозиториев через GitHub Search API.
 * Search API отдаёт максимум 1000 результатов на запрос, поэтому выборка
 * разбивается на "срезы" язык × диапазон звёзд. Лимиты: 10 запросов/мин
 * без токена, 30 запросов/мин с GITHUB_TOKEN — клиент сам выдерживает паузы.
 */

const LANGUAGES = [
  'JavaScript', 'TypeScript', 'Python', 'Java', 'Go', 'Rust', 'C++', 'C', 'C#', 'PHP', 'Ruby',
  'Kotlin', 'Swift', 'Dart', 'Scala', 'Shell', 'Lua', 'Haskell', 'Elixir', 'Clojure', 'R',
  'Julia', 'Zig', 'Vue', 'Jupyter Notebook', 'Objective-C', 'Perl', 'OCaml', 'Nim', 'HTML',
  'CSS', 'Erlang', 'F#', 'Svelte', 'Solidity', 'Crystal', 'V', 'Fortran', 'MATLAB', 'Groovy',
];
const STAR_RANGES = ['>=20000', '5000..19999', '2000..4999', '1000..1999', '500..999', '250..499', '100..249'];

async function saveRepositories(db, items) {
  const repos = uniqueBy(items, (i) => i.id);
  const owners = uniqueBy(
    repos.map((i) => i.owner),
    (o) => o.id,
  );
  const topicPairs = [];
  for (const r of repos) for (const t of r.topics || []) topicPairs.push([r.id, t.toLowerCase()]);
  const topics = [...new Set(topicPairs.map(([, t]) => t))];

  await db.tx(async (c) => {
    // Логин владельца мог смениться: освобождаем его у "старого" id, чтобы не нарушить уникальность
    await c.query(
      `DELETE FROM owners o USING unnest($1::bigint[], $2::text[]) AS n(id, login)
        WHERE lower(o.login) = lower(n.login) AND o.id <> n.id
          AND NOT EXISTS (SELECT 1 FROM repositories r WHERE r.owner_id = o.id)`,
      [owners.map((o) => o.id), owners.map((o) => o.login)],
    );
    await c.query(
      `INSERT INTO owners (id, login, type, avatar_url, html_url)
       SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[])
       ON CONFLICT (id) DO UPDATE SET login = EXCLUDED.login, type = EXCLUDED.type,
         avatar_url = EXCLUDED.avatar_url, html_url = EXCLUDED.html_url, updated_at = now()`,
      [
        owners.map((o) => o.id),
        owners.map((o) => o.login),
        owners.map((o) => o.type),
        owners.map((o) => o.avatar_url),
        owners.map((o) => o.html_url),
      ],
    );
    await c.query(
      `INSERT INTO repositories (id, full_name, name, owner_id, description, homepage, html_url, language, license,
                                 stars, forks, open_issues, size_kb, archived, is_fork, created_at, pushed_at, updated_at)
       SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::bigint[], $5::text[], $6::text[], $7::text[],
                            $8::text[], $9::text[], $10::int[], $11::int[], $12::int[], $13::int[], $14::bool[],
                            $15::bool[], $16::timestamptz[], $17::timestamptz[], $18::timestamptz[])
       ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, name = EXCLUDED.name, owner_id = EXCLUDED.owner_id,
         description = EXCLUDED.description, homepage = EXCLUDED.homepage, html_url = EXCLUDED.html_url,
         language = EXCLUDED.language, license = EXCLUDED.license, stars = EXCLUDED.stars, forks = EXCLUDED.forks,
         open_issues = EXCLUDED.open_issues, size_kb = EXCLUDED.size_kb, archived = EXCLUDED.archived,
         is_fork = EXCLUDED.is_fork, created_at = EXCLUDED.created_at, pushed_at = EXCLUDED.pushed_at,
         updated_at = EXCLUDED.updated_at, collected_at = now()`,
      [
        repos.map((r) => r.id),
        repos.map((r) => r.full_name),
        repos.map((r) => r.name),
        repos.map((r) => r.owner.id),
        repos.map((r) => r.description?.slice(0, 2000) ?? null),
        repos.map((r) => r.homepage || null),
        repos.map((r) => r.html_url),
        repos.map((r) => r.language),
        repos.map((r) => (r.license?.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? r.license.spdx_id : null)),
        repos.map((r) => r.stargazers_count ?? 0),
        repos.map((r) => r.forks_count ?? 0),
        repos.map((r) => r.open_issues_count ?? 0),
        repos.map((r) => r.size ?? 0),
        repos.map((r) => Boolean(r.archived)),
        repos.map((r) => Boolean(r.fork)),
        repos.map((r) => r.created_at ?? 'epoch'),
        repos.map((r) => r.pushed_at ?? r.created_at ?? 'epoch'),
        repos.map((r) => r.updated_at ?? null),
      ],
    );
    if (topics.length) {
      await c.query('INSERT INTO topics (name) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING', [topics]);
    }
    await c.query('DELETE FROM repository_topics WHERE repository_id = ANY($1::bigint[])', [repos.map((r) => r.id)]);
    if (topicPairs.length) {
      await c.query(
        `INSERT INTO repository_topics (repository_id, topic)
         SELECT * FROM unnest($1::bigint[], $2::text[]) ON CONFLICT DO NOTHING`,
        [topicPairs.map(([id]) => id), topicPairs.map(([, t]) => t)],
      );
    }
  });

  metrics.collectedRecords.inc({ source: 'github', entity: 'repository' }, repos.length);
  metrics.collectedRecords.inc({ source: 'github', entity: 'owner' }, owners.length);
  return repos.length;
}

/** Денормализованные агрегаты (число репозиториев/звёзд владельца, популярность топика). */
async function refreshAggregates(db) {
  await db.query(`
    UPDATE owners o SET repo_count = s.c, total_stars = s.s
      FROM (SELECT owner_id, count(*)::int c, sum(stars)::bigint s FROM repositories GROUP BY owner_id) s
     WHERE s.owner_id = o.id AND (o.repo_count <> s.c OR o.total_stars <> s.s)`);
  await db.query(`
    UPDATE topics t SET repo_count = coalesce(s.c, 0)
      FROM topics t2 LEFT JOIN (SELECT topic, count(*)::int c FROM repository_topics GROUP BY topic) s ON s.topic = t2.name
     WHERE t.name = t2.name AND t.repo_count IS DISTINCT FROM coalesce(s.c, 0)`);
  await db.query('ANALYZE repositories, owners, topics, repository_topics');
}

async function collect({ db, log, progress }) {
  const target = int('GITHUB_TARGET', 12000);
  const token = env('GITHUB_TOKEN', '');
  const github = createHttpClient({
    name: 'github',
    baseUrl: 'https://api.github.com',
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    // Search API: 30 req/min с токеном, 10 req/min без
    minIntervalMs: token ? 2100 : 6300,
  });
  log.info({ target, authenticated: Boolean(token) }, 'GitHub collection started');

  const seen = new Set();
  let pages = 0;
  outer: for (const range of STAR_RANGES) {
    for (const language of LANGUAGES) {
      for (let page = 1; page <= 10; page++) {
        const q = encodeURIComponent(`language:"${language}" stars:${range}`);
        const data = await github.getJson(
          `/search/repositories?q=${q}&sort=stars&order=desc&per_page=100&page=${page}`,
          { allow404: true },
        );
        const items = (data?.items || []).filter((i) => i && i.owner);
        if (items.length) await saveRepositories(db, items);
        for (const i of items) seen.add(i.id);
        pages++;
        if (pages % 20 === 0) await refreshAggregates(db);
        await progress(seen.size, `${language} ★${range} p.${page}`);
        if (seen.size >= target) break outer;
        if (items.length < 100) break;
      }
    }
  }
  await refreshAggregates(db);
  const { rows } = await db.query('SELECT count(*)::int c FROM repositories');
  log.info({ collected: seen.size, total: rows[0].c }, 'GitHub collection finished');
  return seen.size;
}

const isEmpty = async (db) => (await db.query('SELECT NOT EXISTS (SELECT 1 FROM repositories) AS e')).rows[0].e;

module.exports = { collect, isEmpty, saveRepositories, refreshAggregates };
