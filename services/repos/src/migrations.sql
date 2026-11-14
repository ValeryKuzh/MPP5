CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS owners (
  id          BIGINT PRIMARY KEY,
  login       TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'User',
  avatar_url  TEXT,
  html_url    TEXT,
  repo_count  INT  NOT NULL DEFAULT 0,
  total_stars BIGINT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS owners_login_lower_idx ON owners (lower(login));
CREATE INDEX IF NOT EXISTS owners_login_trgm_idx ON owners USING gin (login gin_trgm_ops);
CREATE INDEX IF NOT EXISTS owners_total_stars_idx ON owners (total_stars DESC, id);
CREATE INDEX IF NOT EXISTS owners_repo_count_idx ON owners (repo_count DESC, id);

CREATE TABLE IF NOT EXISTS repositories (
  id           BIGINT PRIMARY KEY,
  full_name    TEXT NOT NULL,
  name         TEXT NOT NULL,
  owner_id     BIGINT NOT NULL REFERENCES owners (id),
  description  TEXT,
  homepage     TEXT,
  html_url     TEXT NOT NULL,
  language     TEXT,
  license      TEXT,
  stars        INT NOT NULL DEFAULT 0,
  forks        INT NOT NULL DEFAULT 0,
  open_issues  INT NOT NULL DEFAULT 0,
  size_kb      INT NOT NULL DEFAULT 0,
  archived     BOOLEAN NOT NULL DEFAULT false,
  is_fork      BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
  pushed_at    TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
  updated_at   TIMESTAMPTZ,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  search       tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(replace(replace(full_name, '/', ' '), '-', ' '), '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED
);
CREATE UNIQUE INDEX IF NOT EXISTS repositories_full_name_lower_idx ON repositories (lower(full_name));
CREATE INDEX IF NOT EXISTS repositories_search_idx ON repositories USING gin (search);
CREATE INDEX IF NOT EXISTS repositories_name_trgm_idx ON repositories USING gin (full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS repositories_stars_idx ON repositories (stars DESC, id);
CREATE INDEX IF NOT EXISTS repositories_forks_idx ON repositories (forks DESC, id);
CREATE INDEX IF NOT EXISTS repositories_created_idx ON repositories (created_at DESC, id);
CREATE INDEX IF NOT EXISTS repositories_pushed_idx ON repositories (pushed_at DESC, id);
CREATE INDEX IF NOT EXISTS repositories_language_idx ON repositories (language, stars DESC);
CREATE INDEX IF NOT EXISTS repositories_owner_idx ON repositories (owner_id, stars DESC);

CREATE TABLE IF NOT EXISTS topics (
  name       TEXT PRIMARY KEY,
  repo_count INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS topics_repo_count_idx ON topics (repo_count DESC, name);
CREATE INDEX IF NOT EXISTS topics_name_trgm_idx ON topics USING gin (name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS repository_topics (
  repository_id BIGINT NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  topic         TEXT   NOT NULL REFERENCES topics (name),
  PRIMARY KEY (repository_id, topic)
);
CREATE INDEX IF NOT EXISTS repository_topics_topic_idx ON repository_topics (topic);

CREATE TABLE IF NOT EXISTS collections (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collection_items (
  collection_id INT    NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  repository_id BIGINT NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  note          TEXT,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, repository_id)
);
CREATE INDEX IF NOT EXISTS collection_items_repo_idx ON collection_items (repository_id);
