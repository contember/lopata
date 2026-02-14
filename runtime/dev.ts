// Plugin is registered via preload (bunfig.toml / --preload flag)
import "./plugin";
import { autoLoadConfig, loadConfig } from "./config";
import { GenerationManager } from "./generation-manager";
import { FileWatcher } from "./file-watcher";
import { WorkerRegistry } from "./worker-registry";
import { loadBunflareConfig } from "./bunflare-config";
import { QueuePullConsumer } from "./bindings/queue";
import type { PullRequest, AckRequest } from "./bindings/queue";
import { getDatabase } from "./db";
import { addCfProperty } from "./request-cf";
import { handleDashboardRequest, dashboardHtml, setDashboardConfig, setGenerationManager, setWorkerRegistry } from "./dashboard/api";
import { CFWebSocket } from "./bindings/websocket-pair";
import path from "node:path";

// Parse CLI flags
function parseFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const envFlag = parseFlag("--env");
const listenFlag = parseFlag("--listen");
const portFlag = parseFlag("--port");

const baseDir = path.resolve(import.meta.dir, "..");
const watchers: FileWatcher[] = [];

// Try to load bunflare.config.ts for multi-worker mode
const bunflareConfig = await loadBunflareConfig(baseDir);

let manager: GenerationManager;

if (bunflareConfig) {
  // ─── Multi-worker mode ─────────────────────────────────────────
  console.log("[bunflare] Multi-worker mode (bunflare.config.ts found)");

  const registry = new WorkerRegistry();

  // Load main worker config
  const mainConfig = await loadConfig(bunflareConfig.main, envFlag);
  const mainBaseDir = path.dirname(bunflareConfig.main);
  console.log(`[bunflare] Main worker: ${mainConfig.name}${envFlag ? ` (env: ${envFlag})` : ""}`);
  setDashboardConfig(mainConfig);

  const mainManager = new GenerationManager(mainConfig, mainBaseDir, {
    workerName: mainConfig.name,
    workerRegistry: registry,
    isMain: true,
  });
  registry.register(mainConfig.name, mainManager, true);

  // Load auxiliary workers
  for (const workerDef of bunflareConfig.workers ?? []) {
    const auxConfig = await loadConfig(workerDef.config, envFlag);
    const auxBaseDir = path.dirname(workerDef.config);
    console.log(`[bunflare] Auxiliary worker: ${workerDef.name} (${auxConfig.name})`);

    const auxManager = new GenerationManager(auxConfig, auxBaseDir, {
      workerName: workerDef.name,
      workerRegistry: registry,
      isMain: false,
    });
    registry.register(workerDef.name, auxManager);

    // Load aux worker first so main's service bindings can resolve
    try {
      const gen = await auxManager.reload();
      console.log(`[bunflare] Auxiliary worker "${workerDef.name}" → generation ${gen.id}`);
    } catch (err) {
      console.error(`[bunflare] Failed to load auxiliary worker "${workerDef.name}":`, err);
    }

    // File watcher for aux worker
    const auxSrcDir = path.dirname(path.resolve(auxBaseDir, auxConfig.main));
    const auxWatcher = new FileWatcher(auxSrcDir, () => {
      auxManager.reload().then(gen => {
        console.log(`[bunflare] Auxiliary worker "${workerDef.name}" reloaded → generation ${gen.id}`);
      }).catch(err => {
        console.error(`[bunflare] Reload failed for "${workerDef.name}":`, err);
      });
    });
    auxWatcher.start();
    watchers.push(auxWatcher);
    console.log(`[bunflare] Watching ${auxSrcDir} for changes (${workerDef.name})`);
  }

  // Load main worker after aux workers
  const firstGen = await mainManager.reload();
  console.log(`[bunflare] Main worker → generation ${firstGen.id}`);

  manager = mainManager;
  setGenerationManager(manager);
  setWorkerRegistry(registry);

  // File watcher for main worker
  const mainSrcDir = path.dirname(path.resolve(mainBaseDir, mainConfig.main));
  const mainWatcher = new FileWatcher(mainSrcDir, () => {
    mainManager.reload().then(gen => {
      console.log(`[bunflare] Main worker reloaded → generation ${gen.id}`);
    }).catch(err => {
      console.error("[bunflare] Reload failed:", err);
    });
  });
  mainWatcher.start();
  watchers.push(mainWatcher);
  console.log(`[bunflare] Watching ${mainSrcDir} for changes (main)`);
} else {
  // ─── Single-worker mode (current behavior) ────────────────────
  const config = await autoLoadConfig(baseDir, envFlag);
  console.log(`[bunflare] Loaded config: ${config.name}${envFlag ? ` (env: ${envFlag})` : ""}`);
  setDashboardConfig(config);

  manager = new GenerationManager(config, baseDir);
  const firstGen = await manager.reload();
  console.log(`[bunflare] Generation ${firstGen.id} loaded`);
  setGenerationManager(manager);

  // File watcher — watch the source directory
  const srcDir = path.dirname(path.resolve(baseDir, config.main));
  const watcher = new FileWatcher(srcDir, () => {
    manager.reload().then(gen => {
      console.log(`[bunflare] Reloaded → generation ${gen.id}`);
    }).catch(err => {
      console.error("[bunflare] Reload failed:", err);
    });
  });
  watcher.start();
  watchers.push(watcher);
  console.log(`[bunflare] Watching ${srcDir} for changes`);
}

// 4. Start server — one Bun.serve(), delegates to active generation
const port = parseInt(portFlag ?? process.env.PORT ?? "8787", 10);
const hostname = listenFlag ?? process.env.HOST ?? "localhost";

const server = Bun.serve({
  port,
  hostname,
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

console.log(`[bunflare] Server running at http://${hostname}:${port}`);
console.log(`[bunflare] Dashboard: http://${hostname}:${port}/__dashboard`);
