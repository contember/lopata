// Plugin is registered via preload (bunfig.toml / --preload flag)
import "./plugin";
import { autoLoadConfig } from "./config";
import { buildEnv, wireClassRefs } from "./env";
import { QueueConsumer, QueuePullConsumer } from "./bindings/queue";
import type { PullRequest, AckRequest } from "./bindings/queue";
import { createScheduledController, startCronScheduler } from "./bindings/scheduled";
import { getDatabase } from "./db";
import { ExecutionContext } from "./execution-context";
import { addCfProperty } from "./request-cf";
import { handleDashboardRequest, dashboardHtml } from "./dashboard/api";
import { CFWebSocket } from "./bindings/websocket-pair";
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

// 5. Get the default export and detect class-based vs object-based
const defaultExport = workerModule.default;

function isEntrypointClass(exp: unknown): exp is new (ctx: ExecutionContext, env: unknown) => Record<string, unknown> {
  return typeof exp === "function" && exp.prototype &&
    typeof exp.prototype.fetch === "function";
}

const classBasedExport = isEntrypointClass(defaultExport);

if (!classBasedExport && !defaultExport?.fetch) {
  throw new Error("Worker module must export a default object with a fetch() method, or a class with a fetch() method on its prototype");
}

// Helper to get the scheduled/queue handler from class or object exports
function getHandler(name: string): ((...args: unknown[]) => Promise<void>) | undefined {
  if (classBasedExport) {
    if (typeof defaultExport.prototype[name] === "function") {
      return (...args: unknown[]) => {
        const ctx = new ExecutionContext();
        const instance = new (defaultExport as new (ctx: ExecutionContext, env: unknown) => Record<string, unknown>)(ctx, env);
        return (instance[name] as (...a: unknown[]) => Promise<void>)(...args);
      };
    }
    return undefined;
  }
  const method = (defaultExport as Record<string, unknown>)?.[name];
  return typeof method === "function" ? method.bind(defaultExport) : undefined;
}

// 6. Start queue consumers
const queueHandler = getHandler("queue");
if (registry.queueConsumers.length > 0 && queueHandler) {
  const db = getDatabase();
  for (const config of registry.queueConsumers) {
    const consumer = new QueueConsumer(db, config, queueHandler as any, env);
    consumer.start();
    console.log(`[bunflare] Queue consumer started: ${config.queue}`);
  }
}

// 7. Start cron scheduler
const crons = config.triggers?.crons ?? [];
const scheduledHandler = getHandler("scheduled");
if (crons.length > 0 && scheduledHandler) {
  startCronScheduler(crons, scheduledHandler as any, env);
  for (const cron of crons) {
    console.log(`[bunflare] Cron registered: ${cron}`);
  }
}

// 8. Start server
const port = parseInt(process.env.PORT ?? "8787", 10);

const server = Bun.serve({
  port,
  routes: {
    "/__dashboard": dashboardHtml,
  },
  async fetch(request, server) {
    const ctx = new ExecutionContext();
    addCfProperty(request);

    const url = new URL(request.url);

    // Dashboard API routes
    if (url.pathname.startsWith("/__dashboard/api")) {
      return handleDashboardRequest(request);
    }

    // Queue pull consumer endpoints: POST /__queues/<name>/messages/pull and /ack
    const queuePullMatch = url.pathname.match(/^\/__queues\/([^/]+)\/messages\/(pull|ack)$/);
    if (queuePullMatch && request.method === "POST") {
      const queueName = decodeURIComponent(queuePullMatch[1]!);
      const action = queuePullMatch[2]!;
      const queueDb = getDatabase();
      const pullConsumer = new QueuePullConsumer(queueDb, queueName);

      try {
        const body = await request.json() as PullRequest | AckRequest;
        if (action === "pull") {
          const result = pullConsumer.pull(body as PullRequest);
          return Response.json(result);
        } else {
          const result = pullConsumer.ack(body as AckRequest);
          return Response.json(result);
        }
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 400 });
      }
    }

    // Manual trigger: GET /__scheduled?cron=<expression>
    if (url.pathname === "/__scheduled") {
      let handler: Function | undefined;
      if (classBasedExport) {
        const proto = (defaultExport as { prototype: Record<string, unknown> }).prototype;
        if (typeof proto.scheduled === "function") {
          const instance = new (defaultExport as new (ctx: ExecutionContext, env: unknown) => Record<string, Function>)(ctx, env);
          handler = instance.scheduled!.bind(instance);
        }
      } else {
        const obj = defaultExport as Record<string, unknown>;
        if (typeof obj.scheduled === "function") {
          handler = (obj.scheduled as Function).bind(obj);
        }
      }

      if (!handler) {
        return new Response("No scheduled handler defined", { status: 404 });
      }
      const cronExpr = url.searchParams.get("cron") ?? "* * * * *";
      const controller = createScheduledController(cronExpr, Date.now());
      try {
        await handler(controller, env, ctx);
        await ctx._awaitAll();
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

    const callFetch = async (req: Request) => {
      if (classBasedExport) {
        const instance = new (defaultExport as new (ctx: ExecutionContext, env: unknown) => Record<string, unknown>)(ctx, env);
        return await (instance.fetch as (r: Request) => Promise<Response>)(req);
      }
      return await (defaultExport as { fetch: Function }).fetch(req, env, ctx) as Response;
    };

    // Helper: check if response is a WebSocket upgrade and handle it
    const handleResponse = (response: Response) => {
      const ws = (response as Response & { webSocket?: CFWebSocket }).webSocket;
      if (response.status === 101 && ws instanceof CFWebSocket) {
        // Bridge: upgrade the real HTTP connection and link to the CFWebSocket
        const upgraded = (server as { upgrade(req: Request, opts: { data: unknown }): boolean }).upgrade(request, { data: { cfSocket: ws } });
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 500 });
        }
        // Return undefined — Bun handles the upgrade
        return undefined;
      }
      return response;
    };

    if (workerFirst) {
      // Worker first, fall back to assets
      try {
        const workerResponse = await callFetch(request);
        const result = handleResponse(workerResponse);
        if (result === undefined) return undefined as unknown as Response;
        if (result.status !== 404) {
          ctx._awaitAll().catch(() => {});
          return result;
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
      const response = await callFetch(request);
      const result = handleResponse(response);
      if (result === undefined) return undefined as unknown as Response;
      ctx._awaitAll().catch(() => {});
      return result;
    } catch (err) {
      console.error("[bunflare] Request error:", err);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
  websocket: {
    open(ws) {
      const cfSocket = (ws.data as unknown as { cfSocket: CFWebSocket }).cfSocket;
      // Forward messages from cfSocket → real client
      cfSocket.addEventListener("message", (ev: Event) => {
        const data = (ev as MessageEvent).data;
        ws.send(data);
      });
      cfSocket.addEventListener("close", (ev: Event) => {
        const ce = ev as CloseEvent;
        ws.close(ce.code, ce.reason);
      });
    },
    message(ws, message) {
      const cfSocket = (ws.data as unknown as { cfSocket: CFWebSocket }).cfSocket;
      // Forward real client messages → cfSocket's peer (the server side)
      // The cfSocket is the client side — its peer is the server side
      // But we need to deliver the message to cfSocket so the server's peer receives it
      // Actually: cfSocket IS the client socket returned in Response.
      // The server side accepted and listens on the other end.
      // Real client messages should appear on the server side, which is cfSocket's peer.
      if (cfSocket._peer && cfSocket._peer._accepted) {
        cfSocket._peer._dispatchWSEvent({ type: "message", data: typeof message === "string" ? message : message.buffer as ArrayBuffer });
      } else if (cfSocket._peer) {
        cfSocket._peer._eventQueue.push({ type: "message", data: typeof message === "string" ? message : message.buffer as ArrayBuffer });
      }
    },
    close(ws, code, reason) {
      const cfSocket = (ws.data as unknown as { cfSocket: CFWebSocket }).cfSocket;
      // Notify the server side (cfSocket's peer) about close
      if (cfSocket._peer && cfSocket._peer.readyState !== 3 /* CLOSED */) {
        const evt = { type: "close" as const, code: code ?? 1000, reason: reason ?? "", wasClean: true };
        if (cfSocket._peer._accepted) {
          cfSocket._peer._dispatchWSEvent(evt);
        } else {
          cfSocket._peer._eventQueue.push(evt);
        }
        cfSocket._peer.readyState = 3;
      }
      cfSocket.readyState = 3;
    },
  },
});

console.log(`[bunflare] Server running at http://localhost:${port}`);
console.log(`[bunflare] Dashboard: http://localhost:${port}/__dashboard`);

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
