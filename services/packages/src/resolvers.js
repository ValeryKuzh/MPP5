'use strict';

const {
  Params,
  buildFilter,
  resolveSort,
  paginate,
  escapeLike,
  badInput,
  DateTime,
  requestSync,
  listSyncRuns,
} = require('@devpulse/common');
const { mapPackage, mapMaintainer, PACKAGE_COLUMNS } = require('./loaders');

const SOURCE = 'packages';

const PACKAGE_SORT_FIELDS = {
  DOWNLOADS: 'p.downloads_monthly',
  DEPENDENTS: 'p.dependents_count',
  PUBLISHED_AT: 'p.published_at',
  SCORE: 'p.score',
  NAME: 'p.name',
};

const lowerAll = (arr) => [...new Set(arr.map((s) => s.toLowerCase()))];

const PACKAGE_FILTER_FIELDS = {
  name: { expr: 'p.name', ci: true },
  license: { expr: 'p.license', ci: true },
  monthlyDownloads: { expr: 'p.downloads_monthly' },
  dependentsCount: { expr: 'p.dependents_count' },
  publishedAt: { expr: 'p.published_at' },
  keywords: (v, p) => (v.length ? `p.keywords @> ${p.add(lowerAll(v))}::text[]` : null),
  anyKeyword: (v, p) => (v.length ? `p.keywords && ${p.add(lowerAll(v))}::text[]` : null),
  maintainer: (v, p) => `p.maintainers @> ARRAY[${p.add(v)}::text]`,
  hasRepository: (v) => (v ? 'p.repo_full_name IS NOT NULL' : 'p.repo_full_name IS NULL'),
  dependsOn: (v, p) =>
    `EXISTS (SELECT 1 FROM dependencies d WHERE d.package_name = p.name AND d.dependency_name = ${p.add(v)})`,
};

function listPackages(ctx, args, scope) {
  const p = new Params();
  const where = [];
  if (scope) where.push(scope(p));
  const f = buildFilter(args.filter, PACKAGE_FILTER_FIELDS, p);
  if (f) where.push(f);

  let sortFields = { ...PACKAGE_SORT_FIELDS, RELEVANCE: PACKAGE_SORT_FIELDS.DOWNLOADS };
  let defaultSort = [{ field: 'DOWNLOADS', direction: 'DESC' }];
  const search = args.search?.trim();
  if (search) {
    if (search.length > 200) throw badInput('Search query is too long');
    const q = p.add(search);
    const like = p.add(`%${escapeLike(search)}%`);
    where.push(`(p.search @@ websearch_to_tsquery('simple', ${q}) OR p.name ILIKE ${like})`);
    // релевантность + небольшой бонус популярности (логарифм загрузок)
    sortFields = {
      ...PACKAGE_SORT_FIELDS,
      RELEVANCE: `(ts_rank(p.search, websearch_to_tsquery('simple', ${q}))::float8
                   + CASE WHEN p.name ILIKE ${like} THEN 1 ELSE 0 END
                   + ln(p.downloads_monthly + 1) / 20)`,
    };
    defaultSort = [{ field: 'RELEVANCE', direction: 'DESC' }];
  }

  return paginate({
    db: ctx.db,
    cache: ctx.cache,
    cacheKey: 'package-count',
    from: 'packages p',
    select: PACKAGE_COLUMNS,
    where,
    params: p,
    sort: resolveSort(args.sort, sortFields, defaultSort),
    idExpr: 'p.name',
    first: args.first,
    after: args.after,
    last: args.last,
    before: args.before,
    mapRow: mapPackage,
  });
}

const count = (db, sql) => db.query(sql).then((r) => r.rows[0].c);

const resolvers = {
  DateTime,

  Query: {
    package: (_, { name }, ctx) => ctx.loaders.packageByName.load(name),
    packages: (_, args, ctx) => listPackages(ctx, args),
    maintainer: async (_, { name }, { db }) => {
      const { rows } = await db.query('SELECT * FROM maintainers WHERE name = $1', [name]);
      return rows[0] ? mapMaintainer(rows[0]) : null;
    },
    maintainers: (_, args, ctx) => {
      const p = new Params();
      const where = [];
      if (args.search?.trim()) where.push(`m.name ILIKE ${p.add(`%${escapeLike(args.search.trim())}%`)}`);
      return paginate({
        db: ctx.db,
        cache: ctx.cache,
        cacheKey: 'maintainer-count',
        from: 'maintainers m',
        select: 'm.*',
        where,
        params: p,
        sort: resolveSort(
          args.sort ? [args.sort] : null,
          { TOTAL_DOWNLOADS: 'm.total_downloads', PACKAGE_COUNT: 'm.package_count', NAME: 'lower(m.name)' },
          [{ field: 'TOTAL_DOWNLOADS', direction: 'DESC' }],
        ),
        idExpr: 'm.name',
        first: args.first,
        after: args.after,
        mapRow: mapMaintainer,
      });
    },
    packageStats: () => ({}),
    packageSyncRuns: (_, { limit }, { db }) => listSyncRuns(db, limit),
  },

  Mutation: {
    syncPackages: (_, __, { db, queue, redis }) => requestSync({ db, queue, redis, source: SOURCE }),
  },

  Package: {
    __resolveReference: (ref, ctx) => (ref.npmUrl ? ref : ctx.loaders.packageByName.load(ref.name)),
    publisher: (pkg, _, ctx) => (pkg.publisherName ? ctx.loaders.maintainerByName.load(pkg.publisherName) : null),
    maintainers: (pkg, _, ctx) => ctx.loaders.maintainerByName.loadMany(pkg.maintainerNames),
    repository: (pkg) => (pkg.repoFullName ? { __typename: 'Repository', fullName: pkg.repoFullName } : null),
    dependencies: async (pkg, { kind }, ctx) => {
      const deps = await ctx.loaders.dependenciesByPackage.load(pkg.name);
      return kind ? deps.filter((d) => d.kind === kind) : deps;
    },
    dependents: (pkg, args, ctx) =>
      listPackages(
        ctx,
        args,
        (p) => `EXISTS (SELECT 1 FROM dependencies d WHERE d.package_name = p.name AND d.dependency_name = ${p.add(pkg.name)})`,
      ),
  },

  Dependency: {
    package: (dep, _, ctx) => ctx.loaders.packageByName.load(dep.name),
  },

  DependencyUsage: {
    package: (dep, _, ctx) => ctx.loaders.packageByName.load(dep.name),
  },

  Maintainer: {
    __resolveReference: (ref, ctx) => ctx.loaders.maintainerByName.load(ref.name),
    npmUrl: (m) => `https://www.npmjs.com/~${encodeURIComponent(m.name)}`,
    packages: (m, args, ctx) => listPackages(ctx, args, (p) => `p.maintainers @> ARRAY[${p.add(m.name)}::text]`),
  },

  Repository: {
    __resolveReference: (ref) => ({ fullName: ref.fullName }),
    packages: (repo, _, ctx) => ctx.loaders.packagesByRepo.load(repo.fullName.toLowerCase()),
  },

  Topic: {
    __resolveReference: (ref) => ({ name: ref.name }),
    packageCount: (topic, _, ctx) => ctx.loaders.packageCountByKeyword.load(topic.name.toLowerCase()),
    packages: async (topic, { first }, { db }) => {
      const { rows } = await db.query(
        `SELECT ${PACKAGE_COLUMNS} FROM packages p WHERE p.keywords @> ARRAY[$1::text]
          ORDER BY p.downloads_monthly DESC, p.name LIMIT $2`,
        [topic.name.toLowerCase(), Math.min(Math.max(first, 0), 50)],
      );
      return rows.map(mapPackage);
    },
  },

  PackageStats: {
    totalPackages: (_, __, { db, cache }) => cache.wrap('stats:packages', 300, () => count(db, 'SELECT count(*)::int c FROM packages')),
    totalMaintainers: (_, __, { db, cache }) =>
      cache.wrap('stats:maintainers', 300, () => count(db, 'SELECT count(*)::int c FROM maintainers')),
    totalDependencies: (_, __, { db, cache }) =>
      cache.wrap('stats:deps', 300, () => count(db, 'SELECT count(*)::int c FROM dependencies')),
    totalMonthlyDownloads: (_, __, { db, cache }) =>
      cache.wrap('stats:downloads', 300, async () =>
        Number((await db.query('SELECT coalesce(sum(downloads_monthly),0)::bigint s FROM packages')).rows[0].s),
      ),
    topKeywords: (_, { limit }, { db, cache }) =>
      cache.wrap(`stats:keywords:${limit}`, 300, async () => {
        const { rows } = await db.query(
          `SELECT k, count(*)::int AS c FROM packages, unnest(keywords) k GROUP BY k ORDER BY c DESC, k LIMIT $1`,
          [Math.min(Math.max(limit, 1), 200)],
        );
        return rows.map((r) => ({ keyword: r.k, packageCount: r.c }));
      }),
    byLicense: (_, { limit }, { db, cache }) =>
      cache.wrap(`stats:license:${limit}`, 300, async () => {
        const { rows } = await db.query(
          `SELECT coalesce(license, 'UNKNOWN') AS l, count(*)::int AS c FROM packages GROUP BY 1 ORDER BY c DESC LIMIT $1`,
          [Math.min(Math.max(limit, 1), 100)],
        );
        return rows.map((r) => ({ license: r.l, packageCount: r.c }));
      }),
    mostDependedUpon: (_, { limit }, { db, cache }) =>
      cache.wrap(`stats:most-deps:${limit}`, 300, async () => {
        const { rows } = await db.query(
          `SELECT dependency_name, count(*)::int AS c FROM dependencies
            WHERE kind = 'PROD' GROUP BY dependency_name ORDER BY c DESC, dependency_name LIMIT $1`,
          [Math.min(Math.max(limit, 1), 100)],
        );
        return rows.map((r) => ({ name: r.dependency_name, dependentCount: r.c }));
      }),
    publishedByYear: (_, __, { db, cache }) =>
      cache.wrap('stats:years', 300, async () => {
        const { rows } = await db.query(
          `SELECT extract(year FROM published_at)::int AS y, count(*)::int AS c FROM packages
            WHERE published_at > 'epoch' GROUP BY 1 ORDER BY 1`,
        );
        return rows.map((r) => ({ year: r.y, count: r.c }));
      }),
  },
};

module.exports = { resolvers };
