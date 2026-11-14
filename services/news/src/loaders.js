'use strict';

const DataLoader = require('dataloader');

const STORY_COLUMNS = `s.id, s.title, s.url, s.domain, s.author, s.points, s.num_comments, s.created_at,
  s.story_type, s.repo_full_name, s.text`;
const COMMENT_COLUMNS = 'c.id, c.story_id, c.parent_id, c.author, c.text, c.created_at, c.depth';

const mapStory = (s) => ({
  id: String(s.id),
  title: s.title,
  url: s.url,
  domain: s.domain,
  hnUrl: `https://news.ycombinator.com/item?id=${s.id}`,
  authorName: s.author,
  points: s.points,
  commentCount: s.num_comments,
  createdAt: s.created_at,
  type: s.story_type,
  text: s.text,
  repoFullName: s.repo_full_name,
});

const mapComment = (c) => ({
  id: String(c.id),
  storyId: String(c.story_id),
  parentId: c.parent_id ? String(c.parent_id) : null,
  authorName: c.author,
  text: c.text,
  createdAt: c.created_at,
  depth: c.depth,
});

const mapAuthor = (a) => ({
  name: a.name,
  storyCount: a.story_count,
  commentCount: a.comment_count,
  totalPoints: Number(a.total_points),
});

function createLoaders(db) {
  const byKey = (rows, keys, keyFn) => {
    const map = new Map(rows.map((r) => [keyFn(r), r]));
    return keys.map((k) => map.get(k) ?? null);
  };

  return {
    storyById: new DataLoader(async (ids) => {
      const { rows } = await db.query(`SELECT ${STORY_COLUMNS} FROM stories s WHERE s.id = ANY($1::bigint[])`, [ids]);
      return byKey(rows.map(mapStory), ids, (s) => s.id);
    }),

    commentById: new DataLoader(async (ids) => {
      const { rows } = await db.query(`SELECT ${COMMENT_COLUMNS} FROM comments c WHERE c.id = ANY($1::bigint[])`, [ids]);
      return byKey(rows.map(mapComment), ids, (c) => c.id);
    }),

    authorByName: new DataLoader(async (names) => {
      const { rows } = await db.query('SELECT * FROM authors WHERE name = ANY($1)', [names]);
      return names.map((n) => {
        const a = rows.find((r) => r.name === n);
        return a ? mapAuthor(a) : { name: n, storyCount: 0, commentCount: 0, totalPoints: 0 };
      });
    }),

    /** Ответы на комментарии: ключ — "parentId:limit" (лимит на каждого родителя через оконную функцию). */
    repliesByParent: new DataLoader(async (keys) => {
      const parsed = keys.map((k) => k.split(':'));
      const ids = [...new Set(parsed.map(([id]) => id))];
      const limit = Math.max(...parsed.map(([, l]) => Number(l)));
      const { rows } = await db.query(
        `SELECT * FROM (
           SELECT ${COMMENT_COLUMNS}, row_number() OVER (PARTITION BY c.parent_id ORDER BY c.created_at, c.id) AS rn
             FROM comments c WHERE c.parent_id = ANY($1::bigint[])
         ) x WHERE rn <= $2`,
        [ids, limit],
      );
      return parsed.map(([id, l]) =>
        rows
          .filter((r) => String(r.parent_id) === id && Number(r.rn) <= Number(l))
          .map(mapComment),
      );
    }),

    replyCount: new DataLoader(async (ids) => {
      const { rows } = await db.query(
        `SELECT parent_id::text AS pid, count(*)::int AS c FROM comments WHERE parent_id = ANY($1::bigint[]) GROUP BY parent_id`,
        [ids],
      );
      const map = new Map(rows.map((r) => [r.pid, r.c]));
      return ids.map((id) => map.get(id) ?? 0);
    }),

    storedCommentCount: new DataLoader(async (ids) => {
      const { rows } = await db.query(
        `SELECT story_id::text AS sid, count(*)::int AS c FROM comments WHERE story_id = ANY($1::bigint[]) GROUP BY story_id`,
        [ids],
      );
      const map = new Map(rows.map((r) => [r.sid, r.c]));
      return ids.map((id) => map.get(id) ?? 0);
    }),

    /** Количество упоминаний репозитория (ключ — full_name в нижнем регистре). */
    mentionsByRepo: new DataLoader(async (names) => {
      const { rows } = await db.query(
        `SELECT repo_full_name AS n, count(*)::int AS c FROM stories WHERE repo_full_name = ANY($1) GROUP BY repo_full_name`,
        [names],
      );
      const map = new Map(rows.map((r) => [r.n, r.c]));
      return names.map((n) => map.get(n) ?? 0);
    }),
  };
}

module.exports = { createLoaders, mapStory, mapComment, mapAuthor, STORY_COLUMNS, COMMENT_COLUMNS };
