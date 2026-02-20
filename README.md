# Lopata

> **This is a local development tool only.** Lopata is not intended for production use and never will be. Always deploy to Cloudflare Workers for production workloads.

> **Alpha software.** Lopata is in early development. APIs and behavior may change. We'd love for you to try it out and [report any issues](https://github.com/contember/lopata/issues) you find.

Drop-in replacement for `wrangler dev` and `@cloudflare/vite-plugin`, powered by Bun. Run your Cloudflare Worker code locally with real bindings — no workerd, no miniflare.

## Why Lopata?

The official `wrangler dev` uses workerd (the Cloudflare Workers runtime) under the hood via miniflare. While this gives you high-fidelity emulation, it comes with trade-offs that hurt the daily development experience:

- **Slow startup and reload** — workerd is a separate process that needs to spin up an isolate, bundle your code, and establish IPC. Every code change goes through this cycle, adding noticeable latency to the feedback loop.
- **Difficult debugging** — because your code runs inside workerd (not your local JS runtime), setting breakpoints, inspecting variables, and stepping through code requires a remote debugging protocol. Stack traces from binding errors are often opaque.
- **Vite integration friction** — `@cloudflare/vite-plugin` bridges two worlds (Vite's Node/Bun process and workerd), leading to subtle issues with HMR, module resolution, and error reporting.
- **Heavy resource usage** — running workerd alongside your dev toolchain consumes significant memory and CPU, especially with Durable Objects or multiple workers.

Lopata takes a different approach: it implements all Cloudflare bindings natively in TypeScript and runs your worker code directly in Bun. Everything is in-process — bindings are backed by SQLite and the local filesystem, Durable Objects share the same memory, and there's no IPC overhead. The result is near-instant startup, fast hot-reload, easy debugging with normal breakpoints, and a built-in dashboard with real-time request tracing.

**The trade-off:** Lopata runs on Bun, not workerd. While the binding APIs are faithfully reimplemented (~90–95% coverage), the underlying runtime differs. Edge cases in V8 isolate semantics, request/response body handling, or undocumented Cloudflare behavior may not match exactly. For non-trivial logic, always verify your code against the official runtime (`wrangler dev` or a staging deployment) before shipping to production.

## Features

- **All major bindings** — KV, R2, D1, Durable Objects (with SQL API and WebSocket Hibernation), Workflows, Queues, Cache, Service Bindings, Static Assets, Images, Hyperdrive, Analytics Engine, Browser Rendering, Containers, Scheduled (Cron), Email
- **Persistent local state** — data lives in `.lopata/` (SQLite + filesystem), survives restarts
- **Dashboard** — browse bindings, inspect data, view request traces in real-time
- **Vite plugin** — integrates with React Router and other Vite-based frameworks
- **Multi-worker support** — run multiple workers with service bindings between them
- **Hot-reload** — file changes trigger instant reload with zero downtime
- **Request tracing** — hierarchical spans for every request, binding call, and outbound fetch
- **Cloudflare module shims** — `cloudflare:workers`, `cloudflare:workflows`, `@cloudflare/containers`, `@cloudflare/puppeteer` all work out of the box
- **Global API compatibility** — `caches`, `HTMLRewriter`, `WebSocketPair`, `scheduler.wait()`, `crypto.timingSafeEqual`, and more

## Requirements

- [Bun](https://bun.sh) v1.1+

## Quick start

### Standalone dev server

```bash
bun add -d lopata
bunx lopata dev
```

This starts a local server on `http://localhost:8787` with all bindings from your `wrangler.toml` / `wrangler.jsonc` ready to use. The dashboard is available at `http://localhost:8787/__dashboard`.

### Vite plugin

```bash
bun add -d lopata
```

```ts
// vite.config.ts
import { lopata } from 'lopata/vite-plugin'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    lopata(),
    // ... your framework plugin (e.g. reactRouter())
  ],
})
```

Then start your dev server with Bun:

```bash
bun --bun vite dev
# or for React Router:
bun --bun react-router dev
```

> **Note:** `bun --bun` is required to override Node.js shebangs so Bun handles `bun:sqlite` and `.ts` imports natively.

## CLI

```
lopata <command> [options]

Commands:
  dev                              Start local dev server

  d1 list                          List D1 databases
  d1 execute <db> --command <sql>  Execute SQL on a D1 database
  d1 migrations apply [db]         Apply D1 migrations

  r2 object list [bucket/prefix]   List R2 objects
  r2 object get <bucket/key>       Get an R2 object
  r2 object put <bucket/key> -f    Upload a file to R2
  r2 object delete <bucket/key>    Delete an R2 object

  kv key list                      List KV keys
  kv key get <key>                 Get a KV value
  kv key put <key> <value>         Put a KV value
  kv key delete <key>              Delete a KV key

  queues list                      List queues
  queues message list <queue>      List queue messages
  queues message send <queue>      Send a message
  queues message purge <queue>     Purge queue messages

  cache list                       List cache names
  cache purge [--name <cache>]     Purge cache entries

  trace list [--limit N]           List recent traces
  trace get <traceId>              Get trace detail

Global flags:
  --config, -c <path>   Path to wrangler config file
  --env, -e <name>      Environment name
  --help, -h            Show help
```

### Dev server flags

```bash
lopata dev [--port 8787] [--listen localhost] [--env production]
```

### Special dev endpoints

The dev server exposes endpoints for triggering handlers manually:

```bash
# Trigger a scheduled handler
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*"

# Simulate an inbound email
curl -X POST "http://localhost:8787/cdn-cgi/handler/email?from=a@b.com&to=c@d.com"
```

## Configuration

Lopata reads your standard Cloudflare config file, auto-detected in order: `wrangler.jsonc`, `wrangler.json`, `wrangler.toml`.

```jsonc
// wrangler.jsonc
{
  "name": "my-worker",
  "main": "src/index.ts",
  "compatibility_date": "2025-01-01",
  "kv_namespaces": [
    { "binding": "KV", "id": "..." }
  ],
  "r2_buckets": [
    { "binding": "R2", "bucket_name": "my-bucket" }
  ],
  "d1_databases": [
    { "binding": "DB", "database_name": "my-db", "database_id": "..." }
  ],
  "durable_objects": {
    "bindings": [
      { "name": "COUNTER", "class_name": "Counter" }
    ]
  },
  "queues": {
    "producers": [{ "binding": "MY_QUEUE", "queue": "my-queue" }],
    "consumers": [{ "queue": "my-queue", "max_batch_size": 10 }]
  },
  "workflows": [
    { "name": "my-workflow", "binding": "WORKFLOW", "class_name": "MyWorkflow" }
  ]
}
```

### Environment variables and secrets

Variables are loaded in this order (later overrides earlier):

1. `[vars]` in wrangler config
2. `.dev.vars` file (dotenv format)
3. `.env` file (fallback if no `.dev.vars`)
4. `.dev.vars.<environment>` for env-specific overrides

## Multi-worker setup

For projects with multiple workers and service bindings, create a `lopata.config.ts`:

```ts
// lopata.config.ts
export default {
  main: './wrangler.jsonc',
  workers: [
    { name: 'auth-worker', config: './workers/auth/wrangler.jsonc' },
    { name: 'email-worker', config: './workers/email/wrangler.jsonc' },
  ],
  // Optional settings:
  cron: true,               // Enable real cron scheduling
  isolation: 'dev',         // 'dev' (in-process) or 'isolated' (worker threads)
  browser: {                // Browser Rendering config
    headless: true,
  },
}
```

Workers can call each other via service bindings configured in their respective `wrangler.jsonc`. Both HTTP (`binding.fetch()`) and RPC (`binding.myMethod()`) modes are supported, including promise pipelining.

## Vite plugin

The Vite plugin is a drop-in replacement for `@cloudflare/vite-plugin`. It provides:

- Virtual module resolution (`cloudflare:workers`, `cloudflare:workflows`, `@cloudflare/containers`)
- Global Cloudflare API injection (`caches`, `HTMLRewriter`, `WebSocketPair`, etc.)
- Dev server middleware that intercepts requests and calls your worker's `fetch()` handler
- Dashboard and tracing at `/__dashboard`
- React Router integration with automatic loader/action instrumentation

```ts
// vite.config.ts
import { reactRouter } from '@react-router/dev/vite'
import { lopata } from 'lopata/vite-plugin'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    lopata({
      configPath: './wrangler.jsonc',          // Optional, auto-detected
      viteEnvironment: { name: 'ssr' },        // Optional, default 'ssr'
      auxiliaryWorkers: [                       // Optional, for multi-worker
        { configPath: './workers/auth/wrangler.jsonc' },
      ],
    }),
    reactRouter(),
  ],
})
```

## Dashboard

The built-in dashboard is available at `/__dashboard` and provides:

- **Traces** — real-time request waterfall with filtering by path, status, and attributes
- **KV** — browse namespaces, keys, and values
- **R2** — browse buckets and objects
- **D1** — SQL browser for all D1 databases
- **Durable Objects** — inspect instances and their storage
- **Queues** — browse and manage queue messages
- **Workflows** — view workflow instances, status, and step history
- **Cache** — browse cache entries
- **Analytics Engine** — browse data points
- **Email** — view captured outbound emails
- **Scheduled** — manually trigger cron handlers
- **AI** — browse AI binding request logs
- **Containers** — manage running containers

## Supported bindings

| Binding | Storage | Coverage |
|---------|---------|----------|
| **KV** | SQLite | 100% |
| **R2** | Filesystem (`.lopata/r2/`) | ~95% |
| **D1** | SQLite files (`.lopata/d1/`) | ~90% |
| **Durable Objects** | SQLite (KV + SQL API) | ~90% |
| **Workflows** | SQLite | 100% |
| **Queues** | SQLite | ~90% |
| **Cache API** | SQLite | 100% |
| **Static Assets** | Filesystem | ~90% |
| **Service Bindings** | In-process | ~85% |
| **Scheduled (Cron)** | In-memory timer | 100% |
| **Images** | Sharp | ~80% |
| **Hyperdrive** | TCP via `Bun.connect()` | Passthrough |
| **Workers AI** | Proxies to Cloudflare API | Passthrough |
| **Analytics Engine** | SQLite | Full |
| **Browser Rendering** | Local Puppeteer | Full |
| **Containers** | Docker | Full |
| **Send Email** | SQLite (captured) | Full |

Overall compatibility: **~90–95%** of the Cloudflare Workers API surface.

## Local data

All persistent state is stored in `.lopata/` in your project directory:

```
.lopata/
  data.sqlite     # KV, DO, Workflows, Queues, Cache, Analytics, AI logs, Email
  r2/             # R2 object storage
  d1/             # D1 databases (one .db file per database)
```

Add `.lopata/` to your `.gitignore`.

## How it differs from Wrangler

| | Lopata | Wrangler (`wrangler dev`) |
|---|---|---|
| **Runtime** | Bun | workerd (via miniflare) |
| **Bindings** | Native TypeScript implementations | workerd built-in |
| **Durable Objects** | In-process (shared memory, easy debugging) | Isolated (faithful to production) |
| **Module shims** | `Bun.plugin()` virtual modules | workerd native modules |
| **Dashboard** | Built-in with real-time tracing | Separate (Cloudflare dashboard) |
| **Vite integration** | Drop-in plugin | `@cloudflare/vite-plugin` |
| **Config** | Reads `wrangler.toml`/`.jsonc`/`.json` | Same |

## License

MIT
