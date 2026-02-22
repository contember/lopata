# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: Lopata

Pure TypeScript runtime that runs Cloudflare Worker code in Bun with local binding implementations (no workerd, no miniflare).

## Commands

- `bun run test` — run all integration tests
- `bun test tests/kv.test.ts` — run a single test file
- `bun run lint` — lint (`bun run lint:fix` to autofix)
- `bun run format` — format (`bun run format:check` to verify)
- `bun run typecheck` — type check (uses `tsc --build --noEmit`)
- `bun run dev` — start dev server via playground example

## Code Style

- **Formatter**: dprint — tabs, no semicolons (ASI), single quotes, line width 150
- **Linter**: Biome — `useExportType: on`, `useHookAtTopLevel: on`, a11y off, most strictness rules relaxed
- **Imports**: use `import type` for type-only exports (enforced by Biome)

## Architecture

### Request lifecycle

```
CLI (src/cli.ts) → dev command (src/cli/dev.ts)
  → GenerationManager (src/generation-manager.ts) — manages hot-reload
    → Generation (src/generation.ts) — immutable worker module state
      → buildEnv() (src/env.ts) — creates all binding instances
      → wireClassRefs() (src/env.ts) — connects DO/Workflow classes to namespaces
  → Bun.serve() on :8787
    → Generation.callFetch() — wraps request in tracing span → worker.fetch(req, env, ctx)
```

### Module shimming (`src/plugin.ts`)

`Bun.plugin()` with `build.module()` provides virtual implementations of `cloudflare:workers`, `cloudflare:workflows`, `@cloudflare/containers`, `@cloudflare/puppeteer`, and `cloudflare:email`. Also patches globals: `caches`, `HTMLRewriter`, `WebSocketPair`, `crypto.timingSafeEqual`, `navigator.userAgent`, `scheduler.wait`.

### Bindings (`src/bindings/`)

Each binding is a class implementing the CF API. All state persists to SQLite (`.lopata/data.sqlite`) or filesystem (`.lopata/r2/`, `.lopata/d1/`), never in-memory. Schema migrations live in `src/db.ts`.

| Binding         | Class                                       | Storage                      |
| --------------- | ------------------------------------------- | ---------------------------- |
| KV              | `SqliteKVNamespace`                         | SQLite `kv` table            |
| R2              | `FileR2Bucket`                              | Filesystem `.lopata/r2/`     |
| D1              | `openD1Database()`                          | Filesystem `.lopata/d1/*.db` |
| Durable Objects | `DurableObjectNamespaceImpl` + `SqlStorage` | SQLite `do_*` tables         |
| Workflows       | `SqliteWorkflowBinding`                     | SQLite `workflow_*` tables   |
| Queues          | `SqliteQueueProducer` + `QueueConsumer`     | SQLite `queue_*` tables      |
| Cache           | `SqliteCacheStorage`                        | SQLite `cache_entries`       |
| Service Binding | Proxy-based (resolves target worker lazily) | In-memory                    |

### Environment building (`src/env.ts`)

`buildEnv()` creates the `env` object with all binding instances. `wireClassRefs()` runs after worker module import to find exported DO/Workflow classes and connect them to their namespaces via `_setClass(cls, env)`. A mutable `globalEnv` reference is shared across module graphs via `setGlobalEnv()`.

### Multi-worker & service bindings

`lopata.config.ts` defines multi-worker setups. `WorkerRegistry` (`src/worker-registry.ts`) maps worker names to `GenerationManager` instances. Service bindings (`src/bindings/service-binding.ts`) use Proxy to intercept `.fetch()` and RPC method calls, resolving target workers lazily to support hot-reload.

### Generation & hot-reload (`src/generation-manager.ts`)

`GenerationManager.reload()` creates a fresh `Generation` with serialized queue (no overlapping reloads). Drains old generation, waits grace period, then force-stops. `patchFrameworkDispatch()` wraps Hono handlers to preserve async stacks destroyed by `.then()/.catch()`.

### Tracing (`src/tracing/`)

Uses `AsyncLocalStorage` to track active trace/span context. `startSpan()` creates hierarchical spans. `instrumentBinding()` wraps binding methods in child spans that capture args and return values. Console output is captured as span events. Dashboard streams traces via WebSocket.

### Dashboard (`src/dashboard/`)

Preact + Tailwind frontend with RPC API (`src/api/`). API dispatch (`src/api/dispatch.ts`) routes ~30 procedures to handler modules in `src/api/handlers/`. Dashboard assets are pre-built via `bun scripts/build-assets.ts` for published package.

### Vite plugin (`src/vite-plugin/`)

Five sub-plugins: `modules-plugin` (resolves virtual CF modules via `globalThis.__lopata_env` proxy), `globals-plugin` (injects global APIs), `config-plugin` (SSR config), `dev-server-plugin` (main middleware — intercepts requests, calls worker fetch, serves dashboard), `react-router-plugin` (React Router integration).

### Config system

- **Wrangler config** (`src/config.ts`): parses `wrangler.toml`/`.jsonc`/`.json`, defines all binding types, supports env overrides
- **Lopata config** (`src/lopata-config.ts`): multi-worker orchestration, isolation modes (`dev` = in-process DO, `isolated` = worker threads), browser/cron config

## Testing patterns

Tests use in-memory SQLite databases. Standard setup:

```ts
let db: Database
beforeEach(() => {
	db = new Database(':memory:')
	runMigrations(db)
	binding = new SomeBinding(db, 'NAMESPACE')
})
```

### What to test

- Persistence — data survives across instances
- Isolation — namespaces don't leak into each other
- Concurrency and ordering — serialization, blocking, race conditions
- Error handling — invalid inputs, limits, edge cases
- Integration wiring — components work end-to-end
- API contract behavior — buffering, state machines, retries, idempotency

### What NOT to test

- Trivial getters/setters, hardcoded constants, no-op methods, default values
- Object identity truisms, JS language features
- DB schema column names — functional tests catch schema issues

## Bun preferences

Default to Bun APIs over Node.js equivalents:

- `bun:sqlite` not `better-sqlite3`
- `Bun.serve()` not `express`
- `Bun.file` over `node:fs` readFile/writeFile
- `Bun.$` instead of `execa`
- Bun auto-loads `.env`, don't use `dotenv`
