# Migrate R2 binding from in-memory to file-based + SQLite metadata

Current `runtime/bindings/r2.ts` uses `Map` — needs file storage for blobs and SQLite for metadata.

## Current state

`InMemoryR2Bucket` stores everything in a `Map<string, {data: ArrayBuffer, uploaded: Date}>`. Data is lost on restart.

## Target

- Blobs stored as files: `.bunflare/r2/<bucket>/<key>`
- Metadata in `r2_objects` table in `data.sqlite`:

```sql
CREATE TABLE IF NOT EXISTS r2_objects (
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  size INTEGER NOT NULL,
  etag TEXT NOT NULL,
  uploaded TEXT NOT NULL,
  http_metadata TEXT,
  custom_metadata TEXT,
  PRIMARY KEY (bucket, key)
);
```

## Changes needed

- Constructor takes `db: Database`, `bucket: string`, `dataDir: string`
- `put(key, value)`:
  - Consume value to Buffer/ArrayBuffer
  - Write to `.bunflare/r2/<bucket>/<key>` using `Bun.write()`
  - Generate etag (e.g. md5 hash of content)
  - `INSERT OR REPLACE` metadata row
  - Handle nested keys with `/` — create subdirectories as needed
- `get(key)`:
  - Query metadata from DB
  - If not found, return null
  - Read blob from file using `Bun.file()`
  - Return `R2ObjectBody` with `.body` as ReadableStream from the file
- `head(key)`:
  - Query metadata only, return `R2Object` (no body)
- `delete(key)`:
  - Delete file from disk
  - Delete metadata row
- `list(options)`:
  - `SELECT ... FROM r2_objects WHERE bucket = ? AND key LIKE ? ORDER BY key LIMIT ?`
  - Return `R2Object` instances (no body)

## File path safety

- Sanitize keys to prevent path traversal — reject keys containing `..`
- Keys with `/` create nested directories (matching R2 behavior)
- Use `path.join(dataDir, "r2", bucket, key)` for file paths
