// Plugin is registered via preload (bunfig.toml / --preload flag)
import "./plugin";
import { loadConfig } from "./config";
import { buildEnv, wireClassRefs } from "./env";
import path from "node:path";

// 1. Parse config
const configPath = path.resolve(import.meta.dir, "../wrangler.jsonc");
const config = await loadConfig(configPath);
console.log(`[bunflare] Loaded config: ${config.name}`);

// 2. Build env with in-memory bindings
const { env, registry } = buildEnv(config);

// 3. Import worker module (plugin intercepts cloudflare:workers imports)
const workerPath = path.resolve(import.meta.dir, "..", config.main);
const workerModule = await import(workerPath);

// 4. Wire DO and Workflow class references
wireClassRefs(registry, workerModule, env);

// 5. Get the default export (fetch handler)
const handler = workerModule.default;
if (!handler?.fetch) {
  throw new Error("Worker module must export a default object with a fetch() method");
}

// 6. Start server
const port = parseInt(process.env.PORT ?? "8787", 10);

Bun.serve({
  port,
  async fetch(request) {
    const ctx = {
      waitUntil(_promise: Promise<unknown>) {},
      passThroughOnException() {},
    };

    try {
      return await handler.fetch(request, env, ctx);
    } catch (err) {
      console.error("[bunflare] Request error:", err);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
});

console.log(`[bunflare] Server running at http://localhost:${port}`);
