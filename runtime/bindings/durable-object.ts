import type { Database } from "bun:sqlite";

// --- WebSocket support ---

export class WebSocketRequestResponsePair {
  readonly request: string;
  readonly response: string;

  constructor(request: string, response: string) {
    this.request = request;
    this.response = response;
  }
}

/** Options accepted by DO storage methods — all are no-ops in dev */
interface StorageOptions {
  allowConcurrency?: boolean;
  allowUnconfirmed?: boolean;
  noCache?: boolean;
}

// --- Storage ---

export class SqliteDurableObjectStorage {
  private db: Database;
  private namespace: string;
  private id: string;

  constructor(db: Database, namespace: string, id: string) {
    this.db = db;
    this.namespace = namespace;
    this.id = id;
  }

  async get<T = unknown>(key: string, options?: StorageOptions): Promise<T | undefined>;
  async get<T = unknown>(keys: string[], options?: StorageOptions): Promise<Map<string, T>>;
  async get<T = unknown>(keyOrKeys: string | string[], _options?: StorageOptions): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(keyOrKeys)) {
      if (keyOrKeys.length === 0) return new Map<string, T>();
      const placeholders = keyOrKeys.map(() => "?").join(", ");
      const rows = this.db
        .query(`SELECT key, value FROM do_storage WHERE namespace = ? AND id = ? AND key IN (${placeholders})`)
        .all(this.namespace, this.id, ...keyOrKeys) as { key: string; value: string }[];
      const result = new Map<string, T>();
      for (const row of rows) {
        result.set(row.key, JSON.parse(row.value) as T);
      }
      return result;
    }
    const row = this.db
      .query("SELECT value FROM do_storage WHERE namespace = ? AND id = ? AND key = ?")
      .get(this.namespace, this.id, keyOrKeys) as { value: string } | null;
    if (!row) return undefined;
    return JSON.parse(row.value) as T;
  }

  async put(key: string, value: unknown, options?: StorageOptions): Promise<void>;
  async put(entries: Record<string, unknown>, options?: StorageOptions): Promise<void>;
  async put(keyOrEntries: string | Record<string, unknown>, valueOrOptions?: unknown, _options?: StorageOptions): Promise<void> {
    if (typeof keyOrEntries === "string") {
      this.db
        .query("INSERT OR REPLACE INTO do_storage (namespace, id, key, value) VALUES (?, ?, ?, ?)")
        .run(this.namespace, this.id, keyOrEntries, JSON.stringify(valueOrOptions));
    } else {
      const stmt = this.db.query(
        "INSERT OR REPLACE INTO do_storage (namespace, id, key, value) VALUES (?, ?, ?, ?)",
      );
      this.db.run("BEGIN");
      try {
        for (const [k, v] of Object.entries(keyOrEntries)) {
          stmt.run(this.namespace, this.id, k, JSON.stringify(v));
        }
        this.db.run("COMMIT");
      } catch (e) {
        this.db.run("ROLLBACK");
        throw e;
      }
    }
  }

  async delete(key: string, options?: StorageOptions): Promise<boolean>;
  async delete(keys: string[], options?: StorageOptions): Promise<number>;
  async delete(keyOrKeys: string | string[], _options?: StorageOptions): Promise<boolean | number> {
    if (Array.isArray(keyOrKeys)) {
      if (keyOrKeys.length === 0) return 0;
      // Count existing keys first
      const placeholders = keyOrKeys.map(() => "?").join(", ");
      const countRow = this.db
        .query(`SELECT COUNT(*) as c FROM do_storage WHERE namespace = ? AND id = ? AND key IN (${placeholders})`)
        .get(this.namespace, this.id, ...keyOrKeys) as { c: number };
      const count = countRow.c;
      this.db
        .query(`DELETE FROM do_storage WHERE namespace = ? AND id = ? AND key IN (${placeholders})`)
        .run(this.namespace, this.id, ...keyOrKeys);
      return count;
    }
    const existing = this.db
      .query("SELECT 1 FROM do_storage WHERE namespace = ? AND id = ? AND key = ?")
      .get(this.namespace, this.id, keyOrKeys);
    this.db
      .query("DELETE FROM do_storage WHERE namespace = ? AND id = ? AND key = ?")
      .run(this.namespace, this.id, keyOrKeys);
    return existing !== null;
  }

  async deleteAll(_options?: StorageOptions): Promise<void> {
    this.db
      .query("DELETE FROM do_storage WHERE namespace = ? AND id = ?")
      .run(this.namespace, this.id);
  }

  async list(options?: { prefix?: string; start?: string; end?: string; limit?: number; reverse?: boolean }): Promise<Map<string, unknown>> {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const reverse = options?.reverse ?? false;

    let sql = "SELECT key, value FROM do_storage WHERE namespace = ? AND id = ?";
    const params: (string | number)[] = [this.namespace, this.id];

    if (prefix) {
      sql += " AND key LIKE ?";
      // Escape % and _ in prefix for LIKE, then append %
      const escaped = prefix.replace(/%/g, "\\%").replace(/_/g, "\\_");
      params.push(escaped + "%");
      sql += " ESCAPE '\\'";
    }

    if (options?.start) {
      sql += " AND key >= ?";
      params.push(options.start);
    }

    if (options?.end) {
      sql += " AND key < ?";
      params.push(options.end);
    }

    sql += ` ORDER BY key ${reverse ? "DESC" : "ASC"} LIMIT ?`;
    params.push(limit);

    const rows = this.db.query(sql).all(...params) as { key: string; value: string }[];
    const result = new Map<string, unknown>();
    for (const row of rows) {
      result.set(row.key, JSON.parse(row.value));
    }
    return result;
  }

  async transaction<T>(closure: (txn: SqliteDurableObjectStorage) => Promise<T>): Promise<T> {
    this.db.run("BEGIN");
    try {
      const result = await closure(this);
      this.db.run("COMMIT");
      return result;
    } catch (e) {
      this.db.run("ROLLBACK");
      throw e;
    }
  }

  // --- Alarm methods ---

  private _onAlarmSet?: (scheduledTime: number | null) => void;

  /** @internal Register callback for when alarm is set/deleted */
  _setAlarmCallback(cb: (scheduledTime: number | null) => void) {
    this._onAlarmSet = cb;
  }

  async getAlarm(_options?: StorageOptions): Promise<number | null> {
    const row = this.db
      .query("SELECT alarm_time FROM do_alarms WHERE namespace = ? AND id = ?")
      .get(this.namespace, this.id) as { alarm_time: number } | null;
    return row ? row.alarm_time : null;
  }

  async setAlarm(scheduledTime: number | Date, _options?: StorageOptions): Promise<void> {
    const time = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
    this.db
      .query("INSERT OR REPLACE INTO do_alarms (namespace, id, alarm_time) VALUES (?, ?, ?)")
      .run(this.namespace, this.id, time);
    this._onAlarmSet?.(time);
  }

  async deleteAlarm(_options?: StorageOptions): Promise<void> {
    this.db
      .query("DELETE FROM do_alarms WHERE namespace = ? AND id = ?")
      .run(this.namespace, this.id);
    this._onAlarmSet?.(null);
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

  equals(other: DurableObjectIdImpl): boolean {
    return this.id === other.id;
  }
}

// --- State ---

interface AcceptedWebSocket {
  ws: WebSocket;
  tags: string[];
  autoResponseTimestamp: Date | null;
}

export class DurableObjectStateImpl {
  readonly id: DurableObjectIdImpl;
  readonly storage: SqliteDurableObjectStorage;
  private _readyPromise: Promise<void> | null = null;
  private _acceptedWebSockets: Set<AcceptedWebSocket> = new Set();
  private _autoResponsePair: WebSocketRequestResponsePair | null = null;
  private _hibernatableTimeout: number | null = null;
  /** @internal Set by DurableObjectNamespaceImpl after DO is created */
  _doInstance: DurableObjectBase | null = null;

  constructor(id: DurableObjectIdImpl, db: Database, namespace: string) {
    this.id = id;
    this.storage = new SqliteDurableObjectStorage(db, namespace, id.toString());
  }

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const promise = callback();
    this._readyPromise = promise.then(() => {});
    return promise;
  }

  /** @internal Used by proxy stub to wait for blockConcurrencyWhile to complete */
  _getReadyPromise(): Promise<void> | null {
    return this._readyPromise;
  }

  waitUntil(_promise: Promise<unknown>) {
    // no-op in dev
  }

  // --- WebSocket Hibernation API ---

  acceptWebSocket(ws: WebSocket, tags?: string[]): void {
    const entry: AcceptedWebSocket = { ws, tags: tags ?? [], autoResponseTimestamp: null };
    this._acceptedWebSockets.add(entry);

    const instance = this._doInstance;

    ws.addEventListener("message", (event: MessageEvent) => {
      const message = event.data;
      // Check auto-response before delegating to handler
      if (this._autoResponsePair !== null) {
        const msgStr = typeof message === "string" ? message : null;
        if (msgStr !== null && msgStr === this._autoResponsePair.request) {
          ws.send(this._autoResponsePair.response);
          entry.autoResponseTimestamp = new Date();
          return;
        }
      }
      const obj = instance as unknown as Record<string, unknown>;
      if (instance && typeof obj.webSocketMessage === "function") {
        (obj.webSocketMessage as (ws: WebSocket, message: string | ArrayBuffer) => Promise<void>).call(instance, ws, message);
      }
    });

    ws.addEventListener("close", (event: CloseEvent) => {
      this._acceptedWebSockets.delete(entry);
      const obj = instance as unknown as Record<string, unknown>;
      if (instance && typeof obj.webSocketClose === "function") {
        (obj.webSocketClose as (ws: WebSocket, code: number, reason: string, wasClean: boolean) => Promise<void>).call(instance, ws, event.code, event.reason, event.wasClean);
      }
    });

    ws.addEventListener("error", (event: Event) => {
      const obj = instance as unknown as Record<string, unknown>;
      if (instance && typeof obj.webSocketError === "function") {
        (obj.webSocketError as (ws: WebSocket, error: unknown) => Promise<void>).call(instance, ws, event);
      }
    });
  }

  getWebSockets(tag?: string): WebSocket[] {
    const results: WebSocket[] = [];
    for (const entry of this._acceptedWebSockets) {
      if (tag === undefined || entry.tags.includes(tag)) {
        results.push(entry.ws);
      }
    }
    return results;
  }

  getTags(ws: WebSocket): string[] {
    for (const entry of this._acceptedWebSockets) {
      if (entry.ws === ws) return entry.tags;
    }
    return [];
  }

  setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair): void {
    this._autoResponsePair = pair ?? null;
  }

  getWebSocketAutoResponse(): WebSocketRequestResponsePair | null {
    return this._autoResponsePair;
  }

  getWebSocketAutoResponseTimestamp(ws: WebSocket): Date | null {
    for (const entry of this._acceptedWebSockets) {
      if (entry.ws === ws) return entry.autoResponseTimestamp;
    }
    return null;
  }

  setHibernatableWebSocketEventTimeout(_ms?: number): void {
    // no-op in dev
  }

  getHibernatableWebSocketEventTimeout(): number | null {
    return null;
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

// --- Alarm scheduling ---

const MAX_ALARM_RETRIES = 6;

// --- Namespace ---

export class DurableObjectNamespaceImpl {
  private instances = new Map<string, DurableObjectBase>();
  private _class?: new (ctx: DurableObjectStateImpl, env: unknown) => DurableObjectBase;
  private _env?: unknown;
  private db: Database;
  private namespaceName: string;
  private alarmTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(db: Database, namespaceName: string) {
    this.db = db;
    this.namespaceName = namespaceName;
  }

  /** Called after worker module is loaded to wire the actual class */
  _setClass(cls: new (ctx: DurableObjectStateImpl, env: unknown) => DurableObjectBase, env: unknown) {
    this._class = cls;
    this._env = env;
    // Restore persisted alarms on startup
    this._restoreAlarms();
  }

  /** @internal Restore all persisted alarms for this namespace */
  private _restoreAlarms() {
    const rows = this.db
      .query("SELECT id, alarm_time FROM do_alarms WHERE namespace = ?")
      .all(this.namespaceName) as { id: string; alarm_time: number }[];
    for (const row of rows) {
      this._scheduleAlarmTimer(row.id, row.alarm_time);
    }
  }

  /** @internal Schedule a timer for an alarm */
  private _scheduleAlarmTimer(idStr: string, scheduledTime: number) {
    // Clear any existing timer for this instance
    const existing = this.alarmTimers.get(idStr);
    if (existing) clearTimeout(existing);

    const delay = Math.max(0, scheduledTime - Date.now());
    const timer = setTimeout(() => {
      this.alarmTimers.delete(idStr);
      this._fireAlarm(idStr, 0);
    }, delay);
    this.alarmTimers.set(idStr, timer);
  }

  /** @internal Fire the alarm handler on a DO instance */
  private async _fireAlarm(idStr: string, retryCount: number): Promise<void> {
    // Get or create the DO instance
    const instance = this._getOrCreateInstance(idStr);
    if (!instance) return;

    // Delete alarm from DB before calling handler (matching CF behavior)
    this.db
      .query("DELETE FROM do_alarms WHERE namespace = ? AND id = ?")
      .run(this.namespaceName, idStr);

    try {
      const alarmFn = (instance as unknown as Record<string, unknown>).alarm;
      if (typeof alarmFn === "function") {
        await alarmFn.call(instance, {
          retryCount,
          isRetry: retryCount > 0,
        });
      }
    } catch (e) {
      if (retryCount < MAX_ALARM_RETRIES) {
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s
        const backoffMs = Math.pow(2, retryCount) * 1000;
        const retryTime = Date.now() + backoffMs;
        // Re-persist alarm for retry
        this.db
          .query("INSERT OR REPLACE INTO do_alarms (namespace, id, alarm_time) VALUES (?, ?, ?)")
          .run(this.namespaceName, idStr, retryTime);
        const timer = setTimeout(() => {
          this.alarmTimers.delete(idStr);
          this._fireAlarm(idStr, retryCount + 1);
        }, backoffMs);
        this.alarmTimers.set(idStr, timer);
      }
      // After max retries, alarm is discarded
    }
  }

  /** @internal Get or create a DO instance by id string */
  private _getOrCreateInstance(idStr: string): DurableObjectBase | null {
    if (this.instances.has(idStr)) return this.instances.get(idStr)!;
    if (!this._class) return null;
    const doId = new DurableObjectIdImpl(idStr);
    const state = new DurableObjectStateImpl(doId, this.db, this.namespaceName);
    const instance = new this._class(state, this._env);
    // Wire DO instance reference for WebSocket handler delegation
    state._doInstance = instance;
    // Wire alarm callback
    state.storage._setAlarmCallback((time) => {
      if (time === null) {
        const t = this.alarmTimers.get(idStr);
        if (t) clearTimeout(t);
        this.alarmTimers.delete(idStr);
      } else {
        this._scheduleAlarmTimer(idStr, time);
      }
    });
    this.instances.set(idStr, instance);
    return instance;
  }

  newUniqueId(_options?: { jurisdiction?: string }): DurableObjectIdImpl {
    return new DurableObjectIdImpl(crypto.randomUUID().replace(/-/g, ""));
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

  getByName(name: string): unknown {
    return this.get(this.idFromName(name));
  }

  get(id: DurableObjectIdImpl): unknown {
    const idStr = id.toString();
    if (!this.instances.has(idStr)) {
      if (!this._class) throw new Error("DurableObject class not wired yet. Call _setClass() first.");
      const state = new DurableObjectStateImpl(id, this.db, this.namespaceName);
      const instance = new this._class(state, this._env);
      // Wire DO instance reference for WebSocket handler delegation
      state._doInstance = instance;
      // Wire alarm callback so setAlarm/deleteAlarm schedule/cancel timers
      state.storage._setAlarmCallback((time) => {
        if (time === null) {
          const t = this.alarmTimers.get(idStr);
          if (t) clearTimeout(t);
          this.alarmTimers.delete(idStr);
        } else {
          this._scheduleAlarmTimer(idStr, time);
        }
      });
      this.instances.set(idStr, instance);
    }

    const instance = this.instances.get(idStr)!;

    // Return a Proxy stub that forwards method calls (RPC semantics)
    // Awaits blockConcurrencyWhile before forwarding any calls
    return new Proxy(instance, {
      get(target, prop, receiver) {
        const val = Reflect.get(target, prop, receiver);
        if (typeof val === "function") {
          return async (...args: unknown[]) => {
            const readyPromise = target.ctx._getReadyPromise();
            if (readyPromise) await readyPromise;
            return val.apply(target, args);
          };
        }
        return val;
      },
    });
  }
}
