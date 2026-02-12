# D1 Database binding

SQLite-backed D1 database binding using `bun:sqlite`.

## Wrangler config

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "my-db", "database_id": "<ID>" }
]
```

## API to implement

### D1Database

- `prepare(sql: string): D1PreparedStatement`
- `batch(statements: D1PreparedStatement[]): Promise<D1Result[]>`
- `exec(sql: string): Promise<D1ExecResult>` — raw multi-statement SQL
- `withSession(bookmark?): D1Database` — returns self (no-op in dev)

### D1PreparedStatement

- `bind(...values): D1PreparedStatement`
- `first<T>(column?): Promise<T | null>` — first row or single column value
- `run(): Promise<D1Result>` — for INSERT/UPDATE/DELETE, returns `{ meta: { changes, last_row_id, duration } }`
- `all<T>(): Promise<D1Result<T>>` — `{ results: T[], meta, success }`
- `raw<T>(options?): Promise<T[]>` — rows as arrays, `{ columnNames: true }` returns column names as first element

### D1Result

```ts
{ results: T[], success: boolean, meta: { duration: number, changes: number, last_row_id: number, served_by: string, rows_read: number, rows_written: number } }
```

## Persistence

- Each D1 binding gets its own SQLite file: `.bunflare/d1/<database_name>.sqlite`
- Separate from the main `data.sqlite` — D1 is a user-managed database with user-defined schema
- `bun:sqlite` `Database` opened with `{ create: true }`
- `batch()` runs all statements in a single transaction
- `exec()` splits on `;` and runs each statement (used for schema migrations)
- `withSession()` returns `this`
