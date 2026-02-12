# Bunflare - Project Status

## Overview

| Metric           | Value |
| ---------------- | ----- |
| **Total Issues** | 18    |
| **Completed**    | 1     |
| **Pending**      | 17    |
| **Progress**     | 6%    |

## Current Focus

Issue 14: Migrate KV to SQLite

## Issues

Issues are ordered by implementation priority. **Implement in this order.**

| #  | Issue                        | Status  | Notes |
| -- | ---------------------------- | ------- | ----- |
| 00 | persistence-layer            | completed | Foundation — creates db.ts, schema, .bunflare/ dir |
| 14 | migrate-kv-to-sqlite         | pending | Migrate existing KV from in-memory Map to SQLite |
| 15 | migrate-r2-to-files          | pending | Migrate existing R2 from in-memory Map to files + SQLite metadata |
| 16 | migrate-do-storage-to-sqlite | pending | Migrate existing DO storage from in-memory Map to SQLite |
| 17 | migrate-workflows-to-sqlite  | pending | Migrate existing Workflow binding to SQLite |
| 07 | environment-variables        | pending | Simple — parse vars from config + .dev.vars |
| 01 | d1-database                  | pending | |
| 02 | queues                       | pending | |
| 03 | service-bindings             | pending | |
| 04 | scheduled-handler            | pending | |
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

## Lessons Learned

- `Bun.plugin()` with `build.module()` is the way to shim `cloudflare:*` imports — `onResolve`/`onLoad` doesn't work for the `cloudflare:` scheme because Bun rejects it as an invalid URL before the plugin can intercept
- `bun:sqlite` `Database` class is synchronous — no need for `await` on queries
- R2 blobs should be stored as files on disk, not in SQLite (avoids bloating the database)
- When changing a binding class (rename, new constructor params), always update the corresponding test file in `runtime/tests/` AND `runtime/env.ts`
- `runtime/config.ts` has a `WranglerConfig` interface — when adding a new binding type, extend this interface with the new config fields
