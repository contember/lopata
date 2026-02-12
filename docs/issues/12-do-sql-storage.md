# Durable Objects: SQL Storage

SQLite-based storage API on Durable Object state.

## API to implement

### DurableObjectStorage.sql

- `sql.exec(query: string, ...bindings: unknown[]): SqlStorageCursor` — execute SQL with `?` parameter bindings

### SqlStorageCursor

- Iterable: `for (const row of cursor)` — yields `Record<string, unknown>` objects
- `next(): { done: boolean, value?: Record<string, unknown> }` — iterator protocol
- `toArray(): Record<string, unknown>[]` — all remaining rows
- `one(): Record<string, unknown>` — exactly one row, throws if 0 or >1 rows
- `raw(): unknown[][]` — rows as value arrays (no column names)
- `columnNames: string[]` — column names from the query
- `rowsRead: number` — total rows scanned
- `rowsWritten: number` — total rows written

### DurableObjectStorage.sql.databaseSize

- `sql.databaseSize: number` — database size in bytes

## Wrangler config

```jsonc
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["MyDO"] }
]
```

Note: `new_sqlite_classes` (SQL-backed) vs `new_classes` (KV-backed). Both should work in dev.

## Persistence

- Each DO instance with SQL storage gets its own SQLite file: `.bunflare/do-sql/<namespace>/<id>.sqlite`
- Separate from `data.sqlite` — the user controls the schema via `sql.exec()`
- `bun:sqlite` `Database` opened with `{ create: true }`
- This is independent from the KV-style DO storage (which uses the `do_storage` table in `data.sqlite`)
- In production, SQL-backed DOs use the same SQLite for both KV and SQL APIs — in dev we can keep them separate for simplicity, or merge them (KV as a table in the per-DO SQLite)
- `columnNames` from `Statement.columnNames`
- `rowsRead` / `rowsWritten` approximated from result count and `Database.changes`
