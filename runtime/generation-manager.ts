import path from "node:path";
import type { WranglerConfig } from "./config";
import { buildEnv, wireClassRefs, setGlobalEnv } from "./env";
import { Generation, type GenerationInfo } from "./generation";
import { ExecutionContext } from "./execution-context";
import type { WorkerRegistry } from "./worker-registry";

function isEntrypointClass(exp: unknown): exp is new (ctx: ExecutionContext, env: unknown) => Record<string, unknown> {
  return typeof exp === "function" && exp.prototype &&
    typeof exp.prototype.fetch === "function";
}

/**
 * Detect and patch web frameworks (Hono, etc.) that use .then()/.catch()
 * for request dispatch. This breaks async stack traces in Bun because
 * errors that propagate through .then() callbacks lose their async context.
 *
 * err.stack is set once at Error creation and doesn't change, but Bun
 * appends async frames (callers) only when the error is caught via `await`,
 * not via `.catch()`. The user's error handler may re-throw inside .catch(),
 * which creates a new rejection without those async frames.
 *
 * Fix: wrap each route handler with try/catch to snapshot err.stack
 * (which includes async frames at that point) before the error enters
 * the .then()/.catch() chain. If the error handler re-throws, we
 * restore the full stack.
 */
function patchFrameworkDispatch(defaultExport: Record<string, unknown>): void {
  if (typeof defaultExport.fetch !== "function") return;

  // Detect Hono by characteristic properties
  const isHono = "routes" in defaultExport && "router" in defaultExport && "_basePath" in defaultExport;
  if (!isHono) return;

  const app = defaultExport as Record<string, any>;
  const routes: { handler: Function }[] = app.routes;
  if (!Array.isArray(routes)) return;

  // Wrap each route handler to capture err.stack before .then() destroys it
  for (const route of routes) {
    const orig = route.handler;
    route.handler = async function (this: unknown, c: unknown, next: unknown) {
      try {
        return await orig.call(this, c, next);
      } catch (err: unknown) {
        // Save the full stack (with async frames) before .then()/.catch() strips them
        if (err instanceof Error) {
          (err as any).__asyncStack = err.stack;
        }
        throw err;
      }
    };
  }

  // Patch error handler: if the user's handler re-throws, restore the saved stack
  const origErrorHandler = app.errorHandler;
  app.errorHandler = (err: unknown, c: unknown) => {
    if (err instanceof Error && (err as any).__asyncStack) {
      err.stack = (err as any).__asyncStack;
      delete (err as any).__asyncStack;
    }
    return origErrorHandler(err, c);
  };
}

export class GenerationManager {
  private generations = new Map<number, Generation>();
  private nextGenId = 1;
  private _activeGenId: number | null = null;
  private _reloading: Promise<Generation> | null = null;
  private _pendingReload = false;

  gracePeriodMs = 10_000;

  readonly config: WranglerConfig;
  readonly baseDir: string;
  readonly workerPath: string;
  readonly workerName: string | undefined;
  readonly workerRegistry: WorkerRegistry | undefined;
  readonly isMain: boolean;

  constructor(config: WranglerConfig, baseDir: string, options?: { workerName?: string; workerRegistry?: WorkerRegistry; isMain?: boolean }) {
    this.config = config;
    this.baseDir = baseDir;
    this.workerPath = path.resolve(baseDir, config.main);
    this.workerName = options?.workerName;
    this.workerRegistry = options?.workerRegistry;
    this.isMain = options?.isMain ?? true;
  }

  /** The currently active generation (receives new requests) */
  get active(): Generation | null {
    if (this._activeGenId === null) return null;
    return this.generations.get(this._activeGenId) ?? null;
  }

  /**
   * Create a new generation by importing the worker module fresh.
   * Serialized: if called while already reloading, queues one reload.
   */
  async reload(): Promise<Generation> {
    if (this._reloading) {
      this._pendingReload = true;
      // Wait for current reload, then re-trigger
      await this._reloading;
      if (this._pendingReload) {
        this._pendingReload = false;
        return this.reload();
      }
      return this.active!;
    }

    this._reloading = this._doReload();
    try {
      return await this._reloading;
    } finally {
      this._reloading = null;
      // If another reload was requested while we were reloading, do it now
      if (this._pendingReload) {
        this._pendingReload = false;
        return this.reload();
      }
    }
  }

  private async _doReload(): Promise<Generation> {
    // 1. Import fresh worker module using cache-busting query string
    const workerModule = await import(`${this.workerPath}?v=${Date.now()}`);

    // 2. Build new env with fresh binding instances (same underlying DB)
    const { env, registry } = buildEnv(this.config, this.baseDir);

    // 3. Wire DO and Workflow class references
    wireClassRefs(registry, workerModule, env, this.workerRegistry);

    // 4. Update globalEnv for cloudflare:workers env export (main worker only)
    if (this.isMain) {
      setGlobalEnv(env);
    }

    // 5. Validate default export
    const defaultExport = workerModule.default;
    const classBasedExport = isEntrypointClass(defaultExport);

    if (!classBasedExport && !defaultExport?.fetch) {
      throw new Error("Worker module must export a default object with a fetch() method, or a class with a fetch() method on its prototype");
    }

    // 5b. Patch frameworks that use .then()/.catch() for dispatch (e.g. Hono)
    // This destroys async stack traces in Bun. We replace their fetch with an
    // async wrapper so errors propagate through proper await chains.
    if (!classBasedExport) {
      patchFrameworkDispatch(defaultExport);
    }

    // 6. Create new generation
    const genId = this.nextGenId++;
    const gen = new Generation(genId, workerModule, defaultExport, classBasedExport, env, registry, this.config, this.workerName);
    this.generations.set(genId, gen);

    // 7. Drain old generation
    const oldGenId = this._activeGenId;
    if (oldGenId !== null) {
      const oldGen = this.generations.get(oldGenId);
      if (oldGen && oldGen.state === "active") {
        oldGen.drain();
        // Schedule force-stop after grace period
        oldGen.drainTimer = setTimeout(() => {
          this._stopGeneration(oldGenId);
        }, this.gracePeriodMs);
      }
    }

    // 8. Mark new generation as active
    this._activeGenId = genId;

    // 9. Start consumers + cron on new generation
    gen.startConsumers();

    return gen;
  }

  private _stopGeneration(genId: number): void {
    const gen = this.generations.get(genId);
    if (!gen || gen.state === "stopped") return;
    gen.stop();
    // Clean up reference (keep for dashboard listing briefly)
    // Remove after another grace period to let dashboard show it
    setTimeout(() => {
      this.generations.delete(genId);
    }, 60_000);
  }

  /** Force-drain a specific generation */
  drain(genId: number): void {
    const gen = this.generations.get(genId);
    if (!gen) return;
    gen.drain();
  }

  /** Force-stop a specific generation */
  stop(genId: number): void {
    this._stopGeneration(genId);
  }

  /** Update the grace period for future reloads */
  setGracePeriod(ms: number): void {
    this.gracePeriodMs = ms;
  }

  /** List all generations for dashboard */
  list(): GenerationInfo[] {
    return Array.from(this.generations.values()).map(g => g.getInfo());
  }
}
