import type { Database } from "bun:sqlite";

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
    // Poll DB for pause status, wait until resumed or aborted
    while (true) {
      if (this.abortSignal.aborted) throw new Error("workflow terminated");
      const row = this.db
        .query("SELECT status FROM workflow_instances WHERE id = ?")
        .get(this.instanceId) as { status: string } | null;
      if (!row || row.status !== "paused") break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async do<T>(name: string, callback: () => Promise<T>): Promise<T> {
    await this.checkPaused();
    if (this.abortSignal.aborted) throw new Error("workflow terminated");
    console.log(`  [workflow] step: ${name}`);
    return callback();
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

  async waitForEvent<T = unknown>(name: string, options: { type: string; timeout?: string }): Promise<T> {
    await this.checkPaused();
    if (this.abortSignal.aborted) throw new Error("workflow terminated");

    // Update status to waiting
    this.db
      .query("UPDATE workflow_instances SET status = 'waiting', updated_at = ? WHERE id = ?")
      .run(Date.now(), this.instanceId);

    console.log(`  [workflow] waitForEvent: ${name} (type: ${options.type})`);

    // Check if event already exists in DB
    const existing = this.db
      .query("SELECT payload FROM workflow_events WHERE instance_id = ? AND event_type = ? ORDER BY id ASC LIMIT 1")
      .get(this.instanceId, options.type) as { payload: string | null } | null;

    if (existing) {
      // Consume the event
      this.db
        .query("DELETE FROM workflow_events WHERE instance_id = ? AND event_type = ? ORDER BY id ASC LIMIT 1")
        .run(this.instanceId, options.type);
      // Restore running status
      this.db
        .query("UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ?")
        .run(Date.now(), this.instanceId);
      return (existing.payload !== null ? JSON.parse(existing.payload) : undefined) as T;
    }

    // Wait for event to arrive via sendEvent()
    const timeoutMs = options.timeout ? parseDuration(options.timeout) : undefined;

    const result = await new Promise<T>((resolve, reject) => {
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
        resolve(payload as T);
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

    return result;
  }
}

function parseDuration(duration: string): number {
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

  async status(): Promise<{ status: string; output?: unknown; error?: string }> {
    const row = this.db
      .query("SELECT status, output, error FROM workflow_instances WHERE id = ?")
      .get(this.instanceId) as { status: string; output: string | null; error: string | null } | null;

    if (!row) throw new Error(`Workflow instance ${this.instanceId} not found`);

    const result: { status: string; output?: unknown; error?: string } = { status: row.status };
    if (row.output !== null) result.output = JSON.parse(row.output);
    if (row.error !== null) result.error = row.error;
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
      .query("UPDATE workflow_instances SET status = 'terminated', updated_at = ? WHERE id = ? AND status IN ('running', 'paused', 'waiting')")
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
      // Resolve the waiting promise directly
      resolver(event.payload);
    } else {
      // Store event in DB for later consumption
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

  constructor(db: Database, workflowName: string, className: string) {
    this.db = db;
    this.workflowName = workflowName;
    this.className = className;
  }

  _setClass(cls: new (ctx: unknown, env: unknown) => WorkflowEntrypointBase, env: unknown) {
    this._class = cls;
    this._env = env;
  }

  async create(options?: { id?: string; params?: unknown }): Promise<SqliteWorkflowInstance> {
    if (!this._class) throw new Error("Workflow class not wired yet");

    const id = options?.id ?? `wf-${++this.counter}-${Date.now()}`;
    const params = options?.params ?? {};
    const now = Date.now();

    this.db
      .query(
        "INSERT INTO workflow_instances (id, workflow_name, class_name, params, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)"
      )
      .run(id, this.workflowName, this.className, JSON.stringify(params), now, now);

    const abortController = new AbortController();
    const handle = new SqliteWorkflowInstance(this.db, id, abortController);

    console.log(`[workflow] started ${id}`);
    SqliteWorkflowBinding.executeWorkflow(this.db, id, this._class, this._env, params, abortController);

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

  static executeWorkflow(
    db: Database,
    id: string,
    workflowClass: new (ctx: unknown, env: unknown) => WorkflowEntrypointBase,
    env: unknown,
    params: unknown,
    abortController: AbortController,
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
        const message = err instanceof Error ? err.message : String(err);
        db.query("UPDATE workflow_instances SET status = 'errored', error = ?, updated_at = ? WHERE id = ?")
          .run(message, Date.now(), id);
        console.error(`[workflow] failed ${id}:`, err);
      } finally {
        // Clean up event waiters for this instance
        eventWaiters.delete(id);
      }
    })();
  }
}
