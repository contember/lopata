// Plugin is registered via preload (bunfig.toml / --preload flag)
import "./plugin";
import { loadConfig } from "./config";
import { buildEnv, wireClassRefs } from "./env";
import { QueueConsumer } from "./bindings/queue";
import { createScheduledController, startCronScheduler } from "./bindings/scheduled";
import { getDatabase } from "./db";
import path from "node:path";

// 1. Parse config
const configPath = path.resolve(import.meta.dir, "../wrangler.jsonc");
const config = await loadConfig(configPath);
console.log(`[bunflare] Loaded config: ${config.name}`);

// 2. Build env with bindings and environment variables
const devVarsPath = path.resolve(import.meta.dir, "../.dev.vars");
const { env, registry } = buildEnv(config, devVarsPath);

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

    try {
      return await handler.fetch(request, env, ctx);
    } catch (err) {
      console.error("[bunflare] Request error:", err);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
});

console.log(`[bunflare] Server running at http://localhost:${port}`);
