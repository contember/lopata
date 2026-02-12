// --- Storage ---

export class InMemoryDurableObjectStorage {
  private store = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | undefined>;
  async get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  async get<T = unknown>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(keyOrKeys)) {
      const result = new Map<string, T>();
      for (const k of keyOrKeys) {
        if (this.store.has(k)) result.set(k, this.store.get(k) as T);
      }
      return result;
    }
    return this.store.get(keyOrKeys) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void>;
  async put(entries: Record<string, unknown>): Promise<void>;
  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof keyOrEntries === "string") {
      this.store.set(keyOrEntries, value);
    } else {
      for (const [k, v] of Object.entries(keyOrEntries)) {
        this.store.set(k, v);
      }
    }
  }

  async delete(key: string): Promise<boolean>;
  async delete(keys: string[]): Promise<number>;
  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    if (Array.isArray(keyOrKeys)) {
      let count = 0;
      for (const k of keyOrKeys) {
        if (this.store.delete(k)) count++;
      }
      return count;
    }
    return this.store.delete(keyOrKeys);
  }

  async list(options?: { prefix?: string; limit?: number }): Promise<Map<string, unknown>> {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const result = new Map<string, unknown>();
    for (const [k, v] of this.store) {
      if (!k.startsWith(prefix)) continue;
      result.set(k, v);
      if (result.size >= limit) break;
    }
    return result;
  }

  async transaction<T>(closure: (txn: InMemoryDurableObjectStorage) => Promise<T>): Promise<T> {
    // In-memory: just run directly, no rollback needed for dev
    return closure(this);
  }
}

// --- ID ---

export class DurableObjectIdImpl {
  readonly name?: string;

  constructor(readonly id: string, name?: string) {
    this.name = name;
  }

  toString() {
    return this.id;
  }
}

// --- State ---

export class DurableObjectStateImpl {
  readonly id: DurableObjectIdImpl;
  readonly storage: InMemoryDurableObjectStorage;

  constructor(id: DurableObjectIdImpl) {
    this.id = id;
    this.storage = new InMemoryDurableObjectStorage();
  }

  waitUntil(_promise: Promise<unknown>) {
    // no-op in dev
  }
}

// --- Base class ---

export class DurableObjectBase {
  ctx: DurableObjectStateImpl;
  env: unknown;

  constructor(ctx: DurableObjectStateImpl, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

// --- Namespace ---

export class DurableObjectNamespaceImpl {
  private instances = new Map<string, DurableObjectBase>();
  private _class?: new (ctx: DurableObjectStateImpl, env: unknown) => DurableObjectBase;
  private _env?: unknown;

  /** Called after worker module is loaded to wire the actual class */
  _setClass(cls: new (ctx: DurableObjectStateImpl, env: unknown) => DurableObjectBase, env: unknown) {
    this._class = cls;
    this._env = env;
  }

  idFromName(name: string): DurableObjectIdImpl {
    // Deterministic ID from name using simple hash
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(name);
    const hex = hasher.digest("hex");
    return new DurableObjectIdImpl(hex, name);
  }

  idFromString(id: string): DurableObjectIdImpl {
    return new DurableObjectIdImpl(id);
  }

  get(id: DurableObjectIdImpl): unknown {
    const idStr = id.toString();
    if (!this.instances.has(idStr)) {
      if (!this._class) throw new Error("DurableObject class not wired yet. Call _setClass() first.");
      const state = new DurableObjectStateImpl(id);
      const instance = new this._class(state, this._env);
      this.instances.set(idStr, instance);
    }

    const instance = this.instances.get(idStr)!;

    // Return a Proxy stub that forwards method calls (RPC semantics)
    return new Proxy(instance, {
      get(target, prop, receiver) {
        const val = Reflect.get(target, prop, receiver);
        if (typeof val === "function") {
          return (...args: unknown[]) => val.apply(target, args);
        }
        return val;
      },
    });
  }
}
