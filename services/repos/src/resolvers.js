'use strict';

const {
  Params,
  buildFilter,
  operatorSql,
  resolveSort,
  paginate,
  escapeLike,
  badInput,
  notFound,
  DateTime,
  requestSync,
  listSyncRuns,
} = require('@devpulse/common');
const { mapRepo, mapOwner, mapCollection, REPO_COLUMNS } = require('./loaders');

const SOURCE = 'repos';

const REPO_SORT_FIELDS = {
  STARS: 'r.stars',
  FORKS: 'r.forks',
  OPEN_ISSUES: 'r.open_issues',
  CREATED_AT: 'r.created_at',
  PUSHED_AT: 'r.pushed_at',
  NAME: 'lower(r.full_name)',
};

const lowerAll = (arr) => [...new Set(arr.map((s) => s.toLowerCase()))];

/** Белый список полей фильтра -> SQL. Поля-функции строят подзапросы. */
const REPO_FILTER_FIELDS = {
  language: { expr: 'r.language', ci: true },
  license: { expr: 'r.license', ci: true },
  stars: { expr: 'r.stars' },
  forks: { expr: 'r.forks' },
  openIssues: { expr: 'r.open_issues' },
  createdAt: { expr: 'r.created_at' },
  pushedAt: { expr: 'r.pushed_at' },
  archived: { expr: 'r.archived' },
  isFork: { expr: 'r.is_fork' },
  owner: (value, p) => {
    const cond = operatorSql({ expr: 'o.login', ci: true }, value, p);
    return cond && `r.owner_id IN (SELECT o.id FROM owners o WHERE ${cond})`;
  },
  topics: (value, p) => {
    const topics = lowerAll(value);
    if (!topics.length) return null;
    return `r.id IN (SELECT repository_id FROM repository_topics WHERE topic = ANY(${p.add(topics)})
                      GROUP BY repository_id HAVING count(*) = ${p.add(topics.length)})`;
  },
  anyTopic: (value, p) => {
    const topics = lowerAll(value);
    if (!topics.length) return null;
    return `EXISTS (SELECT 1 FROM repository_topics rt WHERE rt.repository_id = r.id AND rt.topic = ANY(${p.add(topics)}))`;
  },
};

/**
 * Универсальный список репозиториев. `scope` — дополнительное условие
 * (для вложенных связей Owner.repositories / Topic.repositories).
 */
function listRepositories(ctx, args, scope) {
  const p = new Params();
  const where = [];
  if (scope) where.push(scope(p));
  const filterSql = buildFilter(args.filter, REPO_FILTER_FIELDS, p);
  if (filterSql) where.push(filterSql);

  let sortFields = REPO_SORT_FIELDS;
  let defaultSort = [{ field: 'STARS', direction: 'DESC' }];
  const search = args.search?.trim();
  if (search) {
    if (search.length > 200) throw badInput('Search query is too long');
    const q = p.add(search);
    const like = p.add(`%${escapeLike(search)}%`);
    where.push(`(r.search @@ websearch_to_tsquery('english', ${q}) OR r.full_name ILIKE ${like})`);
    sortFields = {
      ...REPO_SORT_FIELDS,
      RELEVANCE: `(ts_rank(r.search, websearch_to_tsquery('english', ${q}))::float8
                  + CASE WHEN r.full_name ILIKE ${like} THEN 1 ELSE 0 END)`,
    };
    defaultSort = [{ field: 'RELEVANCE', direction: 'DESC' }, { field: 'STARS', direction: 'DESC' }];
  } else {
    sortFields = { ...REPO_SORT_FIELDS, RELEVANCE: REPO_SORT_FIELDS.STARS };
  }

  return paginate({
    db: ctx.db,
    cache: ctx.cache,
    cacheKey: 'repo-count',
    from: 'repositories r',
    select: REPO_COLUMNS,
    where,
    params: p,
    sort: resolveSort(args.sort, sortFields, defaultSort),
    idExpr: 'r.id',
    first: args.first,
    after: args.after,
    last: args.last,
    before: args.before,
    mapRow: mapRepo,
  });
}

function validateName(name) {
  const v = name?.trim();
  if (!v || v.length > 100) throw badInput('Collection name must be 1..100 characters');
  return v;
}

async function loadCollection(db, id) {
  const { rows } = await db.query('SELECT * FROM collections WHERE id = $1', [Number(id) || 0]);
  if (!rows[0]) throw notFound(`Collection ${id}`);
  return mapCollection(rows[0]);
}

async function repoIdByName(ctx, fullName) {
  const repo = await ctx.loaders.repoByFullName.load(fullName.toLowerCase());
  if (!repo) throw notFound(`Repository ${fullName}`);
  return repo.id;
}

const resolvers = {
  DateTime,

  Query: {
    repository: (_, { fullName }, ctx) => ctx.loaders.repoByFullName.load(fullName.toLowerCase()),
    repositories: (_, args, ctx) => listRepositories(ctx, args),

    owner: (_, { login }, ctx) => ctx.loaders.ownerByLogin.load(login.toLowerCase()),
    owners: (_, args, ctx) => {
      const p = new Params();
      const where = [];
      if (args.search?.trim()) where.push(`o.login ILIKE ${p.add(`%${escapeLike(args.search.trim())}%`)}`);
      if (args.type) where.push(`o.type = ${p.add(args.type === 'ORGANIZATION' ? 'Organization' : 'User')}`);
      return paginate({
        db: ctx.db,
        cache: ctx.cache,
        cacheKey: 'owner-count',
        from: 'owners o',
        select: 'o.*',
        where,
        params: p,
        sort: resolveSort(
          args.sort ? [args.sort] : null,
          { TOTAL_STARS: 'o.total_stars', REPOSITORY_COUNT: 'o.repo_count', LOGIN: 'lower(o.login)' },
          [{ field: 'TOTAL_STARS', direction: 'DESC' }],
        ),
        idExpr: 'o.id',
        first: args.first,
        after: args.after,
        last: args.last,
        before: args.before,
        mapRow: mapOwner,
      });
    },

    topic: (_, { name }, ctx) => ctx.loaders.topicByName.load(name.toLowerCase()),
    topics: (_, { first = 50, search, minRepositories }, ctx) =>
      ctx.cache.wrap(`topics:${first}:${search || ''}:${minRepositories || 0}`, 300, async () => {
        const p = new Params();
        const where = [`repo_count >= ${p.add(minRepositories ?? 1)}`];
        if (search?.trim()) where.push(`name ILIKE ${p.add(`%${escapeLike(search.trim().toLowerCase())}%`)}`);
        const { rows } = await ctx.db.query(
          `SELECT name, repo_count FROM topics WHERE ${where.join(' AND ')}
            ORDER BY repo_count DESC, name LIMIT ${Math.min(Math.max(first, 1), 500)}`,
          p.values,
        );
        return rows.map((t) => ({ name: t.name, repositoryCount: t.repo_count }));
      }),

    languages: (_, __, ctx) =>
      ctx.cache.wrap('languages', 600, async () => {
        const { rows } = await ctx.db.query(
          `SELECT language FROM repositories WHERE language IS NOT NULL GROUP BY language ORDER BY count(*) DESC`,
        );
        return rows.map((r) => r.language);
      }),

    // Каждое поле статистики считается лениво — только если его запросили
    repositoryStats: () => ({}),

    collections: async (_, __, { db }) => {
      const { rows } = await db.query('SELECT * FROM collections ORDER BY updated_at DESC');
      return rows.map(mapCollection);
    },
    collection: async (_, { id }, { db }) => {
      const { rows } = await db.query('SELECT * FROM collections WHERE id = $1', [Number(id) || 0]);
      return rows[0] ? mapCollection(rows[0]) : null;
    },

    repositorySyncRuns: (_, { limit }, { db }) => listSyncRuns(db, limit),
  },

  Mutation: {
    createCollection: async (_, { input }, { db }) => {
      const { rows } = await db.query('INSERT INTO collections (name, description) VALUES ($1, $2) RETURNING *', [
        validateName(input.name),
        input.description?.slice(0, 1000) ?? null,
      ]);
      return mapCollection(rows[0]);
    },
    updateCollection: async (_, { id, input }, { db }) => {
      await loadCollection(db, id);
      const { rows } = await db.query(
        `UPDATE collections SET name = COALESCE($2, name), description = COALESCE($3, description), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [Number(id), input.name != null ? validateName(input.name) : null, input.description?.slice(0, 1000) ?? null],
      );
      return mapCollection(rows[0]);
    },
    deleteCollection: async (_, { id }, { db }) => {
      const { rowCount } = await db.query('DELETE FROM collections WHERE id = $1', [Number(id) || 0]);
      return rowCount > 0;
    },
    addToCollection: async (_, { collectionId, fullName, note }, ctx) => {
      await loadCollection(ctx.db, collectionId);
      const repoId = await repoIdByName(ctx, fullName);
      await ctx.db.tx(async (client) => {
        await client.query(
          `INSERT INTO collection_items (collection_id, repository_id, note) VALUES ($1, $2, $3)
           ON CONFLICT (collection_id, repository_id) DO UPDATE SET note = EXCLUDED.note`,
          [Number(collectionId), repoId, note?.slice(0, 500) ?? null],
        );
        await client.query('UPDATE collections SET updated_at = now() WHERE id = $1', [Number(collectionId)]);
      });
      return loadCollection(ctx.db, collectionId);
    },
    removeFromCollection: async (_, { collectionId, fullName }, ctx) => {
      await loadCollection(ctx.db, collectionId);
      const repoId = await repoIdByName(ctx, fullName);
      await ctx.db.query('DELETE FROM collection_items WHERE collection_id = $1 AND repository_id = $2', [
        Number(collectionId),
        repoId,
      ]);
      await ctx.db.query('UPDATE collections SET updated_at = now() WHERE id = $1', [Number(collectionId)]);
      return loadCollection(ctx.db, collectionId);
    },
    syncRepositories: (_, __, { db, queue, redis }) => requestSync({ db, queue, redis, source: SOURCE }),
  },

  Repository: {
    // Точка входа федерации: шлюз передаёт { fullName } из других подграфов
    __resolveReference: (ref, ctx) => (ref.id ? ref : ctx.loaders.repoByFullName.load(ref.fullName.toLowerCase())),
    owner: (repo, _, ctx) => ctx.loaders.ownerById.load(repo.ownerId),
    topics: (repo, _, ctx) => ctx.loaders.topicsByRepoId.load(repo.id),
    similar: async (repo, { first }, { db }) => {
      const { rows } = await db.query(
        `SELECT ${REPO_COLUMNS}
           FROM repository_topics t1
           JOIN repository_topics t2 ON t2.topic = t1.topic AND t2.repository_id <> t1.repository_id
           JOIN repositories r ON r.id = t2.repository_id
          WHERE t1.repository_id = $1
          GROUP BY r.id
          ORDER BY count(*) DESC, r.stars DESC
          LIMIT $2`,
        [repo.id, Math.min(Math.max(first, 0), 50)],
      );
      return rows.map(mapRepo);
    },
    collections: (repo, _, ctx) => ctx.loaders.collectionsByRepoId.load(repo.id),
  },

  Owner: {
    __resolveReference: (ref, ctx) => (ref.id ? ref : ctx.loaders.ownerByLogin.load(ref.login.toLowerCase())),
    repositories: (owner, args, ctx) => listRepositories(ctx, args, (p) => `r.owner_id = ${p.add(owner.id)}`),
  },

  Topic: {
    __resolveReference: async (ref, ctx) =>
      (await ctx.loaders.topicByName.load(ref.name.toLowerCase())) ?? { name: ref.name, repositoryCount: 0 },
    repositoryCount: async (topic, _, ctx) =>
      topic.repositoryCount ?? (await ctx.loaders.topicByName.load(topic.name))?.repositoryCount ?? 0,
    repositories: (topic, args, ctx) =>
      listRepositories(
        ctx,
        args,
        (p) => `EXISTS (SELECT 1 FROM repository_topics rt WHERE rt.repository_id = r.id AND rt.topic = ${p.add(topic.name)})`,
      ),
    related: (topic, { first }, ctx) =>
      ctx.cache.wrap(`related:${topic.name}:${first}`, 600, async () => {
        const { rows } = await ctx.db.query(
          `SELECT t2.topic AS name, count(*)::int AS c
             FROM repository_topics t1
             JOIN repository_topics t2 ON t2.repository_id = t1.repository_id AND t2.topic <> t1.topic
            WHERE t1.topic = $1
            GROUP BY t2.topic ORDER BY c DESC, t2.topic LIMIT $2`,
          [topic.name, Math.min(Math.max(first, 1), 50)],
        );
        return rows.map((r) => ({ topic: { name: r.name }, count: r.c }));
      }),
  },

  RepositoryStats: {
    totalRepositories: (_, __, { db, cache }) =>
      cache.wrap('stats:repos', 300, async () => (await db.query('SELECT count(*)::int c FROM repositories')).rows[0].c),
    totalOwners: (_, __, { db, cache }) =>
      cache.wrap('stats:owners', 300, async () => (await db.query('SELECT count(*)::int c FROM owners')).rows[0].c),
    totalTopics: (_, __, { db, cache }) =>
      cache.wrap('stats:topics', 300, async () => (await db.query('SELECT count(*)::int c FROM topics')).rows[0].c),
    totalStars: (_, __, { db, cache }) =>
      cache.wrap('stats:stars', 300, async () =>
        Number((await db.query('SELECT coalesce(sum(stars),0)::bigint s FROM repositories')).rows[0].s),
      ),
    byLanguage: (_, { limit }, { db, cache }) =>
      cache.wrap(`stats:lang:${limit}`, 300, async () => {
        const { rows } = await db.query(
          `SELECT language, count(*)::int AS c, sum(stars)::bigint AS s, avg(stars)::float8 AS a
             FROM repositories WHERE language IS NOT NULL
            GROUP BY language ORDER BY c DESC LIMIT $1`,
          [Math.min(Math.max(limit, 1), 100)],
        );
        return rows.map((r) => ({ language: r.language, repositoryCount: r.c, totalStars: Number(r.s), avgStars: r.a }));
      }),
    byLicense: (_, { limit }, { db, cache }) =>
      cache.wrap(`stats:license:${limit}`, 300, async () => {
        const { rows } = await db.query(
          `SELECT coalesce(license, 'NONE') AS license, count(*)::int AS c
             FROM repositories GROUP BY 1 ORDER BY c DESC LIMIT $1`,
          [Math.min(Math.max(limit, 1), 100)],
        );
        return rows.map((r) => ({ license: r.license, repositoryCount: r.c }));
      }),
    createdByYear: (_, __, { db, cache }) =>
      cache.wrap('stats:years', 300, async () => {
        const { rows } = await db.query(
          `SELECT extract(year FROM created_at)::int AS y, count(*)::int AS c
             FROM repositories WHERE created_at > 'epoch' GROUP BY 1 ORDER BY 1`,
        );
        return rows.map((r) => ({ year: r.y, count: r.c }));
      }),
  },

  Collection: {
    itemCount: (c, _, ctx) => ctx.loaders.collectionItemCount.load(c.id),
    items: async (c, _, { db }) => {
      const { rows } = await db.query(
        `SELECT ${REPO_COLUMNS}, ci.note, ci.added_at
           FROM collection_items ci JOIN repositories r ON r.id = ci.repository_id
          WHERE ci.collection_id = $1 ORDER BY ci.added_at DESC`,
        [Number(c.id)],
      );
      return rows.map((row) => ({ repository: mapRepo(row), note: row.note, addedAt: row.added_at }));
    },
  },
};

module.exports = { resolvers };
