import type { Database } from "bun:sqlite";

// --- Step ---

class WorkflowStepImpl {
  private abortSignal: AbortSignal;

  constructor(abortSignal: AbortSignal) {
    this.abortSignal = abortSignal;
  }

  async do<T>(name: string, callback: () => Promise<T>): Promise<T> {
    if (this.abortSignal.aborted) throw new Error("workflow terminated");
    console.log(`  [workflow] step: ${name}`);
    return callback();
  }

  async sleep(name: string, duration: string) {
    if (this.abortSignal.aborted) throw new Error("workflow terminated");
    console.log(`  [workflow] sleep: ${name} (${duration}) — skipping in dev (10ms)`);
    await new Promise((r) => setTimeout(r, 10));
  }
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
      .query("UPDATE workflow_instances SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'running'")
      .run(Date.now(), this.instanceId);
  }

  async resume(): Promise<void> {
    this.db
      .query("UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ? AND status = 'paused'")
      .run(Date.now(), this.instanceId);
  }

  async terminate(): Promise<void> {
    this.db
      .query("UPDATE workflow_instances SET status = 'terminated', updated_at = ? WHERE id = ? AND status IN ('running', 'paused')")
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
    const step = new WorkflowStepImpl(abortController.signal);
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
      }
    })();
  }
}
