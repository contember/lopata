// Plugin is registered via preload (bunfig.toml / --preload flag)
import "./plugin";
import { autoLoadConfig } from "./config";
import { GenerationManager } from "./generation-manager";
import { FileWatcher } from "./file-watcher";
import { QueuePullConsumer } from "./bindings/queue";
import type { PullRequest, AckRequest } from "./bindings/queue";
import { getDatabase } from "./db";
import { addCfProperty } from "./request-cf";
import { handleDashboardRequest, dashboardHtml, setDashboardConfig, setGenerationManager } from "./dashboard/api";
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

// Pass config to dashboard so it can show configured-but-empty bindings
setDashboardConfig(config);

// 2. Create generation manager and load first generation
const manager = new GenerationManager(config, baseDir);
const firstGen = await manager.reload();
console.log(`[bunflare] Generation ${firstGen.id} loaded`);

// Pass manager to dashboard for generation endpoints
setGenerationManager(manager);

// 3. File watcher — watch the source directory
const srcDir = path.dirname(path.resolve(baseDir, config.main));
const watcher = new FileWatcher(srcDir, () => {
  manager.reload().then(gen => {
    console.log(`[bunflare] Reloaded → generation ${gen.id}`);
  }).catch(err => {
    console.error("[bunflare] Reload failed:", err);
  });
});
watcher.start();
console.log(`[bunflare] Watching ${srcDir} for changes`);

// 4. Start server — one Bun.serve(), delegates to active generation
const port = parseInt(process.env.PORT ?? "8787", 10);

const server = Bun.serve({
  port,
  routes: {
    "/__dashboard": dashboardHtml,
  },
  async fetch(request, server) {
    addCfProperty(request);

    const url = new URL(request.url);

    // Dashboard API routes
    if (url.pathname === "/__dashboard/api/rpc") {
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
      const gen = manager.active;
      if (!gen) return new Response("No active generation", { status: 503 });
      const cronExpr = url.searchParams.get("cron") ?? "* * * * *";
      return gen.callScheduled(cronExpr);
    }

    // Delegate to active generation
    const gen = manager.active;
    if (!gen) {
      return new Response("No active generation", { status: 503 });
    }

    return (await gen.callFetch(request, server)) as Response;
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
      if (cfSocket._peer && cfSocket._peer._accepted) {
        cfSocket._peer._dispatchWSEvent({ type: "message", data: typeof message === "string" ? message : message.buffer as ArrayBuffer });
      } else if (cfSocket._peer) {
        cfSocket._peer._eventQueue.push({ type: "message", data: typeof message === "string" ? message : message.buffer as ArrayBuffer });
      }
    },
    close(ws, code, reason) {
      const cfSocket = (ws.data as unknown as { cfSocket: CFWebSocket }).cfSocket;
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
