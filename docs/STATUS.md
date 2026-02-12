# Bunflare - Project Status

## Overview

| Metric           | Value |
| ---------------- | ----- |
| **Total Issues** | 18    |
| **Completed**    | 0     |
| **Pending**      | 18    |
| **Progress**     | 0%    |

## Current Focus

Issue 00: Persistence layer

## Issues

| #  | Issue                        | Status  | Notes |
| -- | ---------------------------- | ------- | ----- |
| 00 | persistence-layer            | pending | Foundation — all other persistence depends on this |
| 01 | d1-database                  | pending | |
| 02 | queues                       | pending | |
| 03 | service-bindings             | pending | |
| 04 | scheduled-handler            | pending | |
| 05 | static-assets                | pending | |
| 06 | cache-api                    | pending | |
| 07 | environment-variables        | pending | |
| 08 | workflow-instance-management | pending | |
| 09 | images-binding               | pending | |
| 10 | do-alarms                    | pending | |
| 11 | do-websocket-hibernation     | pending | |
| 12 | do-sql-storage               | pending | |
| 13 | do-misc                      | pending | |
| 14 | migrate-kv-to-sqlite         | pending | |
| 15 | migrate-r2-to-files          | pending | |
| 16 | migrate-do-storage-to-sqlite | pending | |
| 17 | migrate-workflows-to-sqlite  | pending | |

## Dependencies

- **00** must be completed first (shared DB singleton, schema, data directory)
- **14, 15, 16, 17** (migrations) depend on **00**
- **08** (workflow management) depends on **17** (workflow persistence)
- **10, 11, 12, 13** (DO features) depend on **16** (DO persistence)
- All other issues (01-09) depend on **00**

## Changelog

_No changes yet._

## Lessons Learned

- `Bun.plugin()` with `build.module()` is the way to shim `cloudflare:*` imports — `onResolve`/`onLoad` doesn't work for the `cloudflare:` scheme because Bun rejects it as an invalid URL before the plugin can intercept
- `bun:sqlite` `Database` class is synchronous — no need for `await` on queries
- R2 blobs should be stored as files on disk, not in SQLite (avoids bloating the database)
