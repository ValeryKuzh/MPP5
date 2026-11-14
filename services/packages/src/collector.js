'use strict';

const { createHttpClient, metrics, int, uniqueBy, mapLimit, parseGithubRepo } = require('@devpulse/common');

/**
 * Сбор пакетов из npm registry:
 *  1) поиск по ключевым словам (/-/v1/search, до 250 записей на страницу);
 *     ответ уже содержит загрузки, лицензию, мейнтейнеров и число зависимых пакетов;
 *  2) для самых популярных пакетов — манифест последней версии (/:name/latest)
 *     с dependencies / devDependencies / peerDependencies -> граф зависимостей.
 */

const KEYWORDS = [
  'react', 'vue', 'angular', 'svelte', 'typescript', 'cli', 'testing', 'eslint', 'webpack', 'vite',
  'babel', 'express', 'http', 'graphql', 'database', 'postgres', 'mongodb', 'redis', 'orm', 'logging',
  'auth', 'jwt', 'crypto', 'date', 'validation', 'css', 'ui', 'components', 'icons', 'charts',
  'markdown', 'parser', 'ast', 'compiler', 'stream', 'async', 'promise', 'utility', 'functional', 'state',
  'redux', 'router', 'server', 'framework', 'api', 'sdk', 'aws', 'cloud', 'docker', 'kubernetes',
  'ai', 'llm', 'openai', 'machine-learning', 'image', 'video', 'audio', 'pdf', 'excel', 'csv',
  'json', 'yaml', 'xml', 'i18n', 'animation', 'game', 'canvas', 'webgl', 'threejs', 'd3',
  'websocket', 'queue', 'cache', 'performance', 'monitoring', 'security', 'oauth', 'email', 'mobile',
  'react-native', 'electron', 'nodejs', 'deno', 'bun', 'plugin', 'prettier', 'postcss', 'tailwind',
  'sass', 'mock', 'benchmark', 'storage', 'file', 'git', 'github', 'terminal', 'color', 'template',
  'nextjs', 'nuxt', 'serverless', 'blockchain', 'web3', 'rest', 'grpc', 'microservices', 'kafka', 'mqtt',
];

const toInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

async function savePackages(db, objects) {
  const items = uniqueBy(
    objects.filter((o) => o?.package?.name),
    (o) => o.package.name,
  );
  if (!items.length) return 0;
  const pkg = (o) => o.package;
  const keywords = (o) =>
    [...new Set((Array.isArray(pkg(o).keywords) ? pkg(o).keywords : []).map((k) => String(k).toLowerCase().trim()))]
      .filter(Boolean)
      .slice(0, 30);
  // массивы переменной длины передаём как JSON, т.к. unnest() не поддерживает "рваные" text[][]
  await db.query(
    `INSERT INTO packages (name, version, description, keywords, keywords_text, license, homepage, repository_url,
                           repo_full_name, publisher, maintainers, published_at, downloads_monthly, downloads_weekly,
                           dependents_count, score)
     SELECT x.name, x.version, x.description,
            ARRAY(SELECT jsonb_array_elements_text(x.keywords)), x.keywords_text, x.license, x.homepage, x.repository_url,
            x.repo_full_name, x.publisher, ARRAY(SELECT jsonb_array_elements_text(x.maintainers)),
            x.published_at, x.downloads_monthly, x.downloads_weekly, x.dependents_count, x.score
       FROM jsonb_to_recordset($1::jsonb) AS x(
            name text, version text, description text, keywords jsonb, keywords_text text, license text,
            homepage text, repository_url text, repo_full_name text, publisher text, maintainers jsonb,
            published_at timestamptz, downloads_monthly bigint, downloads_weekly bigint, dependents_count int, score real)
     ON CONFLICT (name) DO UPDATE SET version = EXCLUDED.version, description = EXCLUDED.description,
       keywords = EXCLUDED.keywords, keywords_text = EXCLUDED.keywords_text,
       license = COALESCE(EXCLUDED.license, packages.license), homepage = EXCLUDED.homepage,
       repository_url = EXCLUDED.repository_url, repo_full_name = EXCLUDED.repo_full_name,
       publisher = EXCLUDED.publisher, maintainers = EXCLUDED.maintainers, published_at = EXCLUDED.published_at,
       downloads_monthly = EXCLUDED.downloads_monthly, downloads_weekly = EXCLUDED.downloads_weekly,
       dependents_count = EXCLUDED.dependents_count, score = EXCLUDED.score,
       deps_fetched = packages.deps_fetched AND packages.version = EXCLUDED.version,
       collected_at = now()`,
    [
      JSON.stringify(
        items.map((o) => {
          const p = pkg(o);
          const repoUrl = p.links?.repository || null;
          return {
            name: p.name,
            version: p.version || null,
            description: typeof p.description === 'string' ? p.description.slice(0, 2000) : null,
            keywords: keywords(o),
            keywords_text: keywords(o).join(' '),
            license: typeof p.license === 'string' ? p.license.slice(0, 100) : null,
            homepage: p.links?.homepage || null,
            repository_url: repoUrl,
            repo_full_name: parseGithubRepo(repoUrl) ?? parseGithubRepo(p.links?.homepage),
            publisher: p.publisher?.username || null,
            maintainers: (p.maintainers || []).map((m) => m.username).filter(Boolean).slice(0, 50),
            published_at: p.date || 'epoch',
            downloads_monthly: toInt(o.downloads?.monthly),
            downloads_weekly: toInt(o.downloads?.weekly),
            dependents_count: toInt(o.dependents),
            score: Number(o.score?.final ?? o.searchScore ?? 0) || 0,
          };
        }),
      ),
    ],
  );
  metrics.collectedRecords.inc({ source: 'npm', entity: 'package' }, items.length);
  return items.length;
}

const KIND_FIELDS = [
  ['PROD', 'dependencies'],
  ['DEV', 'devDependencies'],
  ['PEER', 'peerDependencies'],
];

async function saveDependencies(db, name, manifest) {
  const deps = [];
  for (const [kind, field] of KIND_FIELDS) {
    const obj = manifest?.[field];
    if (obj && typeof obj === 'object') {
      for (const [dep, range] of Object.entries(obj).slice(0, 300)) deps.push([dep, String(range).slice(0, 200), kind]);
    }
  }
  await db.tx(async (c) => {
    await c.query('DELETE FROM dependencies WHERE package_name = $1', [name]);
    if (deps.length) {
      await c.query(
        `INSERT INTO dependencies (package_name, dependency_name, version_range, kind)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[]) ON CONFLICT DO NOTHING`,
        [name, deps.map((d) => d[0]), deps.map((d) => d[1]), deps.map((d) => d[2])],
      );
    }
    const license = typeof manifest?.license === 'string' ? manifest.license.slice(0, 100) : null;
    await c.query('UPDATE packages SET deps_fetched = true, license = COALESCE(license, $2) WHERE name = $1', [
      name,
      license,
    ]);
  });
  metrics.collectedRecords.inc({ source: 'npm', entity: 'dependency' }, deps.length);
  return deps.length;
}

async function refreshMaintainers(db) {
  await db.tx(async (c) => {
    await c.query('TRUNCATE maintainers');
    await c.query(`
      INSERT INTO maintainers (name, package_count, total_downloads)
      SELECT m, count(*)::int, sum(downloads_monthly)::bigint FROM packages, unnest(maintainers) m GROUP BY m`);
  });
  await db.query('ANALYZE packages, dependencies, maintainers');
}

async function collect({ db, log, progress }) {
  const registry = createHttpClient({ name: 'npm-registry', baseUrl: 'https://registry.npmjs.org', minIntervalMs: 150 });
  const target = int('NPM_TARGET', 12000);
  const pagesPerKeyword = int('NPM_PAGES_PER_KEYWORD', 4);
  const seen = new Set();
  let processed = 0;

  outer: for (const keyword of KEYWORDS) {
    for (let page = 0; page < pagesPerKeyword; page++) {
      const data = await registry.getJson(
        `/-/v1/search?text=keywords:${encodeURIComponent(keyword)}&size=250&from=${page * 250}`,
      );
      const objects = data?.objects || [];
      if (!objects.length) break;
      await savePackages(db, objects);
      for (const o of objects) if (o?.package?.name) seen.add(o.package.name);
      processed += objects.length;
      await progress(processed, `search "${keyword}" p.${page + 1}: ${seen.size} unique packages`);
      if (seen.size >= target) break outer;
      if (objects.length < 250) break;
    }
  }
  log.info({ packages: seen.size }, 'npm search phase finished');

  // Граф зависимостей для самых популярных пакетов
  const depsLimit = int('NPM_DEPS_LIMIT', 3000);
  const { rows } = await db.query(
    'SELECT name FROM packages WHERE NOT deps_fetched ORDER BY downloads_monthly DESC LIMIT $1',
    [depsLimit],
  );
  let done = 0;
  let depsTotal = 0;
  await mapLimit(rows, 6, async ({ name }) => {
    try {
      const manifest = await registry.getJson(`/${name.replace('/', '%2F')}/latest`, { allow404: true });
      depsTotal += await saveDependencies(db, name, manifest);
    } catch (err) {
      log.warn({ name, err: err.message }, 'failed to fetch manifest');
    }
    done++;
    processed++;
    await progress(processed, `dependencies: ${done}/${rows.length} packages, ${depsTotal} edges`);
  });

  await refreshMaintainers(db);
  log.info({ packages: seen.size, dependencies: depsTotal }, 'npm collection finished');
  return processed;
}

const isEmpty = async (db) => (await db.query('SELECT NOT EXISTS (SELECT 1 FROM packages) AS e')).rows[0].e;

module.exports = { collect, isEmpty };
