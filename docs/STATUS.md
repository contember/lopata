# Bunflare - Project Status

## Overview

| Metric           | Value |
| ---------------- | ----- |
| **Total Issues** | 30    |
| **Completed**    | 20    |
| **Pending**      | 10    |
| **Progress**     | 67%   |

## Current Focus

Phase 2 — API completeness audit. Filling gaps identified by comparing each binding against Cloudflare documentation.

## Issues

### Phase 1 — Core Implementation (completed)

| #  | Issue                        | Status    | Notes |
| -- | ---------------------------- | --------- | ----- |
| 00 | persistence-layer            | completed | Foundation — db.ts, schema, .bunflare/ dir |
| 14 | migrate-kv-to-sqlite         | completed | KV from in-memory Map to SQLite |
| 15 | migrate-r2-to-files          | completed | R2 from in-memory Map to files + SQLite metadata |
| 16 | migrate-do-storage-to-sqlite | completed | DO storage from in-memory Map to SQLite |
| 17 | migrate-workflows-to-sqlite  | completed | Workflow binding to SQLite |
| 07 | environment-variables        | completed | Parse vars from config + .dev.vars |
| 01 | d1-database                  | completed | |
| 02 | queues                       | completed | |
| 03 | service-bindings             | completed | |
| 04 | scheduled-handler            | completed | |
| 05 | static-assets                | completed | |
| 06 | cache-api                    | completed | |
| 08 | workflow-instance-management | completed | |
| 09 | images-binding               | completed | |
| 13 | do-misc                      | completed | |
| 10 | do-alarms                    | completed | |
| 11 | do-websocket-support         | completed | |
| 12 | do-sql-storage               | completed | |

### Phase 2 — API Completeness (pending)

Issues ordered by priority — high-impact gaps first, optional/low-priority last.

| #  | Issue                        | Status  | Notes |
| -- | ---------------------------- | ------- | ----- |
| 27 | do-gaps                      | completed | Stub fetch(), list startAfter, sync(), WS validation |
| 18 | kv-gaps                      | completed | Bulk ops, key/value/metadata validation, configurable limits |
| 20 | d1-gaps                      | pending | dump(), exec() parsing, type conversion |
| 21 | queues-gaps                  | pending | Content types fix, batch timeout, validation |
| 23 | cache-api-gaps               | pending | TTL/expiration, Cache-Control, cf-cache-status |
| 26 | workflows-gaps               | pending | Step retry config, checkpointing, status structure |
| 19 | r2-gaps                      | pending | Multipart, conditionals, range reads, list delimiter |
| 24 | static-assets-gaps           | pending | ETag, Cache-Control, _headers, run_worker_first, 307 fix |
| 22 | service-bindings-gaps        | pending | Stub fetch, RPC property access, async consistency |
| 28 | config-gaps                  | pending | wrangler.toml, env-specific config, global env import |
| 29 | scheduled-gaps               | pending | Special cron strings (@daily), day/month names |
| 25 | images-transforms            | pending | Basic transforms via Sharp, AVIF dimensions |

## Dependencies

### Phase 1
- **00** must be completed first (shared DB singleton, schema, data directory)
- **14, 15, 16, 17** (migrations) depend on **00** — do these right after 00
- **08** (workflow management) depends on **17** (workflow persistence)
- **10, 11, 12, 13** (DO features) depend on **16** (DO persistence)
- All new binding issues (01-06, 09) depend on **00**

### Phase 2
- No hard dependencies between Phase 2 issues — can be implemented in any order
- All Phase 2 issues depend on their respective Phase 1 implementation being completed (already done)
- **25** (images-transforms) requires `sharp` as an optional dependency

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

- **#06 cache-api**: Implemented `SqliteCache` and `SqliteCacheStorage` in `runtime/bindings/cache.ts`. `SqliteCache` uses the `cache_entries` table — `put()` stores response status, headers (JSON), and body (BLOB); `match()` reconstructs a `Response`; `delete()` removes the entry. Only GET requests are cacheable (unless `ignoreMethod: true`). Responses with `Set-Cookie` header are silently skipped on `put()`. `SqliteCacheStorage` exposes `default` (cache_name `"default"`) and `open(name)` for named caches. Named caches are isolated via the `cache_name` column. Global `caches` object registered in `plugin.ts` preload via `Object.defineProperty(globalThis, "caches", ...)`. Added 20 tests covering match, put, delete, ignoreMethod, Set-Cookie skip, binary body, headers preservation, named cache isolation, and persistence. All 241 tests pass.

- **#08 workflow-instance-management**: Extended `SqliteWorkflowBinding` with `createBatch()` for creating multiple instances at once. Added `sleepUntil(name, timestamp)` to `WorkflowStepImpl` — calculates delay from `Date.now()` to target timestamp, resolves immediately for past timestamps. Implemented `waitForEvent(name, options)` with dual mechanism: in-memory resolver registry for real-time delivery and `workflow_events` DB table for events sent before workflow reaches `waitForEvent`. Status transitions to `waiting` during `waitForEvent`, restored to `running` on resolution. `sendEvent({ type, payload })` added to `SqliteWorkflowInstance` — resolves in-memory waiter if present, otherwise stores in DB. Added `parseDuration()` helper for timeout strings (ms/s/m/h/d). Made step execution pause-aware: `checkPaused()` polls DB for `paused` status before each step, blocking until resumed or terminated. Added `workflow_events` table to `runMigrations()`. Added 12 new tests covering createBatch, sleepUntil, waitForEvent/sendEvent (real-time, pre-stored, via get() handle, timeout, terminate during wait), and pause-aware execution. All 253 tests pass.

- **#09 images-binding**: Implemented `ImagesBinding` class in `runtime/bindings/images.ts` with minimal viable approach (passthrough). `info(stream)` reads the full stream, detects format from magic bytes (PNG, JPEG, GIF, WebP, AVIF, SVG), and parses dimensions from image headers — returns `{ width, height, format, fileSize }`. `input(stream)` returns a `LazyImageTransformer` that supports chainable `transform()` and `draw()` calls (no-ops with console warning in dev mode) and `output(options)` which returns the original image data as a `ReadableStream` with the requested content-type. Added `images` config to `WranglerConfig`. Wired in `env.ts`. Added 12 tests covering PNG/JPEG/GIF/SVG info parsing, unknown format rejection, passthrough output, chainable transforms, draw compositing, and output format. All 265 tests pass.

- **#13 do-misc**: Added `DurableObjectIdImpl.equals()` for comparing IDs. Added `blockConcurrencyWhile()` to `DurableObjectStateImpl` — stores a ready promise that the proxy stub awaits before forwarding any method calls. Added `newUniqueId()` to `DurableObjectNamespaceImpl` using `crypto.randomUUID()` (jurisdiction option ignored in dev). Added `getByName()` as shorthand for `idFromName()` + `get()`. Added `StorageOptions` interface (`allowConcurrency`, `allowUnconfirmed`, `noCache`) as no-op optional parameters on all storage methods (`get`, `put`, `delete`, `deleteAll`). Added 7 new tests covering equals, blockConcurrencyWhile (both direct and via proxy deferral), newUniqueId, getByName. All 272 tests pass.

- **#05 static-assets**: Implemented `StaticAssets` class in `runtime/bindings/static-assets.ts`. `fetch(request)` serves files from a configured directory using `Bun.file()`. Supports all 4 `html_handling` modes: `none` (exact match only), `auto-trailing-slash` (tries `/path`, `/path/index.html`, `/path.html`), `force-trailing-slash` (301 redirect to add `/`), `drop-trailing-slash` (301 redirect to remove `/`). Supports all 3 `not_found_handling` modes: `none` (plain 404), `404-page` (serves `/404.html` with 404 status), `single-page-application` (serves `/index.html` for all not-found paths). Path traversal prevented via `..` check and `path.resolve` validation. Content-Type set via `Bun.file().type`. Added `assets` config to `WranglerConfig`. Wired in `env.ts` — if `binding` is set, added to env; if not, stored in registry for auto-serving. In `dev.ts`, static assets served before worker fetch handler when no binding name is configured. Added 23 tests covering file serving, nested files, Content-Type, path traversal, all html_handling modes, all not_found_handling modes. All 221 tests pass.

- **#10 do-alarms**: Added `getAlarm()`, `setAlarm(scheduledTime)`, and `deleteAlarm()` to `SqliteDurableObjectStorage` — backed by the `do_alarms` table. `setAlarm()` accepts `number` (ms epoch) or `Date`, upserts a single alarm row per DO instance (only one alarm at a time). `DurableObjectNamespaceImpl` manages alarm timers: `_scheduleAlarmTimer()` sets a `setTimeout`, `_fireAlarm()` calls the DO's `alarm()` handler with `{ retryCount, isRetry }`. On handler error, retries up to 6 times with exponential backoff (2^n seconds). Alarm is cleared from DB before calling handler (matching CF behavior). `_restoreAlarms()` runs on `_setClass()` to re-schedule any persisted alarms (past-due ones fire immediately). Alarm callback wired via `_setAlarmCallback()` on storage so `setAlarm`/`deleteAlarm` automatically schedule/cancel timers. Added 14 tests covering storage methods, alarm firing, replacement, cancellation, retry with backoff, past-due restoration, and persistence. All 286 tests pass.

- **#11 do-websocket-support**: Added `WebSocketRequestResponsePair` class and exported from `cloudflare:workers` plugin. Added WebSocket Hibernation API methods to `DurableObjectStateImpl`: `acceptWebSocket(ws, tags?)` registers WebSocket with event listeners delegating to DO's `webSocketMessage`/`webSocketClose`/`webSocketError` handlers; `getWebSockets(tag?)` returns accepted WebSockets filtered by optional tag; `getTags(ws)` returns tags for a WebSocket; `setWebSocketAutoResponse(pair?)` / `getWebSocketAutoResponse()` for automatic ping/pong-style responses; `getWebSocketAutoResponseTimestamp(ws)` tracks last auto-response time; `setHibernatableWebSocketEventTimeout()` / `getHibernatableWebSocketEventTimeout()` are no-ops. Auto-response intercepts matching messages before handler and sends response directly. Closed WebSockets auto-removed from accepted set. `_doInstance` reference wired in `DurableObjectNamespaceImpl` for handler delegation. Added 18 tests covering all methods, tag filtering, auto-response, handler delegation, and close cleanup. All 304 tests pass.

- **#12 do-sql-storage**: Implemented `SqlStorageCursor` and `SqlStorage` classes in `runtime/bindings/durable-object.ts`. `SqlStorageCursor` implements the full cursor API: iterable via `for..of`, `next()` iterator protocol, `toArray()`, `one()` (throws if not exactly 1 row), `raw()` (arrays without column names), `columnNames`, `rowsRead`, `rowsWritten`. `SqlStorage` provides `exec(query, ...bindings)` which creates a per-DO-instance SQLite file at `.bunflare/do-sql/<namespace>/<id>.sqlite` with lazy initialization and WAL mode. Distinguishes SELECT/WITH/PRAGMA (returns rows) from write statements (returns changes count). `databaseSize` returns file size via `statSync`. `SqliteDurableObjectStorage.sql` getter lazily creates `SqlStorage` when `dataDir` is configured. Extended constructor chain: `SqliteDurableObjectStorage(db, namespace, id, dataDir?)`, `DurableObjectStateImpl(id, db, namespace, dataDir?)`, `DurableObjectNamespaceImpl(db, name, dataDir?)`. Updated `env.ts` to pass `getDataDir()`. Added `migrations` field to `WranglerConfig`. Added 18 tests covering exec, columnNames, iteration, next(), one(), raw(), rowsRead/rowsWritten, databaseSize, parameter bindings, instance isolation, persistence, and namespace integration. All 322 tests pass.

- **#27 do-gaps**: Added `stub.fetch(request)` — proxy intercepts `fetch` property and calls the DO's `fetch()` handler, constructing a proper `Request` from string/URL inputs. Added `stub.id` and `stub.name` properties on the proxy stub. Added `list({ startAfter })` — exclusive start key (key > startAfter), takes precedence over `start` when both provided. Added `sync()` as no-op returning resolved promise. Added `DurableObjectLimits` interface with configurable WebSocket validation: `maxTagsPerWebSocket` (default 10), `maxTagLength` (default 256), `maxConcurrentWebSockets` (default 32,768), `maxAutoResponseLength` (default 2,048). Limits passed through `DurableObjectNamespaceImpl` → `DurableObjectStateImpl`. Fixed `setHibernatableWebSocketEventTimeout`/`getHibernatableWebSocketEventTimeout` to store and return the value instead of being no-ops. Added 19 new tests. All 341 tests pass.

- **#18 kv-gaps**: Added `KVLimits` interface with configurable `maxKeySize` (512), `maxValueSize` (25 MiB), `maxMetadataSize` (1024), `minTtlSeconds` (60), `maxBulkGetKeys` (100) — passed via constructor. Key validation rejects empty strings, `.`, `..`, and keys exceeding max byte size. Value size validated after encoding. Metadata size validated after JSON serialization. `expirationTtl` validated against minimum. Added bulk `get(keys[])` returning `Map<string, value>` and bulk `getWithMetadata(keys[])` returning `Map<string, {value, metadata}>` with IN-query batching and expired key cleanup. `cacheTtl` option accepted and ignored on `get()`/`getWithMetadata()`. Added 20 new tests (44 total KV tests). All 362 tests pass.

## Lessons Learned

- `Bun.plugin()` with `build.module()` is the way to shim `cloudflare:*` imports — `onResolve`/`onLoad` doesn't work for the `cloudflare:` scheme because Bun rejects it as an invalid URL before the plugin can intercept
- `bun:sqlite` `Database` class is synchronous — no need for `await` on queries
- R2 blobs should be stored as files on disk, not in SQLite (avoids bloating the database)
- When changing a binding class (rename, new constructor params), always update the corresponding test file in `runtime/tests/` AND `runtime/env.ts`
- `runtime/config.ts` has a `WranglerConfig` interface — when adding a new binding type, extend this interface with the new config fields
- For workflow `waitForEvent`/`sendEvent`, use an in-memory registry of promise resolvers (per-process) combined with a `workflow_events` DB table for events sent before the workflow reaches `waitForEvent`. This handles both timing scenarios correctly.
