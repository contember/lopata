// Plugin is registered via preload (bunfig.toml / --preload flag)
import "./plugin";
import { autoLoadConfig } from "./config";
import { buildEnv, wireClassRefs } from "./env";
import { QueueConsumer } from "./bindings/queue";
import { createScheduledController, startCronScheduler } from "./bindings/scheduled";
import { getDatabase } from "./db";
import path from "node:path";

// Parse --env flag from CLI args
const envFlag = (() => {
  const idx = process.argv.indexOf("--env");
  return idx !== -1 ? process.argv[idx + 1] : undefined;
})();

// 1. Parse config (auto-detect wrangler.jsonc / wrangler.json / wrangler.toml)
const baseDir = path.resolve(import.meta.dir, "..");
const config = await autoLoadConfig(baseDir, envFlag);
console.log(`[bunflare] Loaded config: ${config.name}${envFlag ? ` (env: ${envFlag})` : ""}`);

// 2. Build env with bindings and environment variables (.dev.vars or .env)
const { env, registry } = buildEnv(config, baseDir);

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

// 6. Start queue consumers
if (registry.queueConsumers.length > 0 && workerModule.default?.queue) {
  const db = getDatabase();
  for (const config of registry.queueConsumers) {
    const consumer = new QueueConsumer(db, config, workerModule.default.queue.bind(workerModule.default), env);
    consumer.start();
    console.log(`[bunflare] Queue consumer started: ${config.queue}`);
  }
}

// 7. Start cron scheduler
const crons = config.triggers?.crons ?? [];
if (crons.length > 0 && workerModule.default?.scheduled) {
  startCronScheduler(crons, workerModule.default.scheduled.bind(workerModule.default), env);
  for (const cron of crons) {
    console.log(`[bunflare] Cron registered: ${cron}`);
  }
}

// 8. Start server
const port = parseInt(process.env.PORT ?? "8787", 10);

Bun.serve({
  port,
  async fetch(request) {
    const ctx = {
      waitUntil(_promise: Promise<unknown>) {},
      passThroughOnException() {},
    };

    // Manual trigger: GET /__scheduled?cron=<expression>
    const url = new URL(request.url);
    if (url.pathname === "/__scheduled") {
      const scheduledHandler = workerModule.default?.scheduled;
      if (!scheduledHandler) {
        return new Response("No scheduled handler defined", { status: 404 });
      }
      const cronExpr = url.searchParams.get("cron") ?? "* * * * *";
      const controller = createScheduledController(cronExpr, Date.now());
      try {
        await scheduledHandler.call(workerModule.default, controller, env, ctx);
        return new Response(`Scheduled handler executed (cron: ${cronExpr})`, { status: 200 });
      } catch (err) {
        console.error("[bunflare] Scheduled handler error:", err);
        return new Response("Scheduled handler error", { status: 500 });
      }
    }

    // Determine asset/worker ordering based on run_worker_first
    const runWorkerFirst = config.assets?.run_worker_first;
    const hasAssets = registry.staticAssets && !config.assets?.binding;
    const workerFirst = hasAssets && shouldRunWorkerFirst(runWorkerFirst, url.pathname);

    if (workerFirst) {
      // Worker first, fall back to assets
      try {
        const workerResponse = await handler.fetch(request, env, ctx);
        if (workerResponse.status !== 404) {
          return workerResponse;
        }
      } catch (err) {
        console.error("[bunflare] Request error:", err);
        return new Response("Internal Server Error", { status: 500 });
      }
      return await registry.staticAssets!.fetch(request);
    }

    // Assets first (default), fall back to worker
    if (hasAssets) {
      const assetResponse = await registry.staticAssets!.fetch(request);
      if (assetResponse.status !== 404) {
        return assetResponse;
      }
    }

    try {
      return await handler.fetch(request, env, ctx);
    } catch (err) {
      console.error("[bunflare] Request error:", err);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
});

console.log(`[bunflare] Server running at http://localhost:${port}`);

function shouldRunWorkerFirst(config: boolean | string[] | undefined, pathname: string): boolean {
  if (config === true) return true;
  if (!config) return false;
  // Array of route patterns
  return config.some(pattern => {
    if (pattern === pathname) return true;
    // Simple glob: /api/* matches /api/anything
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1); // "/api/"
      return pathname.startsWith(prefix) || pathname === pattern.slice(0, -2);
    }
    return false;
  });
}
