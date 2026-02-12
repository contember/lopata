# Persistence layer

All runtime state must survive restarts. Single SQLite database for everything except R2 blobs (stored as files).

## Data directory

```
.bunflare/
  data.sqlite          # KV, DO storage, queues, workflows, cache, metadata
  r2/
    <bucket>/
      <key>            # raw blob files
  d1/
    <database_name>.sqlite   # separate DB per D1 binding
```

- Default path: `.bunflare/` in project root
- Created automatically on first run
- Add `.bunflare/` to `.gitignore`

## Main SQLite schema (`data.sqlite`)

```sql
-- KV
CREATE TABLE IF NOT EXISTS kv (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value BLOB NOT NULL,
  metadata TEXT,            -- JSON
  expiration INTEGER,       -- epoch seconds, NULL = no expiry
  PRIMARY KEY (namespace, key)
);

-- R2 metadata (blobs on disk)
CREATE TABLE IF NOT EXISTS r2_objects (
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  size INTEGER NOT NULL,
  etag TEXT NOT NULL,
  uploaded TEXT NOT NULL,    -- ISO 8601
  http_metadata TEXT,        -- JSON
  custom_metadata TEXT,      -- JSON
  PRIMARY KEY (bucket, key)
);

-- DO storage (KV-style)
CREATE TABLE IF NOT EXISTS do_storage (
  namespace TEXT NOT NULL,   -- class name
  id TEXT NOT NULL,          -- DO instance ID
  key TEXT NOT NULL,
  value TEXT NOT NULL,       -- JSON-serialized
  PRIMARY KEY (namespace, id, key)
);

-- DO alarms
CREATE TABLE IF NOT EXISTS do_alarms (
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  alarm_time INTEGER NOT NULL,  -- ms epoch
  PRIMARY KEY (namespace, id)
);

-- Queues
CREATE TABLE IF NOT EXISTS queue_messages (
  id TEXT PRIMARY KEY,
  queue TEXT NOT NULL,
  body TEXT NOT NULL,        -- JSON-serialized
  content_type TEXT NOT NULL DEFAULT 'json',
  attempts INTEGER NOT NULL DEFAULT 0,
  visible_at INTEGER NOT NULL,  -- ms epoch (for delay)
  created_at INTEGER NOT NULL
);

-- Workflow instances
CREATE TABLE IF NOT EXISTS workflow_instances (
  id TEXT PRIMARY KEY,
  workflow_name TEXT NOT NULL,
  class_name TEXT NOT NULL,
  params TEXT,               -- JSON
  status TEXT NOT NULL DEFAULT 'running',  -- running, paused, complete, errored, terminated
  output TEXT,               -- JSON
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Cache API
CREATE TABLE IF NOT EXISTS cache_entries (
  cache_name TEXT NOT NULL,
  url TEXT NOT NULL,
  status INTEGER NOT NULL,
  headers TEXT NOT NULL,     -- JSON
  body BLOB NOT NULL,
  PRIMARY KEY (cache_name, url)
);
```

## Implementation notes

- Use `bun:sqlite` (`Database` class) — one shared `Database` instance for `data.sqlite`
- Open with `{ create: true }` so it auto-creates
- Run all `CREATE TABLE IF NOT EXISTS` on startup
- WAL mode for better concurrent read performance: `PRAGMA journal_mode=WAL`
- D1 databases are separate SQLite files in `.bunflare/d1/` (not in the shared DB)
- Export a `getDatabase()` singleton from a shared module that all bindings import
- R2 blobs stored as plain files — SQLite only holds metadata
