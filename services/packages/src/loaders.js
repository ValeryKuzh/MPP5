'use strict';

const DataLoader = require('dataloader');

const PACKAGE_COLUMNS = `p.name, p.version, p.description, p.keywords, p.license, p.homepage, p.repository_url,
  p.repo_full_name, p.publisher, p.maintainers, p.published_at, p.downloads_monthly, p.downloads_weekly,
  p.dependents_count, p.score`;

const mapPackage = (p) => ({
  name: p.name,
  version: p.version,
  description: p.description,
  keywords: p.keywords || [],
  license: p.license,
  homepage: p.homepage,
  npmUrl: `https://www.npmjs.com/package/${p.name}`,
  repositoryUrl: p.repository_url,
  repoFullName: p.repo_full_name,
  publishedAt: p.published_at,
  monthlyDownloads: Number(p.downloads_monthly),
  weeklyDownloads: Number(p.downloads_weekly),
  dependentsCount: p.dependents_count,
  score: p.score,
  publisherName: p.publisher,
  maintainerNames: p.maintainers || [],
});

const mapMaintainer = (m) => ({
  name: m.name,
  packageCount: m.package_count,
  totalDownloads: Number(m.total_downloads),
});

const mapDependency = (d) => ({
  name: d.dependency_name,
  versionRange: d.version_range,
  kind: d.kind,
});

function createLoaders(db) {
  const byKey = (rows, keys, keyFn) => {
    const map = new Map(rows.map((r) => [keyFn(r), r]));
    return keys.map((k) => map.get(k) ?? null);
  };

  return {
    packageByName: new DataLoader(async (names) => {
      const { rows } = await db.query(`SELECT ${PACKAGE_COLUMNS} FROM packages p WHERE p.name = ANY($1)`, [names]);
      return byKey(rows.map(mapPackage), names, (p) => p.name);
    }),

    maintainerByName: new DataLoader(async (names) => {
      const { rows } = await db.query('SELECT * FROM maintainers WHERE name = ANY($1)', [names]);
      const map = new Map(rows.map((r) => [r.name, mapMaintainer(r)]));
      return names.map((n) => map.get(n) ?? { name: n, packageCount: 0, totalDownloads: 0 });
    }),

    dependenciesByPackage: new DataLoader(async (names) => {
      const { rows } = await db.query(
        `SELECT * FROM dependencies WHERE package_name = ANY($1) ORDER BY kind, dependency_name`,
        [names],
      );
      const map = new Map(names.map((n) => [n, []]));
      for (const r of rows) map.get(r.package_name)?.push(mapDependency(r));
      return names.map((n) => map.get(n));
    }),

    packagesByRepo: new DataLoader(async (repos) => {
      const { rows } = await db.query(
        `SELECT ${PACKAGE_COLUMNS} FROM packages p WHERE p.repo_full_name = ANY($1) ORDER BY p.downloads_monthly DESC`,
        [repos],
      );
      const map = new Map(repos.map((r) => [r, []]));
      for (const r of rows) map.get(r.repo_full_name)?.push(mapPackage(r));
      return repos.map((r) => map.get(r));
    }),

    packageCountByKeyword: new DataLoader(async (keywords) => {
      const { rows } = await db.query(
        `SELECT k, count(*)::int AS c FROM packages p, unnest(p.keywords) k WHERE k = ANY($1) GROUP BY k`,
        [keywords],
      );
      const map = new Map(rows.map((r) => [r.k, r.c]));
      return keywords.map((k) => map.get(k) ?? 0);
    }),
  };
}

module.exports = { createLoaders, mapPackage, mapMaintainer, mapDependency, PACKAGE_COLUMNS };
