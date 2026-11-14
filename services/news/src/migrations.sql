CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS stories (
  id             BIGINT PRIMARY KEY,
  title          TEXT NOT NULL,
  url            TEXT,
  domain         TEXT,
  author         TEXT NOT NULL,
  points         INT NOT NULL DEFAULT 0,
  num_comments   INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL,
  story_type     TEXT NOT NULL DEFAULT 'STORY',
  repo_full_name TEXT,
  text           TEXT,
  comments_fetched BOOLEAN NOT NULL DEFAULT false,
  collected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  search         tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(left(text, 5000), '')), 'C')
  ) STORED
);
CREATE INDEX IF NOT EXISTS stories_search_idx ON stories USING gin (search);
CREATE INDEX IF NOT EXISTS stories_title_trgm_idx ON stories USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS stories_points_idx ON stories (points DESC, id);
CREATE INDEX IF NOT EXISTS stories_comments_idx ON stories (num_comments DESC, id);
CREATE INDEX IF NOT EXISTS stories_created_idx ON stories (created_at DESC, id);
CREATE INDEX IF NOT EXISTS stories_author_idx ON stories (author);
CREATE INDEX IF NOT EXISTS stories_domain_idx ON stories (domain);
CREATE INDEX IF NOT EXISTS stories_repo_idx ON stories (repo_full_name) WHERE repo_full_name IS NOT NULL;

CREATE TABLE IF NOT EXISTS comments (
  id         BIGINT PRIMARY KEY,
  story_id   BIGINT NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
  parent_id  BIGINT,
  author     TEXT NOT NULL,
  text       TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  depth      INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS comments_story_idx ON comments (story_id, created_at, id) WHERE parent_id IS NULL;
CREATE INDEX IF NOT EXISTS comments_parent_idx ON comments (parent_id, created_at, id);
CREATE INDEX IF NOT EXISTS comments_author_idx ON comments (author, created_at DESC);
CREATE INDEX IF NOT EXISTS comments_story_all_idx ON comments (story_id);
CREATE INDEX IF NOT EXISTS comments_text_trgm_idx ON comments USING gin (text gin_trgm_ops);

-- Денормализованная статистика авторов (пересчитывается после синхронизации)
CREATE TABLE IF NOT EXISTS authors (
  name          TEXT PRIMARY KEY,
  story_count   INT NOT NULL DEFAULT 0,
  comment_count INT NOT NULL DEFAULT 0,
  total_points  BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS authors_points_idx ON authors (total_points DESC, name);
CREATE INDEX IF NOT EXISTS authors_stories_idx ON authors (story_count DESC, name);
CREATE INDEX IF NOT EXISTS authors_comments_idx ON authors (comment_count DESC, name);
CREATE INDEX IF NOT EXISTS authors_name_trgm_idx ON authors USING gin (name gin_trgm_ops);
