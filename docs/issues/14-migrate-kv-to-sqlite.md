# Migrate KV binding from in-memory to SQLite

Current `runtime/bindings/kv.ts` uses `Map` — needs to use SQLite for persistence.

## Current state

`InMemoryKVNamespace` stores everything in a `Map<string, {value, metadata?, expiration?}>`. Data is lost on restart.

## Target

Replace `Map` with queries against the `kv` table in `data.sqlite`:

```sql
CREATE TABLE IF NOT EXISTS kv (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value BLOB NOT NULL,
  metadata TEXT,
  expiration INTEGER,
  PRIMARY KEY (namespace, key)
);
```

## Changes needed

- Constructor takes `db: Database` (from `bun:sqlite`) and `namespace: string` (the binding name, e.g. `"KV"`)
- `get(key)`:
  - `SELECT value, metadata, expiration FROM kv WHERE namespace = ? AND key = ?`
  - Check expiration — if expired, `DELETE` and return null
  - Decode value based on requested type (text/json/arrayBuffer/stream)
- `getWithMetadata(key)`: same query, also return metadata
- `put(key, value, options)`:
  - `INSERT OR REPLACE INTO kv (namespace, key, value, metadata, expiration) VALUES (?, ?, ?, ?, ?)`
  - Serialize value to BLOB (text → Buffer, ArrayBuffer → as-is, ReadableStream → consume to Buffer)
  - Store metadata as JSON string
- `delete(key)`: `DELETE FROM kv WHERE namespace = ? AND key = ?`
- `list(options)`:
  - `SELECT key, expiration, metadata FROM kv WHERE namespace = ? AND key LIKE ? ORDER BY key LIMIT ?`
  - Filter expired entries (delete them lazily)
  - Cursor pagination: use `key > ?` for cursor-based paging

## Value encoding

- Store all values as BLOB in SQLite
- On `get()`, decode based on requested type:
  - `"text"` → `Buffer.from(blob).toString()`
  - `"json"` → `JSON.parse(Buffer.from(blob).toString())`
  - `"arrayBuffer"` → return as ArrayBuffer
  - `"stream"` → wrap in ReadableStream
