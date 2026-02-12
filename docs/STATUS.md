# Bunflare - Project Status

## Overview

| Metric           | Value |
| ---------------- | ----- |
| **Total Issues** | 18    |
| **Completed**    | 10    |
| **Pending**      | 8     |
| **Progress**     | 56%   |

## Current Focus

Issue 05: Static Assets

## Issues

Issues are ordered by implementation priority. **Implement in this order.**

| #  | Issue                        | Status  | Notes |
| -- | ---------------------------- | ------- | ----- |
| 00 | persistence-layer            | completed | Foundation — creates db.ts, schema, .bunflare/ dir |
| 14 | migrate-kv-to-sqlite         | completed | Migrate existing KV from in-memory Map to SQLite |
| 15 | migrate-r2-to-files          | completed | Migrate existing R2 from in-memory Map to files + SQLite metadata |
| 16 | migrate-do-storage-to-sqlite | completed | Migrate existing DO storage from in-memory Map to SQLite |
| 17 | migrate-workflows-to-sqlite  | completed | Migrate existing Workflow binding to SQLite |
| 07 | environment-variables        | completed | Parse vars from config + .dev.vars |
| 01 | d1-database                  | completed | |
| 02 | queues                       | completed | |
| 03 | service-bindings             | completed | |
| 04 | scheduled-handler            | completed | |
| 05 | static-assets                | pending | |
| 06 | cache-api                    | pending | |
| 08 | workflow-instance-management | pending | Depends on 17 |
| 09 | images-binding               | pending | |
| 13 | do-misc                      | pending | Depends on 16 |
| 10 | do-alarms                    | pending | Depends on 16 |
| 11 | do-websocket-support         | pending | Depends on 16 |
| 12 | do-sql-storage               | pending | Depends on 16 |

## Dependencies

- **00** must be completed first (shared DB singleton, schema, data directory)
- **14, 15, 16, 17** (migrations) depend on **00** — do these right after 00
- **08** (workflow management) depends on **17** (workflow persistence)
- **10, 11, 12, 13** (DO features) depend on **16** (DO persistence)
- All new binding issues (01-06, 09) depend on **00**

## Changelog

- **#00 persistence-layer**: Created `runtime/db.ts` with `getDatabase()` singleton, `runMigrations()` for all 7 tables (kv, r2_objects, do_storage, do_alarms, queue_messages, workflow_instances, cache_entries), WAL mode, auto-creation of `.bunflare/` directory structure. Added `runtime/tests/db.test.ts` with 9 tests.
- **#14 migrate-kv-to-sqlite**: Replaced `InMemoryKVNamespace` with `SqliteKVNamespace` backed by SQLite `kv` table. Constructor takes `(db, namespace)`. Values stored as BLOB, metadata as JSON string. Expiration checked on `get()`/`getWithMetadata()`, lazily cleaned on `list()`. Cursor-based pagination in `list()`. Updated `env.ts` to pass `getDatabase()` and binding name. Added namespace isolation test and cursor pagination test. All 89 tests pass.
- **#15 migrate-r2-to-files**: Replaced `InMemoryR2Bucket` with `FileR2Bucket`. Blobs stored as files under `.bunflare/r2/<bucket>/<key>`, metadata in `r2_objects` SQLite table. Constructor takes `(db, bucket, dataDir)`. Etag generated via MD5 hash. Nested keys with `/` create subdirectories. Path traversal (`..`) rejected. Cursor-based pagination via OFFSET. Updated `env.ts` to pass `getDatabase()`, bucket name, and `getDataDir()`. Added tests for nested keys, etag, path traversal, bucket isolation, cursor pagination, and persistence across instances. All 95 tests pass.
- **#16 migrate-do-storage-to-sqlite**: Replaced `InMemoryDurableObjectStorage` with `SqliteDurableObjectStorage` backed by `do_storage` table. Constructor takes `(db, namespace, id)`. Values stored as JSON strings. Added `deleteAll()` method and full `list()` with `prefix`, `start`, `end`, `limit`, `reverse` options. `transaction()` wraps in real SQLite BEGIN/COMMIT/ROLLBACK. `DurableObjectStateImpl` now takes `(id, db, namespace)`. `DurableObjectNamespaceImpl` takes `(db, namespaceName)`. Updated `env.ts` to pass `getDatabase()` and class name. Added tests for namespace/instance isolation, persistence across instances, `deleteAll`, `list` with `start`/`end`/`reverse`, empty arrays. All 104 tests pass.
- **#17 migrate-workflows-to-sqlite**: Replaced `InMemoryWorkflowBinding` with `SqliteWorkflowBinding` backed by `workflow_instances` table. Constructor takes `(db, workflowName, className)`. Params/output stored as JSON. `create()` inserts row with `running` status and executes workflow in background; on completion updates to `complete` with output, on error updates to `errored` with message. Added `get(id)` to retrieve instance handle from DB. `SqliteWorkflowInstance` provides `status()`, `pause()`, `resume()`, `terminate()` (with AbortController), and `restart()`. `WorkflowStepImpl` checks abort signal before each step. Updated `env.ts` to pass `db`, workflow name, class name. Tests cover persistence, status lifecycle, terminate, pause/resume, cross-instance retrieval, custom IDs. All 112 tests pass.

- **#01 d1-database**: Implemented `LocalD1Database` and `LocalD1PreparedStatement` in `runtime/bindings/d1.ts`. Each D1 binding gets its own SQLite file at `.bunflare/d1/<database_name>.sqlite`, separate from the main `data.sqlite`. `prepare()` returns a statement with `bind()`, `first()`, `run()`, `all()`, `raw()`. `batch()` wraps all statements in a BEGIN/COMMIT transaction with ROLLBACK on error. `exec()` splits multi-statement SQL on `;` and runs each. `withSession()` is a no-op returning self. `raw({ columnNames: true })` prepends column names array. Added `d1_databases` to `WranglerConfig`. Wired in `env.ts` via `openD1Database()`. Added 18 tests covering all methods, batch rollback, persistence, bind immutability. All 143 tests pass.

- **#07 environment-variables**: Added `vars` field to `WranglerConfig`. Implemented `parseDevVars()` in `env.ts` to parse dotenv-style `.dev.vars` files (supports comments, quoted values, whitespace trimming). `buildEnv()` now accepts optional `devVarsPath` parameter — config `vars` are injected first, then `.dev.vars` overrides them (matching wrangler behavior). Updated `dev.ts` to pass `.dev.vars` path. Added 13 tests (8 for parser, 5 for buildEnv integration). All 125 tests pass.

- **#02 queues**: Implemented `SqliteQueueProducer` and `QueueConsumer` in `runtime/bindings/queue.ts`. Producer: `send()` inserts message into `queue_messages` table with `visible_at` = now + delay, `sendBatch()` inserts multiple in a transaction. Consumer: `poll()` selects visible messages up to `maxBatchSize`, calls worker's `queue()` handler with `MessageBatch`. Messages auto-ack by default (matching CF behavior). `ack()`/`ackAll()` deletes messages, `retry()`/`retryAll()` keeps them with updated `visible_at`. After `maxRetries`, messages move to DLQ (if configured) or are discarded. Handler errors trigger retry for all messages. Added `queues` config (producers + consumers) to `WranglerConfig`. Wired producers in `env.ts`, consumers started in `dev.ts` via `setInterval` poll loop. Added 18 tests covering send, sendBatch, delay, batch size, ack/retry, DLQ, handler errors, persistence, attempts tracking. All 164 tests pass.

- **#04 scheduled-handler**: Implemented `parseCron()` and `cronMatchesDate()` in `runtime/bindings/scheduled.ts` — a lightweight cron parser supporting wildcards, specific values, ranges, comma-separated values, and step values (`*/5`, `1-10/3`). `ScheduledController` provides `scheduledTime`, `cron`, and `noRetry()` (no-op in dev). `startCronScheduler()` sets up a 60-second interval that checks all cron expressions against the current time and calls the worker's `scheduled()` handler on match. Added `triggers.crons` to `WranglerConfig`. In `dev.ts`: cron scheduler starts after worker import; `GET /__scheduled?cron=<expr>` endpoint allows manual triggering (matching wrangler dev behavior). Added 18 tests covering cron parsing (wildcards, specifics, ranges, commas, steps, invalid expressions), date matching (minute, hour, day, month, weekday, every-5-min, midnight), and ScheduledController properties. All 198 tests pass.

- **#03 service-bindings**: Implemented `ServiceBinding` class and `createServiceBinding()` factory in `runtime/bindings/service-binding.ts`. Binding is a Proxy that supports both HTTP mode (`.fetch()` calls target worker's fetch handler in-process) and RPC mode (any other property access returns an async function calling the method on the target). Supports named entrypoints via `entrypoint` config — instantiates the exported class with `env` and proxies method calls to it. Updated `WorkerEntrypoint` in `plugin.ts` to be a proper base class with `env` and `ctx` properties. Added `services` config to `WranglerConfig`. Wired in `env.ts` with `buildEnv()` creating proxies and `wireClassRefs()` connecting them to the loaded worker module. Added 16 tests covering fetch with Request/string/init, env passing, error cases, RPC on default export, RPC on named entrypoint, and wiring state. All 180 tests pass.

## Lessons Learned

- `Bun.plugin()` with `build.module()` is the way to shim `cloudflare:*` imports — `onResolve`/`onLoad` doesn't work for the `cloudflare:` scheme because Bun rejects it as an invalid URL before the plugin can intercept
- `bun:sqlite` `Database` class is synchronous — no need for `await` on queries
- R2 blobs should be stored as files on disk, not in SQLite (avoids bloating the database)
- When changing a binding class (rename, new constructor params), always update the corresponding test file in `runtime/tests/` AND `runtime/env.ts`
- `runtime/config.ts` has a `WranglerConfig` interface — when adding a new binding type, extend this interface with the new config fields
