CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS packages (
  name              TEXT PRIMARY KEY,
  version           TEXT,
  description       TEXT,
  keywords          TEXT[] NOT NULL DEFAULT '{}',
  keywords_text     TEXT,
  license           TEXT,
  homepage          TEXT,
  repository_url    TEXT,
  repo_full_name    TEXT,
  publisher         TEXT,
  maintainers       TEXT[] NOT NULL DEFAULT '{}',
  published_at      TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
  downloads_monthly BIGINT NOT NULL DEFAULT 0,
  downloads_weekly  BIGINT NOT NULL DEFAULT 0,
  dependents_count  INT NOT NULL DEFAULT 0,
  score             REAL NOT NULL DEFAULT 0,
  deps_fetched      BOOLEAN NOT NULL DEFAULT false,
  collected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  search            tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(replace(replace(replace(name, '@', ' '), '/', ' '), '-', ' '), '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(keywords_text, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'C')
  ) STORED
);
CREATE INDEX IF NOT EXISTS packages_search_idx ON packages USING gin (search);
CREATE INDEX IF NOT EXISTS packages_name_trgm_idx ON packages USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS packages_keywords_idx ON packages USING gin (keywords);
CREATE INDEX IF NOT EXISTS packages_maintainers_idx ON packages USING gin (maintainers);
CREATE INDEX IF NOT EXISTS packages_downloads_idx ON packages (downloads_monthly DESC, name);
CREATE INDEX IF NOT EXISTS packages_dependents_idx ON packages (dependents_count DESC, name);
CREATE INDEX IF NOT EXISTS packages_published_idx ON packages (published_at DESC, name);
CREATE INDEX IF NOT EXISTS packages_score_idx ON packages (score DESC, name);
CREATE INDEX IF NOT EXISTS packages_repo_idx ON packages (repo_full_name) WHERE repo_full_name IS NOT NULL;

CREATE TABLE IF NOT EXISTS dependencies (
  package_name    TEXT NOT NULL REFERENCES packages (name) ON DELETE CASCADE,
  dependency_name TEXT NOT NULL,
  version_range   TEXT,
  kind            TEXT NOT NULL,
  PRIMARY KEY (package_name, kind, dependency_name)
);
CREATE INDEX IF NOT EXISTS dependencies_dep_idx ON dependencies (dependency_name);

CREATE TABLE IF NOT EXISTS maintainers (
  name            TEXT PRIMARY KEY,
  package_count   INT NOT NULL DEFAULT 0,
  total_downloads BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS maintainers_downloads_idx ON maintainers (total_downloads DESC, name);
CREATE INDEX IF NOT EXISTS maintainers_count_idx ON maintainers (package_count DESC, name);
CREATE INDEX IF NOT EXISTS maintainers_name_trgm_idx ON maintainers USING gin (name gin_trgm_ops);
