import type { Database } from "bun:sqlite";

// --- Limits ---

export interface WorkflowLimits {
  maxConcurrentInstances?: number; // default Infinity (no limit)
  maxRetentionMs?: number; // default: no auto-cleanup
}

const WORKFLOW_DEFAULTS: Required<WorkflowLimits> = {
  maxConcurrentInstances: Infinity,
  maxRetentionMs: 0, // 0 = no auto-cleanup
};

// --- NonRetryableError ---

export class NonRetryableError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = "NonRetryableError";
  }
}

// --- Step config ---

export interface WorkflowStepConfig {
  retries?: {
    limit?: number;
    delay?: string;
    backoff?: "constant" | "linear" | "exponential";
  };
  timeout?: string;
}

// --- Event waiting registry (in-memory, per-process) ---

type EventResolver = (payload: unknown) => void;
const eventWaiters = new Map<string, Map<string, EventResolver>>();

function getWaitersForInstance(instanceId: string): Map<string, EventResolver> {
  let map = eventWaiters.get(instanceId);
  if (!map) {
    map = new Map();
    eventWaiters.set(instanceId, map);
  }
  return map;
}

// --- Step ---

class WorkflowStepImpl {
  private abortSignal: AbortSignal;
  private db: Database;
  private instanceId: string;

  constructor(abortSignal: AbortSignal, db: Database, instanceId: string) {
    this.abortSignal = abortSignal;
    this.db = db;
    this.instanceId = instanceId;
  }

  private async checkPaused(): Promise<void> {
    while (true) {
      if (this.abortSignal.aborted) throw new Error("workflow terminated");
      const row = this.db
        .query("SELECT status FROM workflow_instances WHERE id = ?")
        .get(this.instanceId) as { status: string } | null;
      if (!row || row.status !== "paused") break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private getCachedStep(name: string): { output: string | null } | null {
    return this.db
      .query("SELECT output FROM workflow_steps WHERE instance_id = ? AND step_name = ?")
      .get(this.instanceId, name) as { output: string | null } | null;
  }

  private cacheStep(name: string, output: unknown): void {
    this.db
      .query("INSERT OR REPLACE INTO workflow_steps (instance_id, step_name, output, completed_at) VALUES (?, ?, ?, ?)")
      .run(this.instanceId, name, JSON.stringify(output), Date.now());
  }

  async do<T>(name: string, callbackOrConfig: (() => Promise<T>) | WorkflowStepConfig, maybeCallback?: () => Promise<T>): Promise<T> {
    await this.checkPaused();
    if (this.abortSignal.aborted) throw new Error("workflow terminated");

    // Parse overloads: do(name, callback) or do(name, config, callback)
    let config: WorkflowStepConfig | undefined;
    let callback: () => Promise<T>;
    if (typeof callbackOrConfig === "function") {
      callback = callbackOrConfig;
    } else {
      config = callbackOrConfig;
      callback = maybeCallback!;
    }

    // Check checkpoint
    const cached = this.getCachedStep(name);
    if (cached) {
      console.log(`  [workflow] step: ${name} (cached)`);
      return JSON.parse(cached.output!) as T;
    }

    console.log(`  [workflow] step: ${name}`);

    const maxRetries = config?.retries?.limit ?? 0;
    const delayMs = config?.retries?.delay ? parseDuration(config.retries.delay) : 1000;
    const backoff = config?.retries?.backoff ?? "constant";
    const timeoutMs = config?.timeout ? parseDuration(config.timeout) : undefined;

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (this.abortSignal.aborted) throw new Error("workflow terminated");
      try {
        let result: T;
        if (timeoutMs !== undefined) {
          result = await Promise.race([
            callback(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Step "${name}" timed out after ${config!.timeout}`)), timeoutMs)),
          ]);
        } else {
          result = await callback();
        }
        this.cacheStep(name, result);
        return result;
      } catch (err) {
        if (err instanceof NonRetryableError) {
          throw err;
        }
        lastError = err;
        if (attempt < maxRetries) {
          const d = computeDelay(delayMs, attempt, backoff);
          console.log(`  [workflow] step "${name}" attempt ${attempt + 1} failed, retrying in ${d}ms`);
          await new Promise((r) => setTimeout(r, d));
        }
      }
    }
    throw lastError;
  }

  async sleep(name: string, duration: string) {
    await this.checkPaused();
    if (this.abortSignal.aborted) throw new Error("workflow terminated");
    console.log(`  [workflow] sleep: ${name} (${duration}) — skipping in dev (10ms)`);
    await new Promise((r) => setTimeout(r, 10));
  }

  async sleepUntil(name: string, timestamp: Date) {
    await this.checkPaused();
    if (this.abortSignal.aborted) throw new Error("workflow terminated");
    const delay = Math.max(0, timestamp.getTime() - Date.now());
    console.log(`  [workflow] sleepUntil: ${name} (${timestamp.toISOString()}, ${delay}ms remaining)`);
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  async waitForEvent<T = unknown>(name: string, options: { type: string; timeout?: string }): Promise<{ payload: T; timestamp: Date; type: string }> {
    await this.checkPaused();
    if (this.abortSignal.aborted) throw new Error("workflow terminated");

    // Check checkpoint
    const cached = this.getCachedStep(`waitForEvent:${name}`);
    if (cached) {
      console.log(`  [workflow] waitForEvent: ${name} (cached)`);
      const parsed = JSON.parse(cached.output!) as { payload: T; timestamp: string; type: string };
      return { payload: parsed.payload, timestamp: new Date(parsed.timestamp), type: parsed.type };
    }

    // Update status to waiting
    this.db
      .query("UPDATE workflow_instances SET status = 'waiting', updated_at = ? WHERE id = ?")
      .run(Date.now(), this.instanceId);

    console.log(`  [workflow] waitForEvent: ${name} (type: ${options.type})`);

    // Check if event already exists in DB
    const existing = this.db
      .query("SELECT payload, created_at FROM workflow_events WHERE instance_id = ? AND event_type = ? ORDER BY id ASC LIMIT 1")
      .get(this.instanceId, options.type) as { payload: string | null; created_at: number } | null;

    if (existing) {
      // Consume the event
      this.db
        .query("DELETE FROM workflow_events WHERE instance_id = ? AND event_type = ? ORDER BY id ASC LIMIT 1")
        .run(this.instanceId, options.type);
      // Restore running status
      this.db
        .query("UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ?")
        .run(Date.now(), this.instanceId);
      const payload = (existing.payload !== null ? JSON.parse(existing.payload) : undefined) as T;
      const event = { payload, timestamp: new Date(existing.created_at), type: options.type };
      this.cacheStep(`waitForEvent:${name}`, event);
      return event;
    }

    // Wait for event to arrive via sendEvent()
    const timeoutMs = options.timeout ? parseDuration(options.timeout) : undefined;

    const result = await new Promise<{ payload: T; timestamp: Date; type: string }>((resolve, reject) => {
      const waiters = getWaitersForInstance(this.instanceId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortHandler: (() => void) | undefined;

      const cleanup = () => {
        waiters.delete(options.type);
        if (timer) clearTimeout(timer);
        if (abortHandler) this.abortSignal.removeEventListener("abort", abortHandler);
      };

      waiters.set(options.type, (payload: unknown) => {
        cleanup();
        resolve({ payload: payload as T, timestamp: new Date(), type: options.type });
      });

      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          cleanup();
          reject(new Error(`waitForEvent timed out after ${options.timeout}`));
        }, timeoutMs);
      }

      abortHandler = () => {
        cleanup();
        reject(new Error("workflow terminated"));
      };
      this.abortSignal.addEventListener("abort", abortHandler);
    });

    // Restore running status
    this.db
      .query("UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ?")
      .run(Date.now(), this.instanceId);

    this.cacheStep(`waitForEvent:${name}`, result);
    return result;
  }
}

function computeDelay(baseMs: number, attempt: number, backoff: "constant" | "linear" | "exponential"): number {
  switch (backoff) {
    case "constant": return baseMs;
    case "linear": return baseMs * (attempt + 1);
    case "exponential": return baseMs * Math.pow(2, attempt);
  }
}

export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?|d|days?)$/i);
  if (!match) return 0;
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  if (unit.startsWith("ms") || unit.startsWith("millisecond")) return value;
  if (unit.startsWith("s")) return value * 1000;
  if (unit.startsWith("m")) return value * 60_000;
  if (unit.startsWith("h")) return value * 3_600_000;
  if (unit.startsWith("d")) return value * 86_400_000;
  return 0;
}

// --- Base class ---

export class WorkflowEntrypointBase {
  ctx: { env: unknown; waitUntil(p: Promise<unknown>): void };
  env: unknown;

  constructor(ctx: unknown, env: unknown) {
    this.env = env;
    this.ctx = { env, waitUntil: () => {} };
  }

  async run(_event: unknown, _step: unknown): Promise<unknown> {
    throw new Error("run() must be implemented by subclass");
  }
}

// --- Instance handle ---

export class SqliteWorkflowInstance {
  private db: Database;
  private instanceId: string;
  private abortController: AbortController | null;

  constructor(db: Database, instanceId: string, abortController: AbortController | null) {
    this.db = db;
    this.instanceId = instanceId;
    this.abortController = abortController;
  }

  get id(): string {
    return this.instanceId;
  }

  async status(): Promise<{ status: string; output?: unknown; error?: { name: string; message: string } }> {
    const row = this.db
      .query("SELECT status, output, error FROM workflow_instances WHERE id = ?")
      .get(this.instanceId) as { status: string; output: string | null; error: string | null } | null;

    if (!row) throw new Error(`Workflow instance ${this.instanceId} not found`);

    const result: { status: string; output?: unknown; error?: { name: string; message: string } } = { status: row.status };
    if (row.output !== null) result.output = JSON.parse(row.output);
    if (row.error !== null) result.error = { name: "Error", message: row.error };
    return result;
  }

  async pause(): Promise<void> {
    this.db
      .query("UPDATE workflow_instances SET status = 'paused', updated_at = ? WHERE id = ? AND status IN ('running', 'waiting')")
      .run(Date.now(), this.instanceId);
  }

  async resume(): Promise<void> {
    this.db
      .query("UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ? AND status = 'paused'")
      .run(Date.now(), this.instanceId);
  }

  async terminate(): Promise<void> {
    this.db
      .query("UPDATE workflow_instances SET status = 'terminated', updated_at = ? WHERE id = ? AND status IN ('running', 'paused', 'waiting', 'queued')")
      .run(Date.now(), this.instanceId);
    this.abortController?.abort();
  }

  async restart(workflowClass: new (ctx: unknown, env: unknown) => WorkflowEntrypointBase, env: unknown, db: Database): Promise<void> {
    const row = this.db
      .query("SELECT params FROM workflow_instances WHERE id = ?")
      .get(this.instanceId) as { params: string | null } | null;
    if (!row) throw new Error(`Workflow instance ${this.instanceId} not found`);

    // Abort existing execution
    this.abortController?.abort();

    const abortController = new AbortController();
    this.abortController = abortController;

    // Clear cached steps for this instance
    this.db.query("DELETE FROM workflow_steps WHERE instance_id = ?").run(this.instanceId);

    this.db
      .query("UPDATE workflow_instances SET status = 'running', output = NULL, error = NULL, updated_at = ? WHERE id = ?")
      .run(Date.now(), this.instanceId);

    const params = row.params !== null ? JSON.parse(row.params) : {};
    SqliteWorkflowBinding.executeWorkflow(db, this.instanceId, workflowClass, env, params, abortController);
  }

  async sendEvent(event: { type: string; payload?: unknown }): Promise<void> {
    // Check if there's a waiter for this event type in-memory
    const waiters = eventWaiters.get(this.instanceId);
    const resolver = waiters?.get(event.type);

    if (resolver) {
      resolver(event.payload);
    } else {
      this.db
        .query("INSERT INTO workflow_events (instance_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)")
        .run(this.instanceId, event.type, event.payload !== undefined ? JSON.stringify(event.payload) : null, Date.now());
    }
  }
}

// --- Binding ---

export class SqliteWorkflowBinding {
  private db: Database;
  private workflowName: string;
  private className: string;
  private _class?: new (ctx: unknown, env: unknown) => WorkflowEntrypointBase;
  private _env?: unknown;
  private counter = 0;
  private limits: Required<WorkflowLimits>;

  constructor(db: Database, workflowName: string, className: string, limits?: WorkflowLimits) {
    this.db = db;
    this.workflowName = workflowName;
    this.className = className;
    this.limits = { ...WORKFLOW_DEFAULTS, ...limits };
  }

  _setClass(cls: new (ctx: unknown, env: unknown) => WorkflowEntrypointBase, env: unknown) {
    this._class = cls;
    this._env = env;
  }

  private cleanupRetentionExpired(): void {
    if (this.limits.maxRetentionMs <= 0) return;
    const cutoff = Date.now() - this.limits.maxRetentionMs;
    this.db
      .query("DELETE FROM workflow_instances WHERE workflow_name = ? AND status IN ('complete', 'errored') AND updated_at < ?")
      .run(this.workflowName, cutoff);
  }

  private countRunning(): number {
    const row = this.db
      .query("SELECT COUNT(*) as cnt FROM workflow_instances WHERE workflow_name = ? AND status IN ('running', 'waiting')")
      .get(this.workflowName) as { cnt: number };
    return row.cnt;
  }

  async create(options?: { id?: string; params?: unknown; retention?: string }): Promise<SqliteWorkflowInstance> {
    if (!this._class) throw new Error("Workflow class not wired yet");

    this.cleanupRetentionExpired();

    const id = options?.id ?? `wf-${++this.counter}-${Date.now()}`;
    const params = options?.params ?? {};
    const now = Date.now();

    // Check concurrency
    const isQueued = this.limits.maxConcurrentInstances !== Infinity && this.countRunning() >= this.limits.maxConcurrentInstances;
    const initialStatus = isQueued ? "queued" : "running";

    this.db
      .query(
        "INSERT INTO workflow_instances (id, workflow_name, class_name, params, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(id, this.workflowName, this.className, JSON.stringify(params), initialStatus, now, now);

    const abortController = new AbortController();
    const handle = new SqliteWorkflowInstance(this.db, id, abortController);

    if (!isQueued) {
      console.log(`[workflow] started ${id}`);
      SqliteWorkflowBinding.executeWorkflow(this.db, id, this._class, this._env, params, abortController, this.workflowName);
    } else {
      console.log(`[workflow] queued ${id} (concurrency limit: ${this.limits.maxConcurrentInstances})`);
    }

    return handle;
  }

  async createBatch(batch: { id?: string; params?: unknown }[]): Promise<SqliteWorkflowInstance[]> {
    const results: SqliteWorkflowInstance[] = [];
    for (const item of batch) {
      const instance = await this.create({ id: item.id, params: item.params });
      results.push(instance);
    }
    return results;
  }

  async get(id: string): Promise<SqliteWorkflowInstance> {
    const row = this.db
      .query("SELECT id FROM workflow_instances WHERE id = ?")
      .get(id) as { id: string } | null;
    if (!row) throw new Error(`Workflow instance ${id} not found`);
    return new SqliteWorkflowInstance(this.db, id, null);
  }

  /** Try to start any queued instances for this workflow (called after an instance completes). */
  private tryStartQueued(): void {
    if (this.limits.maxConcurrentInstances === Infinity) return;
    if (!this._class) return;

    while (this.countRunning() < this.limits.maxConcurrentInstances) {
      const queued = this.db
        .query("SELECT id, params FROM workflow_instances WHERE workflow_name = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1")
        .get(this.workflowName) as { id: string; params: string | null } | null;
      if (!queued) break;

      this.db
        .query("UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ?")
        .run(Date.now(), queued.id);

      const abortController = new AbortController();
      const params = queued.params !== null ? JSON.parse(queued.params) : {};
      console.log(`[workflow] starting queued instance ${queued.id}`);
      SqliteWorkflowBinding.executeWorkflow(this.db, queued.id, this._class, this._env, params, abortController, this.workflowName);
    }
  }

  static executeWorkflow(
    db: Database,
    id: string,
    workflowClass: new (ctx: unknown, env: unknown) => WorkflowEntrypointBase,
    env: unknown,
    params: unknown,
    abortController: AbortController,
    workflowName?: string,
  ): void {
    const instance = new workflowClass({}, env);
    const step = new WorkflowStepImpl(abortController.signal, db, id);
    const event = { payload: params, timestamp: new Date() };

    (async () => {
      try {
        const result = await instance.run(event, step);
        if (abortController.signal.aborted) return;
        db.query("UPDATE workflow_instances SET status = 'complete', output = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(result), Date.now(), id);
        console.log(`[workflow] completed ${id}:`, result);
      } catch (err) {
        if (abortController.signal.aborted) return;
        const name = err instanceof Error ? err.constructor.name || "Error" : "Error";
        const message = err instanceof Error ? err.message : String(err);
        db.query("UPDATE workflow_instances SET status = 'errored', error = ?, updated_at = ? WHERE id = ?")
          .run(message, Date.now(), id);
        console.error(`[workflow] failed ${id}:`, err);
      } finally {
        eventWaiters.delete(id);
        // Try to start queued instances if we have a workflow name to look up the binding
        if (workflowName) {
          // Dequeue next instance for same workflow
          const queued = db
            .query("SELECT id, params FROM workflow_instances WHERE workflow_name = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1")
            .get(workflowName) as { id: string; params: string | null } | null;
          if (queued) {
            db.query("UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ?")
              .run(Date.now(), queued.id);
            const qParams = queued.params !== null ? JSON.parse(queued.params) : {};
            const ac = new AbortController();
            console.log(`[workflow] starting queued instance ${queued.id}`);
            SqliteWorkflowBinding.executeWorkflow(db, queued.id, workflowClass, env, qParams, ac, workflowName);
          }
        }
      }
    })();
  }
}
