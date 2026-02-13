import path from "node:path";
import type { WranglerConfig } from "./config";
import { buildEnv, wireClassRefs, setGlobalEnv } from "./env";
import { Generation, type GenerationInfo } from "./generation";
import { ExecutionContext } from "./execution-context";

function isEntrypointClass(exp: unknown): exp is new (ctx: ExecutionContext, env: unknown) => Record<string, unknown> {
  return typeof exp === "function" && exp.prototype &&
    typeof exp.prototype.fetch === "function";
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

  constructor(config: WranglerConfig, baseDir: string) {
    this.config = config;
    this.baseDir = baseDir;
    this.workerPath = path.resolve(baseDir, config.main);
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
    wireClassRefs(registry, workerModule, env);

    // 4. Update globalEnv for cloudflare:workers env export
    setGlobalEnv(env);

    // 5. Validate default export
    const defaultExport = workerModule.default;
    const classBasedExport = isEntrypointClass(defaultExport);

    if (!classBasedExport && !defaultExport?.fetch) {
      throw new Error("Worker module must export a default object with a fetch() method, or a class with a fetch() method on its prototype");
    }

    // 6. Create new generation
    const genId = this.nextGenId++;
    const gen = new Generation(genId, workerModule, defaultExport, classBasedExport, env, registry, this.config);
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
