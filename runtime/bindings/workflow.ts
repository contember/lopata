// --- Step ---

class WorkflowStepImpl {
  async do<T>(name: string, callback: () => Promise<T>): Promise<T> {
    console.log(`  [workflow] step: ${name}`);
    return callback();
  }

  async sleep(name: string, duration: string) {
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

// --- Binding ---

export class InMemoryWorkflowBinding {
  private _class?: new (ctx: unknown, env: unknown) => WorkflowEntrypointBase;
  private _env?: unknown;
  private counter = 0;

  _setClass(cls: new (ctx: unknown, env: unknown) => WorkflowEntrypointBase, env: unknown) {
    this._class = cls;
    this._env = env;
  }

  async create(options?: { params?: unknown }) {
    if (!this._class) throw new Error("Workflow class not wired yet");

    const id = `wf-${++this.counter}-${Date.now()}`;
    const instance = new this._class({}, this._env);
    const step = new WorkflowStepImpl();

    const event = { payload: options?.params ?? {}, timestamp: new Date() };

    // Run async in background
    console.log(`[workflow] started ${id}`);
    (async () => {
      try {
        const result = await instance.run(event, step);
        console.log(`[workflow] completed ${id}:`, result);
      } catch (err) {
        console.error(`[workflow] failed ${id}:`, err);
      }
    })();

    return { id };
  }
}
