# Migrate DO storage from in-memory to SQLite

Current `runtime/bindings/durable-object.ts` uses `Map` for storage — needs SQLite for persistence.

## Current state

`InMemoryDurableObjectStorage` uses `Map<string, unknown>`. DO instances and their data are lost on restart.

## Target

KV-style DO storage uses the `do_storage` table in `data.sqlite`:

```sql
CREATE TABLE IF NOT EXISTS do_storage (
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,   -- JSON-serialized
  PRIMARY KEY (namespace, id, key)
);
```

## Changes needed

### DurableObjectStorage

- Constructor takes `db: Database`, `namespace: string` (class name), `id: string` (instance ID)
- `get(key)`:
  - `SELECT value FROM do_storage WHERE namespace = ? AND id = ? AND key = ?`
  - `JSON.parse()` the value
- `get(keys[])`:
  - `SELECT key, value FROM do_storage WHERE namespace = ? AND id = ? AND key IN (?, ?, ...)`
  - Return as `Map<string, T>`
- `put(key, value)`:
  - `INSERT OR REPLACE INTO do_storage (namespace, id, key, value) VALUES (?, ?, ?, ?)`
  - `JSON.stringify()` the value
- `put(entries)`:
  - Batch insert in a transaction
- `delete(key)`:
  - `DELETE FROM do_storage WHERE namespace = ? AND id = ? AND key = ?`
- `delete(keys[])`:
  - `DELETE ... WHERE key IN (...)`
- `deleteAll()`:
  - `DELETE FROM do_storage WHERE namespace = ? AND id = ?`
- `list(options)`:
  - `SELECT key, value FROM do_storage WHERE namespace = ? AND id = ? AND key >= ? AND key LIKE ? ORDER BY key LIMIT ?`
  - Support `prefix`, `start`, `end`, `limit`, `reverse`
- `transaction(callback)`:
  - Wrap in SQLite transaction (`BEGIN`/`COMMIT`/`ROLLBACK`)

### DurableObjectNamespace

- `get(id)` lazily instantiates DO — on restart, same ID gets same persisted data
- Instance cache (`Map<string, DO>`) still in memory for the current process — storage is the persistence layer

## Files to update

- `runtime/bindings/durable-object.ts` — replace `InMemoryDurableObjectStorage` with `SqliteDurableObjectStorage`
- `runtime/env.ts` — update `buildEnv()` to pass `db` to `DurableObjectNamespaceImpl`
- `runtime/tests/durable-object.test.ts` — update imports, create in-memory SQLite + init schema in `beforeEach`
- All existing tests must still pass after migration

## Value serialization

- Use `JSON.stringify` / `JSON.parse` for values
- Handles strings, numbers, booleans, arrays, plain objects
- Does NOT handle Date, Map, Set, ArrayBuffer etc. — matches Cloudflare's structured-clone limitations in KV storage mode (for full fidelity, could use v8 serialize, but JSON is sufficient for most cases)
