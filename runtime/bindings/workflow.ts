import type { Database } from "bun:sqlite";
import { persistError } from "../tracing/span";

// --- Limits ---

export interface WorkflowLimits {
  maxConcurrentInstances?: number;       // default: Infinity
  maxRetentionMs?: number;               // default: 0
  maxStepsPerWorkflow?: number;          // default: 1024
  maxStepOutputBytes?: number;           // default: 1 MiB
  maxInstanceIdLength?: number;          // default: 100
  maxStepNameLength?: number;            // default: 256
  maxSleepMs?: number;                   // default: 365 days
  maxWaitForEventTimeoutMs?: number;     // default: 365 days
  minWaitForEventTimeoutMs?: number;     // default: 1s
  defaultWaitForEventTimeoutMs?: number; // default: 24h
  maxStepDoTimeoutMs?: number;           // default: 30 min
  maxBatchSize?: number;                 // default: 100
  defaultRetryLimit?: number;            // default: 5
  defaultRetryDelayMs?: number;          // default: 10_000
  defaultRetryBackoff?: "constant" | "linear" | "exponential"; // default: "exponential"
  defaultStepTimeoutMs?: number;         // default: 600_000 (10 min)
}

const WORKFLOW_DEFAULTS: Required<WorkflowLimits> = {
  maxConcurrentInstances: Infinity,
  maxRetentionMs: 0,
  maxStepsPerWorkflow: 1024,
  maxStepOutputBytes: 1024 * 1024,
  maxInstanceIdLength: 100,
  maxStepNameLength: 256,
  maxSleepMs: 365 * 86_400_000,
  maxWaitForEventTimeoutMs: 365 * 86_400_000,
  minWaitForEventTimeoutMs: 1_000,
  defaultWaitForEventTimeoutMs: 24 * 3_600_000,
  maxStepDoTimeoutMs: 30 * 60_000,
  maxBatchSize: 100,
  defaultRetryLimit: 5,
  defaultRetryDelayMs: 10_000,
  defaultRetryBackoff: "exponential",
  defaultStepTimeoutMs: 600_000,
};

// --- Cloudflare-compatible limits ---

const EVENT_TYPE_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,99}$/;

// --- NonRetryableError ---

export class NonRetryableError extends Error {
  constructor(message: string, name?: string) {
    super(message);
    this.name = name ?? "NonRetryableError";
  }
}

// --- Step config ---

export interface WorkflowStepConfig {
  retries?: {
    limit?: number;
    delay?: string | number;
    backoff?: "constant" | "linear" | "exponential";
  };
  timeout?: string | number;
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

// --- Global abort controller registry (per-process) ---
// Allows get() to retrieve a running instance's abort controller for terminate()

const abortControllers = new Map<string, AbortController>();

// --- Step ---

class WorkflowStepImpl {
  private abortSignal: AbortSignal;
  private db: Database;
  private instanceId: string;
  private stepCount = 0;
  private knownStepNames = new Set<string>();
  private limits: Required<WorkflowLimits>;

  constructor(abortSignal: AbortSignal, db: Database, instanceId: string, limits: Required<WorkflowLimits>) {
    this.abortSignal = abortSignal;
    this.db = db;
    this.instanceId = instanceId;
    this.limits = limits;
  }

  private async checkPaused(): Promise<void> {
    while (true) {
      if (this.abortSignal.aborted) throw new Error("workflow terminated");
      const row = this.db
        .query("SELECT status FROM workflow_instances WHERE id = ?")
        .get(this.instanceId) as { status: string } | null;
      if (!row || row.status !== "paused") break;
      await interruptibleDelay(50, this.abortSignal);
    }
  }

  private checkStepLimit(): void {
    this.stepCount++;
    if (this.stepCount > this.limits.maxStepsPerWorkflow) {
      throw new Error(`Workflow exceeded maximum of ${this.limits.maxStepsPerWorkflow} steps`);
    }
  }

  private checkDuplicateStepName(name: string): void {
    if (this.knownStepNames.has(name)) {
      throw new Error(`Duplicate step name "${name}". Step names must be unique within a workflow execution.`);
    }
    this.knownStepNames.add(name);
  }

  private getCachedStep(name: string): { output: string | null } | null {
    return this.db
      .query("SELECT output FROM workflow_steps WHERE instance_id = ? AND step_name = ?")
      .get(this.instanceId, name) as { output: string | null } | null;
  }

  private cacheStep(name: string, output: unknown): void {
    const serialized = JSON.stringify(output);
    if (serialized !== undefined && serialized.length > this.limits.maxStepOutputBytes) {
      throw new Error(`Step "${name}" output exceeds maximum size of 1 MiB`);
    }
    this.db
      .query("INSERT OR REPLACE INTO workflow_steps (instance_id, step_name, output, completed_at) VALUES (?, ?, ?, ?)")
      .run(this.instanceId, name, serialized, Date.now());
  }

  async do<T>(name: string, callbackOrConfig: (() => Promise<T>) | WorkflowStepConfig, maybeCallback?: () => Promise<T>): Promise<T> {
    if (name.length > this.limits.maxStepNameLength) {
      throw new Error(`Step name must be ${this.limits.maxStepNameLength} characters or fewer, got ${name.length}`);
    }
    await this.checkPaused();
    if (this.abortSignal.aborted) throw new Error("workflow terminated");
    this.checkStepLimit();
    this.checkDuplicateStepName(name);

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

    const maxRetries = config?.retries?.limit ?? this.limits.defaultRetryLimit;
    const delayMs = config?.retries?.delay ? parseDuration(config.retries.delay) : this.limits.defaultRetryDelayMs;
    const backoff = config?.retries?.backoff ?? this.limits.defaultRetryBackoff;
    const timeoutMs = config?.timeout ? parseDuration(config.timeout) : this.limits.defaultStepTimeoutMs;

    if (timeoutMs > this.limits.maxStepDoTimeoutMs) {
      throw new Error(`Step timeout ${timeoutMs}ms exceeds maximum of ${this.limits.maxStepDoTimeoutMs}ms`);
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (this.abortSignal.aborted) throw new Error("workflow terminated");
      try {
        let result: T;
        result = await Promise.race([
          callback(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Step "${name}" timed out after ${config?.timeout ?? "10 minutes"}`)), timeoutMs)),
        ]);
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
          await interruptibleDelay(d, this.abortSignal);
        }
      }
    }
    throw lastError;
  }

  async sleep(name: string, duration: string | number) {
    await this.checkPaused();
    if (this.abortSignal.aborted) throw new Error("workflow terminated");
    this.checkDuplicateStepName(`sleep:${name}`);

    const cached = this.getCachedStep(`sleep:${name}`);
    if (cached) {
      // Resume: compute remaining time from the stored target timestamp
      const { until } = JSON.parse(cached.output!) as { until: number };
      const remaining = Math.max(0, until - Date.now());
      if (remaining > 0) {
        console.log(`  [workflow] sleep: ${name} (resuming, ${remaining}ms remaining)`);
        await interruptibleDelay(remaining, this.abortSignal);
      } else {
        console.log(`  [workflow] sleep: ${name} (cached, already elapsed)`);
      }
      return;
    }

    const ms = typeof duration === "number" ? duration : parseDuration(duration);
    if (ms > this.limits.maxSleepMs) {
      throw new Error(`Sleep duration ${ms}ms exceeds maximum of ${this.limits.maxSleepMs}ms`);
    }
    const until = Date.now() + ms;
    // Checkpoint before sleeping so resume knows the target time
    this.cacheStep(`sleep:${name}`, { until });

    console.log(`  [workflow] sleep: ${name} (${duration}, ${ms}ms)`);
    if (ms > 0) {
      await interruptibleDelay(ms, this.abortSignal);
    }
  }

  async sleepUntil(name: string, timestamp: Date | number) {
    await this.checkPaused();
    if (this.abortSignal.aborted) throw new Error("workflow terminated");
    this.checkDuplicateStepName(`sleepUntil:${name}`);

    const ts = typeof timestamp === "number" ? new Date(timestamp) : timestamp;

    const cached = this.getCachedStep(`sleepUntil:${name}`);
    if (cached) {
      // Resume: compute remaining time
      const remaining = Math.max(0, ts.getTime() - Date.now());
      if (remaining > 0) {
        console.log(`  [workflow] sleepUntil: ${name} (resuming, ${remaining}ms remaining)`);
        await interruptibleDelay(remaining, this.abortSignal);
      } else {
        console.log(`  [workflow] sleepUntil: ${name} (cached, already elapsed)`);
      }
      return;
    }

    const delay = Math.max(0, ts.getTime() - Date.now());
    if (delay > this.limits.maxSleepMs) {
      throw new Error(`Sleep duration ${delay}ms exceeds maximum of ${this.limits.maxSleepMs}ms`);
    }

    // Checkpoint before sleeping
    this.cacheStep(`sleepUntil:${name}`, { until: ts.toISOString() });

    console.log(`  [workflow] sleepUntil: ${name} (${ts.toISOString()}, ${delay}ms remaining)`);
    if (delay > 0) {
      await interruptibleDelay(delay, this.abortSignal);
    }
  }

  async waitForEvent<T = unknown>(name: string, options: { type: string; timeout?: string }): Promise<{ payload: T; timestamp: Date; type: string }> {
    await this.checkPaused();
    if (this.abortSignal.aborted) throw new Error("workflow terminated");
    this.checkStepLimit();
    this.checkDuplicateStepName(`waitForEvent:${name}`);

    // Validate event type
    if (!EVENT_TYPE_PATTERN.test(options.type)) {
      throw new Error(`Invalid event type "${options.type}". Must be 1-100 characters, only letters, digits, hyphens and underscores.`);
    }

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
    const timeoutMs = options.timeout ? parseDuration(options.timeout) : this.limits.defaultWaitForEventTimeoutMs;
    if (timeoutMs < this.limits.minWaitForEventTimeoutMs) {
      throw new Error(`waitForEvent timeout ${timeoutMs}ms is below minimum of ${this.limits.minWaitForEventTimeoutMs}ms`);
    }
    if (timeoutMs > this.limits.maxWaitForEventTimeoutMs) {
      throw new Error(`waitForEvent timeout ${timeoutMs}ms exceeds maximum of ${this.limits.maxWaitForEventTimeoutMs}ms`);
    }

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

      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`waitForEvent timed out after ${options.timeout ?? "24 hours"}`));
      }, timeoutMs);

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

function interruptibleDelay(ms: number, abortSignal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (abortSignal.aborted) return Promise.reject(new Error("workflow terminated"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const abortHandler = () => { cleanup(); reject(new Error("workflow terminated")); };
    const cleanup = () => { clearTimeout(timer); abortSignal.removeEventListener("abort", abortHandler); };
    abortSignal.addEventListener("abort", abortHandler);
  });
}

export function parseDuration(duration: string | number): number {
  if (typeof duration === "number") return duration;
  const match = duration.match(/^(\d+)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?|d|days?|w|weeks?|months?|y|years?)$/i);
  if (!match) throw new Error(`Invalid duration: "${duration}"`);
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  if (unit.startsWith("ms") || unit.startsWith("millisecond")) return value;
  if (unit.startsWith("s")) return value * 1000;
  if (unit === "m" || unit.startsWith("minute")) return value * 60_000;
  if (unit.startsWith("h")) return value * 3_600_000;
  if (unit.startsWith("d")) return value * 86_400_000;
  if (unit.startsWith("w")) return value * 7 * 86_400_000;
  if (unit.startsWith("month")) return value * 30 * 86_400_000;
  if (unit.startsWith("y")) return value * 365 * 86_400_000;
  throw new Error(`Invalid duration: "${duration}"`);
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
  private binding: SqliteWorkflowBinding | null;

  constructor(db: Database, instanceId: string, binding: SqliteWorkflowBinding | null) {
    this.db = db;
    this.instanceId = instanceId;
    this.binding = binding;
  }

  get id(): string {
    return this.instanceId;
  }

  async status(): Promise<{ status: string; output?: unknown; error?: { name: string; message: string } }> {
    const row = this.db
      .query("SELECT status, output, error, error_name FROM workflow_instances WHERE id = ?")
      .get(this.instanceId) as { status: string; output: string | null; error: string | null; error_name: string | null } | null;

    if (!row) throw new Error(`Workflow instance ${this.instanceId} not found`);

    const result: { status: string; output?: unknown; error?: { name: string; message: string } } = { status: row.status };
    if (row.output !== null) result.output = JSON.parse(row.output);
    if (row.error !== null) result.error = { name: row.error_name ?? "Error", message: row.error };
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
    // Abort via global registry so get()-retrieved instances also work
    const ac = abortControllers.get(this.instanceId);
    ac?.abort();
  }

  async restart(): Promise<void> {
    if (!this.binding) throw new Error("Cannot restart: instance not associated with a workflow binding. Use the binding's get() method.");
    const cls = this.binding._getClass();
    const env = this.binding._getEnv();
    const db = this.binding._getDb();
    const workflowName = this.binding._getWorkflowName();
    const limits = this.binding._getLimits();
    if (!cls) throw new Error("Cannot restart: workflow class not wired yet");

    const row = this.db
      .query("SELECT params, created_at FROM workflow_instances WHERE id = ?")
      .get(this.instanceId) as { params: string | null; created_at: number } | null;
    if (!row) throw new Error(`Workflow instance ${this.instanceId} not found`);

    // Abort existing execution
    const existingAc = abortControllers.get(this.instanceId);
    existingAc?.abort();

    const abortController = new AbortController();
    abortControllers.set(this.instanceId, abortController);

    // Clear cached steps for this instance
    this.db.query("DELETE FROM workflow_steps WHERE instance_id = ?").run(this.instanceId);

    this.db
      .query("UPDATE workflow_instances SET status = 'running', output = NULL, error = NULL, error_name = NULL, updated_at = ? WHERE id = ?")
      .run(Date.now(), this.instanceId);

    const params = row.params !== null ? JSON.parse(row.params) : {};
    SqliteWorkflowBinding.executeWorkflow(db, this.instanceId, cls, env, params, abortController, workflowName, limits, row.created_at);
  }

  async sendEvent(event: { type: string; payload?: unknown }): Promise<void> {
    // Validate event type
    if (!EVENT_TYPE_PATTERN.test(event.type)) {
      throw new Error(`Invalid event type "${event.type}". Must be 1-100 characters, only letters, digits, hyphens and underscores.`);
    }

    // Validate instance state — cannot send events to finished instances
    const row = this.db
      .query("SELECT status FROM workflow_instances WHERE id = ?")
      .get(this.instanceId) as { status: string } | null;
    if (row && ["complete", "errored", "terminated"].includes(row.status)) {
      throw new Error(`Cannot send event to workflow instance "${this.instanceId}" with status "${row.status}"`);
    }

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

  _getClass() { return this._class; }
  _getEnv() { return this._env; }
  _getDb() { return this.db; }
  _getWorkflowName() { return this.workflowName; }
  _getLimits() { return this.limits; }

  /** Abort all running/queued/waiting instances for this workflow */
  abortRunning(): void {
    const rows = this.db.query(
      "SELECT id FROM workflow_instances WHERE workflow_name = ? AND status IN ('running','queued','waiting')"
    ).all(this.workflowName) as { id: string }[];
    for (const { id } of rows) {
      abortControllers.get(id)?.abort();
    }
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
    if (id.length > this.limits.maxInstanceIdLength) {
      throw new Error(`Workflow instance ID must be ${this.limits.maxInstanceIdLength} characters or fewer, got ${id.length}`);
    }

    // Check for duplicate ID
    const existing = this.db.query("SELECT id FROM workflow_instances WHERE id = ?").get(id);
    if (existing) throw new Error(`Workflow instance with ID "${id}" already exists`);

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
    abortControllers.set(id, abortController);
    const handle = new SqliteWorkflowInstance(this.db, id, this);

    if (!isQueued) {
      console.log(`[workflow] started ${id}`);
      SqliteWorkflowBinding.executeWorkflow(this.db, id, this._class, this._env, params, abortController, this.workflowName, this.limits, now);
    } else {
      console.log(`[workflow] queued ${id} (concurrency limit: ${this.limits.maxConcurrentInstances})`);
    }

    return handle;
  }

  async createBatch(batch: { id?: string; params?: unknown }[]): Promise<SqliteWorkflowInstance[]> {
    if (batch.length > this.limits.maxBatchSize) {
      throw new Error(`Batch size ${batch.length} exceeds maximum of ${this.limits.maxBatchSize}`);
    }
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
    return new SqliteWorkflowInstance(this.db, id, this);
  }

  /** Resume any workflow instances that were running/waiting when the process last exited. */
  resumeInterrupted(): void {
    if (!this._class) return;

    const rows = this.db
      .query("SELECT id, params, created_at FROM workflow_instances WHERE workflow_name = ? AND status IN ('running', 'waiting')")
      .all(this.workflowName) as { id: string; params: string | null; created_at: number }[];

    for (const row of rows) {
      const abortController = new AbortController();
      abortControllers.set(row.id, abortController);
      const params = row.params !== null ? JSON.parse(row.params) : {};
      console.log(`[workflow] resuming interrupted instance ${row.id}`);
      // Reset to running before re-executing (waiting status needs to restart from last checkpoint)
      this.db
        .query("UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ?")
        .run(Date.now(), row.id);
      SqliteWorkflowBinding.executeWorkflow(this.db, row.id, this._class, this._env, params, abortController, this.workflowName, this.limits, row.created_at);
    }
  }

  /** Try to start any queued instances for this workflow (called after an instance completes). */
  private tryStartQueued(): void {
    if (this.limits.maxConcurrentInstances === Infinity) return;
    if (!this._class) return;

    while (this.countRunning() < this.limits.maxConcurrentInstances) {
      const queued = this.db
        .query("SELECT id, params, created_at FROM workflow_instances WHERE workflow_name = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1")
        .get(this.workflowName) as { id: string; params: string | null; created_at: number } | null;
      if (!queued) break;

      this.db
        .query("UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ?")
        .run(Date.now(), queued.id);

      const abortController = new AbortController();
      abortControllers.set(queued.id, abortController);
      const params = queued.params !== null ? JSON.parse(queued.params) : {};
      console.log(`[workflow] starting queued instance ${queued.id}`);
      SqliteWorkflowBinding.executeWorkflow(this.db, queued.id, this._class, this._env, params, abortController, this.workflowName, this.limits, queued.created_at);
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
    limits?: Required<WorkflowLimits>,
    createdAt?: number,
  ): void {
    const resolvedLimits = limits ?? WORKFLOW_DEFAULTS;
    const instance = new workflowClass({}, env);
    const step = new WorkflowStepImpl(abortController.signal, db, id, resolvedLimits);
    const event = { payload: params, timestamp: new Date(createdAt ?? Date.now()), instanceId: id };

    (async () => {
      try {
        const result = await instance.run(event, step);
        if (abortController.signal.aborted) return;
        db.query("UPDATE workflow_instances SET status = 'complete', output = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(result), Date.now(), id);
        console.log(`[workflow] completed ${id}:`, result);
      } catch (err) {
        if (abortController.signal.aborted) return;
        const errorName = err instanceof Error ? (err.name || err.constructor.name || "Error") : "Error";
        const message = err instanceof Error ? err.message : String(err);
        db.query("UPDATE workflow_instances SET status = 'errored', error = ?, error_name = ?, updated_at = ? WHERE id = ?")
          .run(message, errorName, Date.now(), id);
        console.error(`[workflow] failed ${id}:`, err);
        persistError(err, "workflow");
      } finally {
        eventWaiters.delete(id);
        abortControllers.delete(id);
        // Try to start queued instances if we have a workflow name to look up the binding
        if (workflowName) {
          // Dequeue next instance for same workflow
          const queued = db
            .query("SELECT id, params, created_at FROM workflow_instances WHERE workflow_name = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1")
            .get(workflowName) as { id: string; params: string | null; created_at: number } | null;
          if (queued) {
            db.query("UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ?")
              .run(Date.now(), queued.id);
            const qParams = queued.params !== null ? JSON.parse(queued.params) : {};
            const ac = new AbortController();
            abortControllers.set(queued.id, ac);
            console.log(`[workflow] starting queued instance ${queued.id}`);
            SqliteWorkflowBinding.executeWorkflow(db, queued.id, workflowClass, env, qParams, ac, workflowName, resolvedLimits, queued.created_at);
          }
        }
      }
    })();
  }
}
