
## Project: Bunflare

Pure TypeScript runtime that runs Cloudflare Worker code in Bun with local binding implementations (no workerd, no miniflare).

- Worker source: `src/` (Cloudflare Worker code)
- Runtime: `runtime/` (local Bun-based shim for Cloudflare APIs)
- Tests: `runtime/tests/` (integration tests for each binding)
- Issues: `docs/issues/` (implementation tasks)
- Status: `docs/STATUS.md` (progress tracking)

### Commands

- `bun runtime/dev.ts` — start the local dev server (port 8787)
- `bun test runtime/tests/` — run integration tests
- `bunx tsc --noEmit` — type check

### Key patterns

- `runtime/plugin.ts` uses `Bun.plugin()` with `build.module()` to shim `cloudflare:workers` and `cloudflare:workflows`
- All bindings persist to SQLite (`.bunflare/data.sqlite`) or files (`.bunflare/r2/`), NOT in-memory
- `runtime/env.ts` builds the `env` object and wires DO/Workflow classes after worker module import
- Each binding has its own test file in `runtime/tests/`

---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

### What to test

- Persistence — data survives across instances/restarts
- Isolation — namespaces, instances, tenants don't leak into each other
- Concurrency and ordering — serialization, blocking, race conditions
- Error handling and validation — invalid inputs, limits, edge cases
- Integration wiring — components work together end-to-end (e.g. DO accessible through namespace proxy)
- API contract behavior — buffering, state machines, retries, idempotency

### What NOT to test

- Getters/setters that just store and return a value (`x.name = "foo"; expect(x.name).toBe("foo")`)
- Hardcoded constants or static values (`expect(CONNECTING).toBe(0)`)
- That a no-op method doesn't throw (`expect(() => noOp()).not.toThrow()`)
- Default values of unset properties (`expect(x.field).toBeUndefined()`)
- Object identity truisms (`expect(x.prop).toBe(x.prop)`)
- JavaScript language features (`Object.freeze`, `typeof`, `===`)
- DB schema column names — any functional test will catch schema issues

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";

// import .css files directly and it works
import './index.css';

import { createRoot } from "react-dom/client";

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.md`.
