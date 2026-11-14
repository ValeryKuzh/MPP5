'use strict';

const {
  createHttpClient,
  metrics,
  int,
  uniqueBy,
  chunk,
  mapLimit,
  htmlToText,
  parseGithubRepo,
  hostOf,
} = require('@devpulse/common');

/**
 * Сбор данных Hacker News через Algolia HN Search API (https://hn.algolia.com/api).
 * Algolia отдаёт не более 1000 записей на запрос, поэтому применяется
 * "скользящее окно" по времени: каждый следующий запрос берёт записи старше
 * самой старой из уже полученных (numericFilters=created_at_i<T).
 * Деревья комментариев загружаются через /items/:id (вложенная структура).
 */

const PAGE = int('HN_PAGE_SIZE', 500);
// Только нужные поля, без подсветки — ответ в ~3 раза меньше
const TRIM =
  '&attributesToRetrieve=title,url,author,points,num_comments,created_at,created_at_i,story_text,_tags' +
  '&attributesToHighlight=none&attributesToSnippet=none';

const storyType = (tags = []) => (tags.includes('show_hn') ? 'SHOW_HN' : tags.includes('ask_hn') ? 'ASK_HN' : 'STORY');

async function saveStories(db, hits) {
  const rows = uniqueBy(
    hits.filter((h) => h.objectID && h.title && h.author),
    (h) => h.objectID,
  );
  if (!rows.length) return 0;
  await db.query(
    `INSERT INTO stories (id, title, url, domain, author, points, num_comments, created_at, story_type, repo_full_name, text)
     SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::int[],
                          $8::timestamptz[], $9::text[], $10::text[], $11::text[])
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, points = EXCLUDED.points,
       num_comments = EXCLUDED.num_comments, collected_at = now()`,
    [
      rows.map((h) => h.objectID),
      rows.map((h) => h.title),
      rows.map((h) => h.url || null),
      rows.map((h) => hostOf(h.url)),
      rows.map((h) => h.author),
      rows.map((h) => h.points ?? 0),
      rows.map((h) => h.num_comments ?? 0),
      rows.map((h) => h.created_at),
      rows.map((h) => storyType(h._tags)),
      rows.map((h) => parseGithubRepo(h.url) ?? parseGithubRepo(h.story_text)),
      rows.map((h) => htmlToText(h.story_text)?.slice(0, 20000) ?? null),
    ],
  );
  metrics.collectedRecords.inc({ source: 'hackernews', entity: 'story' }, rows.length);
  return rows.length;
}

/** Обход дерева комментариев в плоский список с глубиной. */
function flattenComments(item) {
  const out = [];
  const walk = (node, depth, parentId) => {
    for (const child of node.children || []) {
      if (child.type && child.type !== 'comment') continue;
      out.push({
        id: child.id,
        storyId: item.id,
        parentId,
        author: child.author || '[deleted]',
        text: htmlToText(child.text)?.slice(0, 20000) ?? null,
        createdAt: child.created_at,
        depth,
      });
      walk(child, depth + 1, child.id);
    }
  };
  walk(item, 0, null);
  return out;
}

async function saveComments(db, storyId, comments) {
  await db.tx(async (c) => {
    for (const part of chunk(comments, 2000)) {
      await c.query(
        `INSERT INTO comments (id, story_id, parent_id, author, text, created_at, depth)
         SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::bigint[], $4::text[], $5::text[], $6::timestamptz[], $7::int[])
         ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text`,
        [
          part.map((x) => x.id),
          part.map((x) => x.storyId),
          part.map((x) => x.parentId),
          part.map((x) => x.author),
          part.map((x) => x.text),
          part.map((x) => x.createdAt),
          part.map((x) => x.depth),
        ],
      );
    }
    await c.query('UPDATE stories SET comments_fetched = true WHERE id = $1', [storyId]);
  });
  metrics.collectedRecords.inc({ source: 'hackernews', entity: 'comment' }, comments.length);
}

async function refreshAuthors(db) {
  await db.tx(async (c) => {
    await c.query('TRUNCATE authors');
    await c.query(`
      INSERT INTO authors (name, story_count, comment_count, total_points)
      SELECT name, sum(sc)::int, sum(cc)::int, sum(pts)::bigint FROM (
        SELECT author AS name, count(*) AS sc, 0 AS cc, sum(points) AS pts FROM stories GROUP BY author
        UNION ALL
        SELECT author, 0, count(*), 0 FROM comments WHERE author <> '[deleted]' GROUP BY author
      ) x GROUP BY name`);
  });
  await db.query('ANALYZE stories, comments, authors');
}

async function collect({ db, log, progress }) {
  const hn = createHttpClient({ name: 'hackernews', baseUrl: 'https://hn.algolia.com/api/v1', minIntervalMs: 300 });
  let processed = 0;

  /** Скользящее окно по времени для одной "ленты" публикаций. */
  async function crawl(label, { tags, filters = [], query, target }) {
    let before = Math.floor(Date.now() / 1000);
    let got = 0;
    while (got < target) {
      const numeric = encodeURIComponent([`created_at_i<${before}`, ...filters].join(','));
      const extra = query ? `&query=${encodeURIComponent(query)}&restrictSearchableAttributes=url` : '';
      const data = await hn.getJson(
        `/search_by_date?tags=${tags}&hitsPerPage=${PAGE}&numericFilters=${numeric}${extra}${TRIM}`,
      );
      const hits = data?.hits || [];
      if (!hits.length) break;
      got += await saveStories(db, hits);
      processed += hits.length;
      before = Math.min(...hits.map((h) => h.created_at_i));
      await progress(processed, `${label}: ${got}`);
      // всё, что осталось в окне, уже получено
      if (typeof data.nbHits === 'number' && data.nbHits <= hits.length) break;
    }
    log.info({ label, got }, 'feed collected');
  }

  // 1) Публикации со ссылками на GitHub — связь с подграфом repos
  await crawl('github links', { tags: 'story', query: 'github.com', target: int('HN_GITHUB_TARGET', 6000) });
  // 2) Популярные публикации
  await crawl('popular', { tags: 'story', filters: ['points>=150'], target: int('HN_POPULAR_TARGET', 6000) });
  // 3) Show HN / Ask HN
  await crawl('show hn', { tags: 'show_hn', filters: ['points>=20'], target: int('HN_SHOW_TARGET', 2000) });
  await crawl('ask hn', { tags: 'ask_hn', filters: ['points>=30'], target: int('HN_ASK_TARGET', 1000) });

  // 4) Деревья комментариев для самых обсуждаемых публикаций и публикаций о репозиториях
  const limit = int('HN_COMMENT_STORIES', 300);
  const { rows } = await db.query(
    `(SELECT id FROM stories WHERE NOT comments_fetched AND num_comments > 0 ORDER BY num_comments DESC LIMIT $1)
     UNION
     (SELECT id FROM stories WHERE NOT comments_fetched AND num_comments > 5 AND repo_full_name IS NOT NULL
       ORDER BY points DESC LIMIT $1)`,
    [Math.ceil(limit / 2)],
  );
  let commentsTotal = 0;
  let storiesDone = 0;
  await mapLimit(rows, 4, async ({ id }) => {
    try {
      const item = await hn.getJson(`/items/${id}`, { allow404: true });
      if (!item) return;
      const comments = flattenComments(item);
      if (comments.length) await saveComments(db, id, comments);
      commentsTotal += comments.length;
      processed += comments.length;
    } catch (err) {
      // одна "битая" ветка не должна валить весь сбор
      log.warn({ storyId: id, err: err.message }, 'failed to fetch comments');
    }
    storiesDone++;
    await progress(processed, `comments: ${storiesDone}/${rows.length} stories, ${commentsTotal} comments`);
  });

  await refreshAuthors(db);
  const total = await db.query(
    'SELECT (SELECT count(*) FROM stories)::int AS s, (SELECT count(*) FROM comments)::int AS c',
  );
  log.info({ stories: total.rows[0].s, comments: total.rows[0].c }, 'Hacker News collection finished');
  return processed;
}

const isEmpty = async (db) => (await db.query('SELECT NOT EXISTS (SELECT 1 FROM stories) AS e')).rows[0].e;

module.exports = { collect, isEmpty, flattenComments };
