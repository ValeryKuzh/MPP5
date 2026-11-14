'use strict';

const DataLoader = require('dataloader');

/**
 * DataLoader'ы создаются на каждый запрос: они объединяют N обращений
 * к связанным объектам в один SQL-запрос (решение проблемы N+1) и
 * кэшируют результат в пределах запроса.
 */

const REPO_COLUMNS = `r.id, r.full_name, r.name, r.owner_id, r.description, r.homepage, r.html_url, r.language,
  r.license, r.stars, r.forks, r.open_issues, r.size_kb, r.archived, r.is_fork, r.created_at, r.pushed_at`;

const mapRepo = (r) => ({
  id: String(r.id),
  fullName: r.full_name,
  name: r.name,
  ownerId: String(r.owner_id),
  description: r.description,
  homepage: r.homepage || null,
  url: r.html_url,
  language: r.language,
  license: r.license,
  stars: r.stars,
  forks: r.forks,
  openIssues: r.open_issues,
  sizeKb: r.size_kb,
  archived: r.archived,
  isFork: r.is_fork,
  createdAt: r.created_at,
  pushedAt: r.pushed_at,
});

const mapOwner = (o) => ({
  id: String(o.id),
  login: o.login,
  type: o.type === 'Organization' ? 'ORGANIZATION' : 'USER',
  avatarUrl: o.avatar_url,
  url: o.html_url,
  repositoryCount: o.repo_count,
  totalStars: Number(o.total_stars),
});

const mapCollection = (c) => ({
  id: String(c.id),
  name: c.name,
  description: c.description,
  createdAt: c.created_at,
  updatedAt: c.updated_at,
});

function createLoaders(db) {
  const byKey = (rows, keys, keyFn) => {
    const map = new Map(rows.map((r) => [keyFn(r), r]));
    return keys.map((k) => map.get(k) ?? null);
  };
  const groupBy = (rows, keys, keyFn, valueFn = (r) => r) => {
    const map = new Map(keys.map((k) => [k, []]));
    for (const r of rows) map.get(keyFn(r))?.push(valueFn(r));
    return keys.map((k) => map.get(k));
  };

  return {
    repoByFullName: new DataLoader(async (names) => {
      const { rows } = await db.query(
        `SELECT ${REPO_COLUMNS} FROM repositories r WHERE lower(r.full_name) = ANY($1)`,
        [names],
      );
      return byKey(rows.map(mapRepo), names, (r) => r.fullName.toLowerCase());
    }),

    repoById: new DataLoader(async (ids) => {
      const { rows } = await db.query(`SELECT ${REPO_COLUMNS} FROM repositories r WHERE r.id = ANY($1::bigint[])`, [ids]);
      return byKey(rows.map(mapRepo), ids, (r) => r.id);
    }),

    ownerById: new DataLoader(async (ids) => {
      const { rows } = await db.query('SELECT * FROM owners WHERE id = ANY($1::bigint[])', [ids]);
      return byKey(rows.map(mapOwner), ids, (o) => o.id);
    }),

    ownerByLogin: new DataLoader(async (logins) => {
      const { rows } = await db.query('SELECT * FROM owners WHERE lower(login) = ANY($1)', [logins]);
      return byKey(rows.map(mapOwner), logins, (o) => o.login.toLowerCase());
    }),

    topicsByRepoId: new DataLoader(async (ids) => {
      const { rows } = await db.query(
        `SELECT rt.repository_id::text AS rid, t.name, t.repo_count
           FROM repository_topics rt JOIN topics t ON t.name = rt.topic
          WHERE rt.repository_id = ANY($1::bigint[])
          ORDER BY t.repo_count DESC`,
        [ids],
      );
      return groupBy(rows, ids, (r) => r.rid, (r) => ({ name: r.name, repositoryCount: r.repo_count }));
    }),

    topicByName: new DataLoader(async (names) => {
      const { rows } = await db.query('SELECT name, repo_count FROM topics WHERE name = ANY($1)', [names]);
      return byKey(
        rows.map((t) => ({ name: t.name, repositoryCount: t.repo_count })),
        names,
        (t) => t.name,
      );
    }),

    collectionsByRepoId: new DataLoader(async (ids) => {
      const { rows } = await db.query(
        `SELECT ci.repository_id::text AS rid, c.*
           FROM collection_items ci JOIN collections c ON c.id = ci.collection_id
          WHERE ci.repository_id = ANY($1::bigint[]) ORDER BY c.name`,
        [ids],
      );
      return groupBy(rows, ids, (r) => r.rid, mapCollection);
    }),

    collectionItemCount: new DataLoader(async (ids) => {
      const { rows } = await db.query(
        `SELECT collection_id::text AS cid, count(*)::int AS c FROM collection_items
          WHERE collection_id = ANY($1::int[]) GROUP BY collection_id`,
        [ids],
      );
      const map = new Map(rows.map((r) => [r.cid, r.c]));
      return ids.map((id) => map.get(id) ?? 0);
    }),
  };
}

module.exports = { createLoaders, mapRepo, mapOwner, mapCollection, REPO_COLUMNS };
