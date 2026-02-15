import type { WranglerConfig } from "./config";
import type { DurableObjectNamespaceImpl } from "./bindings/durable-object";
import type { SqliteWorkflowBinding } from "./bindings/workflow";
import { QueueConsumer } from "./bindings/queue";
import { startCronScheduler, createScheduledController } from "./bindings/scheduled";
import { ExecutionContext } from "./execution-context";
import { CFWebSocket } from "./bindings/websocket-pair";
import { getDatabase } from "./db";
import { startSpan, setSpanAttribute } from "./tracing/span";

interface ClassRegistry {
  durableObjects: { bindingName: string; className: string; namespace: DurableObjectNamespaceImpl }[];
  workflows: { bindingName: string; className: string; binding: SqliteWorkflowBinding }[];
  containers: { className: string; image: string; maxInstances?: number; namespace: DurableObjectNamespaceImpl }[];
  queueConsumers: { queue: string; maxBatchSize: number; maxBatchTimeout: number; maxRetries: number; deadLetterQueue: string | null }[];
  serviceBindings: { bindingName: string; serviceName: string; entrypoint?: string; proxy: Record<string, unknown> }[];
  staticAssets: { fetch(req: Request): Promise<Response> } | null;
}

export type GenerationState = "active" | "draining" | "stopped";

export interface GenerationInfo {
  id: number;
  state: GenerationState;
  createdAt: number;
  activeRequests: number;
}

export class Generation {
  readonly id: number;
  state: GenerationState = "active";
  readonly createdAt: number;
  readonly workerModule: Record<string, unknown>;
  readonly defaultExport: unknown;
  readonly classBasedExport: boolean;
  readonly env: Record<string, unknown>;
  readonly registry: ClassRegistry;
  readonly config: WranglerConfig;
  readonly workerName: string | undefined;
  activeRequests = 0;

  private queueConsumers: QueueConsumer[] = [];
  private cronTimer: NodeJS.Timer | ReturnType<typeof setInterval> | null = null;
  drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    id: number,
    workerModule: Record<string, unknown>,
    defaultExport: unknown,
    classBasedExport: boolean,
    env: Record<string, unknown>,
    registry: ClassRegistry,
    config: WranglerConfig,
    workerName?: string,
  ) {
    this.id = id;
    this.createdAt = Date.now();
    this.workerModule = workerModule;
    this.defaultExport = defaultExport;
    this.classBasedExport = classBasedExport;
    this.env = env;
    this.registry = registry;
    this.config = config;
    this.workerName = workerName;
  }

  /** Get a handler method from the worker module (class-based or object-based) */
  private getHandler(name: string): ((...args: unknown[]) => Promise<void>) | undefined {
    if (this.classBasedExport) {
      if (typeof (this.defaultExport as any).prototype[name] === "function") {
        return (...args: unknown[]) => {
          const ctx = new ExecutionContext();
          const instance = new (this.defaultExport as new (ctx: ExecutionContext, env: unknown) => Record<string, unknown>)(ctx, this.env);
          return (instance[name] as (...a: unknown[]) => Promise<void>)(...args);
        };
      }
      return undefined;
    }
    const method = (this.defaultExport as Record<string, unknown>)?.[name];
    return typeof method === "function" ? method.bind(this.defaultExport) : undefined;
  }

  /** Dispatch a fetch request through this generation's handler */
  async callFetch(request: Request, server: any): Promise<Response | undefined> {
    this.activeRequests++;
    const ctx = new ExecutionContext();
    try {
      const url = new URL(request.url);

      return await startSpan({
        name: `${request.method} ${url.pathname}`,
        kind: "server",
        attributes: { "http.method": request.method, "http.url": request.url },
        workerName: this.workerName,
      }, async () => {
        const callWorkerFetch = async (req: Request) => {
          if (this.classBasedExport) {
            const instance = new (this.defaultExport as new (ctx: ExecutionContext, env: unknown) => Record<string, unknown>)(ctx, this.env);
            return await (instance.fetch as (r: Request) => Promise<Response>)(req);
          }
          return await (this.defaultExport as { fetch: Function }).fetch(req, this.env, ctx) as Response;
        };

        const handleResponse = (response: Response): Response | undefined => {
          setSpanAttribute("http.status_code", response.status);
          const ws = (response as Response & { webSocket?: CFWebSocket }).webSocket;
          if (response.status === 101 && ws instanceof CFWebSocket) {
            const upgraded = (server as { upgrade(req: Request, opts: { data: unknown }): boolean }).upgrade(request, { data: { cfSocket: ws } });
            if (!upgraded) {
              return new Response("WebSocket upgrade failed", { status: 500 });
            }
            return undefined;
          }
          return response;
        };

        const runWorkerFirst = this.config.assets?.run_worker_first;
        const hasAssets = this.registry.staticAssets && !this.config.assets?.binding;
        const workerFirst = hasAssets && shouldRunWorkerFirst(runWorkerFirst, url.pathname);

        if (workerFirst) {
          try {
            const workerResponse = await callWorkerFetch(request);
            const result = handleResponse(workerResponse);
            if (result === undefined) return undefined;
            if (result.status !== 404) {
              ctx._awaitAll().catch(() => {});
              return result;
            }
          } catch (err) {
            console.error("[bunflare] Request error:", err);
            return new Response("Internal Server Error", { status: 500 });
          }
          return await this.registry.staticAssets!.fetch(request);
        }

        if (hasAssets) {
          const assetResponse = await this.registry.staticAssets!.fetch(request);
          if (assetResponse.status !== 404) {
            return assetResponse;
          }
        }

        try {
          const response = await callWorkerFetch(request);
          const result = handleResponse(response);
          if (result === undefined) return undefined;
          ctx._awaitAll().catch(() => {});
          return result;
        } catch (err) {
          console.error("[bunflare] Request error:", err);
          return new Response("Internal Server Error", { status: 500 });
        }
      });
    } finally {
      this.activeRequests--;
    }
  }

  /** Handle manual /__scheduled trigger */
  async callScheduled(cronExpr: string): Promise<Response> {
    return startSpan({
      name: "scheduled",
      kind: "server",
      attributes: { cron: cronExpr },
      workerName: this.workerName,
    }, async () => {
      const ctx = new ExecutionContext();
      let handler: Function | undefined;
      if (this.classBasedExport) {
        const proto = (this.defaultExport as { prototype: Record<string, unknown> }).prototype;
        if (typeof proto.scheduled === "function") {
          const instance = new (this.defaultExport as new (ctx: ExecutionContext, env: unknown) => Record<string, Function>)(ctx, this.env);
          handler = instance.scheduled!.bind(instance);
        }
      } else {
        const obj = this.defaultExport as Record<string, unknown>;
        if (typeof obj.scheduled === "function") {
          handler = (obj.scheduled as Function).bind(obj);
        }
      }

      if (!handler) {
        return new Response("No scheduled handler defined", { status: 404 });
      }
      const controller = createScheduledController(cronExpr, Date.now());
      try {
        await handler(controller, this.env, ctx);
        await ctx._awaitAll();
        return new Response(`Scheduled handler executed (cron: ${cronExpr})`, { status: 200 });
      } catch (err) {
        console.error("[bunflare] Scheduled handler error:", err);
        throw err;
      }
    });
  }

  /** Start queue consumers and cron scheduler */
  startConsumers(): void {
    const queueHandler = this.getHandler("queue");
    if (this.registry.queueConsumers.length > 0 && queueHandler) {
      const db = getDatabase();
      for (const config of this.registry.queueConsumers) {
        const consumer = new QueueConsumer(db, config, queueHandler as any, this.env);
        consumer.start();
        this.queueConsumers.push(consumer);
      }
    }

    const crons = this.config.triggers?.crons ?? [];
    const scheduledHandler = this.getHandler("scheduled");
    if (crons.length > 0 && scheduledHandler) {
      this.cronTimer = startCronScheduler(crons, scheduledHandler as any, this.env);
    }
  }

  /** Stop queue consumers and cron scheduler */
  stopConsumers(): void {
    for (const consumer of this.queueConsumers) {
      consumer.stop();
    }
    this.queueConsumers = [];
    if (this.cronTimer) {
      clearInterval(this.cronTimer);
      this.cronTimer = null;
    }
  }

  /** Transition to draining — stops consumers, keeps in-flight requests alive */
  drain(): void {
    if (this.state === "stopped") return;
    this.state = "draining";
    this.stopConsumers();
  }

  /** Force-stop: drain + destroy all DO namespaces + abort workflows */
  stop(): void {
    if (this.state === "stopped") return;
    this.drain();
    this.state = "stopped";
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    for (const entry of this.registry.durableObjects) {
      entry.namespace.destroy();
    }
    for (const entry of this.registry.workflows) {
      entry.binding.abortRunning();
    }
  }

  /** Check if this generation has no more work */
  isIdle(): boolean {
    if (this.activeRequests > 0) return false;
    for (const entry of this.registry.durableObjects) {
      // Check if any DO instances still have active WebSockets
      const ns = entry.namespace as any;
      if (ns.instances) {
        for (const [, instance] of ns.instances as Map<string, any>) {
          const state = instance.ctx;
          if (state.getWebSockets().length > 0) return false;
        }
      }
    }
    return true;
  }

  /** Get info for dashboard */
  getInfo(): GenerationInfo {
    return {
      id: this.id,
      state: this.state,
      createdAt: this.createdAt,
      activeRequests: this.activeRequests,
    };
  }
}

function shouldRunWorkerFirst(config: boolean | string[] | undefined, pathname: string): boolean {
  if (config === true) return true;
  if (!config) return false;
  return config.some(pattern => {
    if (pattern === pathname) return true;
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1);
      return pathname.startsWith(prefix) || pathname === pattern.slice(0, -2);
    }
    return false;
  });
}
