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
const { mapStory, mapComment, mapAuthor, STORY_COLUMNS, COMMENT_COLUMNS } = require('./loaders');

const SOURCE = 'news';

const STORY_SORT_FIELDS = {
  POINTS: 's.points',
  COMMENTS: 's.num_comments',
  CREATED_AT: 's.created_at',
};

const STORY_FILTER_FIELDS = {
  author: { expr: 's.author', ci: true },
  domain: { expr: 's.domain', ci: true },
  title: { expr: 's.title', ci: true },
  points: { expr: 's.points' },
  commentCount: { expr: 's.num_comments' },
  createdAt: { expr: 's.created_at' },
  type: (value, p) => (value.length ? `s.story_type = ANY(${p.add(value)})` : null),
  hasRepository: (value) => (value ? 's.repo_full_name IS NOT NULL' : 's.repo_full_name IS NULL'),
};

function listStories(ctx, args, scope) {
  const p = new Params();
  const where = [];
  if (scope) where.push(scope(p));
  const f = buildFilter(args.filter, STORY_FILTER_FIELDS, p);
  if (f) where.push(f);

  let sortFields = { ...STORY_SORT_FIELDS, RELEVANCE: STORY_SORT_FIELDS.POINTS };
  let defaultSort = [{ field: 'POINTS', direction: 'DESC' }];
  const search = args.search?.trim();
  if (search) {
    if (search.length > 200) throw badInput('Search query is too long');
    const q = p.add(search);
    where.push(`s.search @@ websearch_to_tsquery('english', ${q})`);
    sortFields = { ...STORY_SORT_FIELDS, RELEVANCE: `ts_rank(s.search, websearch_to_tsquery('english', ${q}))::float8` };
    defaultSort = [{ field: 'RELEVANCE', direction: 'DESC' }];
  }

  return paginate({
    db: ctx.db,
    cache: ctx.cache,
    cacheKey: 'story-count',
    from: 'stories s',
    select: STORY_COLUMNS,
    where,
    params: p,
    sort: resolveSort(args.sort, sortFields, defaultSort),
    idExpr: 's.id',
    first: args.first,
    after: args.after,
    last: args.last,
    before: args.before,
    mapRow: mapStory,
  });
}

function listComments(ctx, args, scope, direction = 'ASC') {
  const p = new Params();
  const where = [scope(p)];
  return paginate({
    db: ctx.db,
    cache: ctx.cache,
    cacheKey: 'comment-count',
    from: 'comments c',
    select: COMMENT_COLUMNS,
    where,
    params: p,
    sort: [{ expr: 'c.created_at', direction }],
    idExpr: 'c.id',
    first: args.first,
    after: args.after,
    mapRow: mapComment,
  });
}

const count = (db, sql) => db.query(sql).then((r) => r.rows[0].c);

const resolvers = {
  DateTime,

  Query: {
    story: (_, { id }, ctx) => (/^\d+$/.test(id) ? ctx.loaders.storyById.load(id) : null),
    stories: (_, args, ctx) => listStories(ctx, args),
    comment: (_, { id }, ctx) => (/^\d+$/.test(id) ? ctx.loaders.commentById.load(id) : null),
    comments: (_, args, ctx) => {
      const search = args.search.trim();
      if (search.length < 3) throw badInput('Search query must be at least 3 characters');
      return listComments(
        ctx,
        args,
        (p) =>
          [
            `c.text ILIKE ${p.add(`%${escapeLike(search)}%`)}`,
            args.author ? `c.author = ${p.add(args.author)}` : null,
          ]
            .filter(Boolean)
            .join(' AND '),
        'DESC',
      );
    },
    author: async (_, { name }, { db }) => {
      const { rows } = await db.query('SELECT * FROM authors WHERE name = $1', [name]);
      return rows[0] ? mapAuthor(rows[0]) : null;
    },
    authors: (_, args, ctx) => {
      const p = new Params();
      const where = [];
      if (args.search?.trim()) where.push(`a.name ILIKE ${p.add(`%${escapeLike(args.search.trim())}%`)}`);
      return paginate({
        db: ctx.db,
        cache: ctx.cache,
        cacheKey: 'author-count',
        from: 'authors a',
        select: 'a.*',
        where,
        params: p,
        sort: resolveSort(
          args.sort ? [args.sort] : null,
          {
            TOTAL_POINTS: 'a.total_points',
            STORY_COUNT: 'a.story_count',
            COMMENT_COUNT: 'a.comment_count',
            NAME: 'lower(a.name)',
          },
          [{ field: 'TOTAL_POINTS', direction: 'DESC' }],
        ),
        idExpr: 'a.name',
        first: args.first,
        after: args.after,
        last: args.last,
        before: args.before,
        mapRow: mapAuthor,
      });
    },
    newsStats: () => ({}),
    newsSyncRuns: (_, { limit }, { db }) => listSyncRuns(db, limit),
  },

  Mutation: {
    syncNews: (_, __, { db, queue, redis }) => requestSync({ db, queue, redis, source: SOURCE }),
  },

  Story: {
    __resolveReference: (ref, ctx) => (ref.title ? ref : ctx.loaders.storyById.load(ref.id)),
    author: (s, _, ctx) => ctx.loaders.authorByName.load(s.authorName),
    // Ссылка на сущность другого подграфа: шлюз дорезолвит её в подграфе repos
    repository: (s) => (s.repoFullName ? { __typename: 'Repository', fullName: s.repoFullName } : null),
    comments: (s, args, ctx) =>
      listComments(ctx, args, (p) => `c.story_id = ${p.add(s.id)} AND c.parent_id IS NULL`, args.sort === 'NEWEST' ? 'DESC' : 'ASC'),
    storedCommentCount: (s, _, ctx) => ctx.loaders.storedCommentCount.load(s.id),
  },

  Comment: {
    __resolveReference: (ref, ctx) => ctx.loaders.commentById.load(ref.id),
    author: (c, _, ctx) => ctx.loaders.authorByName.load(c.authorName),
    story: (c, _, ctx) => ctx.loaders.storyById.load(c.storyId),
    parent: (c, _, ctx) => (c.parentId ? ctx.loaders.commentById.load(c.parentId) : null),
    replyCount: (c, _, ctx) => ctx.loaders.replyCount.load(c.id),
    replies: (c, { first }, ctx) => ctx.loaders.repliesByParent.load(`${c.id}:${Math.min(Math.max(first, 0), 100)}`),
  },

  Author: {
    __resolveReference: (ref, ctx) => ctx.loaders.authorByName.load(ref.name),
    hnUrl: (a) => `https://news.ycombinator.com/user?id=${encodeURIComponent(a.name)}`,
    stories: (a, args, ctx) => listStories(ctx, args, (p) => `s.author = ${p.add(a.name)}`),
    comments: (a, args, ctx) => listComments(ctx, args, (p) => `c.author = ${p.add(a.name)}`, 'DESC'),
  },

  Repository: {
    __resolveReference: (ref) => ({ fullName: ref.fullName }),
    hnMentions: (repo, _, ctx) => ctx.loaders.mentionsByRepo.load(repo.fullName.toLowerCase()),
    relatedStories: async (repo, { first, sort }, { db }) => {
      const sortSql = resolveSort(sort, STORY_SORT_FIELDS, [{ field: 'POINTS', direction: 'DESC' }])
        .map((s) => `${s.expr} ${s.direction}`)
        .join(', ');
      const { rows } = await db.query(
        `SELECT ${STORY_COLUMNS} FROM stories s WHERE s.repo_full_name = $1 ORDER BY ${sortSql}, s.id LIMIT $2`,
        [repo.fullName.toLowerCase(), Math.min(Math.max(first, 0), 50)],
      );
      return rows.map(mapStory);
    },
  },

  Topic: {
    __resolveReference: (ref) => ({ name: ref.name }),
    stories: (topic, { first }, { db, cache }) =>
      cache.wrap(`topic-stories:${topic.name}:${first}`, 600, async () => {
        const term = topic.name.replace(/-/g, ' ');
        const { rows } = await db.query(
          `SELECT ${STORY_COLUMNS} FROM stories s
            WHERE s.search @@ phraseto_tsquery('english', $1)
            ORDER BY s.points DESC, s.id LIMIT $2`,
          [term, Math.min(Math.max(first, 0), 50)],
        );
        return rows.map(mapStory);
      }),
  },

  NewsStats: {
    totalStories: (_, __, { db, cache }) => cache.wrap('stats:stories', 300, () => count(db, 'SELECT count(*)::int c FROM stories')),
    totalComments: (_, __, { db, cache }) =>
      cache.wrap('stats:comments', 300, () => count(db, 'SELECT count(*)::int c FROM comments')),
    totalAuthors: (_, __, { db, cache }) => cache.wrap('stats:authors', 300, () => count(db, 'SELECT count(*)::int c FROM authors')),
    storiesWithRepository: (_, __, { db, cache }) =>
      cache.wrap('stats:with-repo', 300, () =>
        count(db, 'SELECT count(*)::int c FROM stories WHERE repo_full_name IS NOT NULL'),
      ),
    topDomains: (_, { limit }, { db, cache }) =>
      cache.wrap(`stats:domains:${limit}`, 300, async () => {
        const { rows } = await db.query(
          `SELECT domain, count(*)::int AS c, sum(points)::int AS p FROM stories
            WHERE domain IS NOT NULL GROUP BY domain ORDER BY c DESC LIMIT $1`,
          [Math.min(Math.max(limit, 1), 100)],
        );
        return rows.map((r) => ({ domain: r.domain, storyCount: r.c, totalPoints: r.p }));
      }),
    storiesByYear: (_, __, { db, cache }) =>
      cache.wrap('stats:years', 300, async () => {
        const { rows } = await db.query(
          'SELECT extract(year FROM created_at)::int AS y, count(*)::int AS c FROM stories GROUP BY 1 ORDER BY 1',
        );
        return rows.map((r) => ({ year: r.y, count: r.c }));
      }),
  },
};

module.exports = { resolvers };
