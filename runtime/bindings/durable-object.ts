import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ContainerContext } from "./container";
import type { ContainerConfig } from "./container";

// --- SQL Storage Cursor ---

export class SqlStorageCursor implements Iterable<Record<string, unknown>> {
  private _rows: Record<string, unknown>[];
  private _rawRows: unknown[][];
  private _columnNames: string[];
  private _rowsRead: number;
  private _rowsWritten: number;
  private _index = 0;

  constructor(
    rows: Record<string, unknown>[],
    rawRows: unknown[][],
    columnNames: string[],
    rowsRead: number,
    rowsWritten: number,
  ) {
    this._rows = rows;
    this._rawRows = rawRows;
    this._columnNames = columnNames;
    this._rowsRead = rowsRead;
    this._rowsWritten = rowsWritten;
  }

  get columnNames(): string[] {
    return this._columnNames;
  }

  get rowsRead(): number {
    return this._rowsRead;
  }

  get rowsWritten(): number {
    return this._rowsWritten;
  }

  [Symbol.iterator](): Iterator<Record<string, unknown>> {
    let i = 0;
    const rows = this._rows;
    return {
      next(): IteratorResult<Record<string, unknown>> {
        if (i < rows.length) {
          return { done: false, value: rows[i++]! };
        }
        return { done: true, value: undefined };
      },
    };
  }

  next(): IteratorResult<Record<string, unknown>> {
    if (this._index < this._rows.length) {
      return { done: false, value: this._rows[this._index++]! };
    }
    return { done: true, value: undefined };
  }

  toArray(): Record<string, unknown>[] {
    return [...this._rows];
  }

  one(): Record<string, unknown> {
    if (this._rows.length !== 1) {
      throw new Error(
        `Expected exactly one row, got ${this._rows.length}`,
      );
    }
    return this._rows[0]!;
  }

  raw(): unknown[][] {
    return [...this._rawRows];
  }
}

// --- SQL Storage API ---

export class SqlStorage {
  private _dbPath: string;
  private _db: Database | null = null;

  constructor(dbPath: string) {
    this._dbPath = dbPath;
  }

  private _getDb(): Database {
    if (!this._db) {
      // Ensure parent directory exists
      const dir = this._dbPath.substring(0, this._dbPath.lastIndexOf("/"));
      mkdirSync(dir, { recursive: true });
      this._db = new Database(this._dbPath, { create: true });
      this._db.run("PRAGMA journal_mode=WAL");
    }
    return this._db;
  }

  exec(query: string, ...bindings: SQLQueryBindings[]): SqlStorageCursor {
    const db = this._getDb();
    const stmt = db.prepare(query);

    // Determine if this is a query that returns rows
    const trimmed = query.trim().toUpperCase();
    const isSelect = trimmed.startsWith("SELECT") || trimmed.startsWith("WITH") || trimmed.startsWith("PRAGMA");

    if (isSelect) {
      const rows = stmt.all(...bindings) as Record<string, unknown>[];
      const columnNames = stmt.columnNames as string[] ?? [];
      const rawRows = rows.map((row) =>
        columnNames.map((col) => row[col]),
      );
      return new SqlStorageCursor(rows, rawRows, columnNames, rows.length, 0);
    } else {
      stmt.run(...bindings);
      const changes = db.query("SELECT changes() as c").get() as { c: number };
      return new SqlStorageCursor([], [], [], 0, changes.c);
    }
  }

  get databaseSize(): number {
    try {
      return statSync(this._dbPath).size;
    } catch {
      return 0;
    }
  }
}

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

/** Configurable limits for Durable Objects */
export interface DurableObjectLimits {
  maxTagsPerWebSocket?: number;
  maxTagLength?: number;
  maxConcurrentWebSockets?: number;
  maxAutoResponseLength?: number;
  /** Eviction timeout in ms. Idle instances are evicted after this time. 0 = disabled. Default: 120000 */
  evictionTimeoutMs?: number;
}

const DO_DEFAULTS: Required<DurableObjectLimits> = {
  maxTagsPerWebSocket: 10,
  maxTagLength: 256,
  maxConcurrentWebSockets: 32_768,
  maxAutoResponseLength: 2048,
  evictionTimeoutMs: 120_000,
};

// --- Storage ---

/**
 * Synchronous KV API for Durable Object storage.
 * Uses the same `do_storage` table as the async API.
 */
export class SyncKV {
  private db: Database;
  private namespace: string;
  private id: string;

  constructor(db: Database, namespace: string, id: string) {
    this.db = db;
    this.namespace = namespace;
    this.id = id;
  }

  get(key: string): unknown {
    const row = this.db
      .query("SELECT value FROM do_storage WHERE namespace = ? AND id = ? AND key = ?")
      .get(this.namespace, this.id, key) as { value: string } | null;
    if (!row) return undefined;
    return JSON.parse(row.value);
  }

  put(key: string, value: unknown): void {
    this.db
      .query("INSERT OR REPLACE INTO do_storage (namespace, id, key, value) VALUES (?, ?, ?, ?)")
      .run(this.namespace, this.id, key, JSON.stringify(value));
  }

  delete(key: string): boolean {
    const existing = this.db
      .query("SELECT 1 FROM do_storage WHERE namespace = ? AND id = ? AND key = ?")
      .get(this.namespace, this.id, key);
    this.db
      .query("DELETE FROM do_storage WHERE namespace = ? AND id = ? AND key = ?")
      .run(this.namespace, this.id, key);
    return existing !== null;
  }

  *list(options?: { prefix?: string; start?: string; startAfter?: string; end?: string; limit?: number; reverse?: boolean }): Iterable<[string, unknown]> {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const reverse = options?.reverse ?? false;

    let sql = "SELECT key, value FROM do_storage WHERE namespace = ? AND id = ?";
    const params: (string | number)[] = [this.namespace, this.id];

    if (prefix) {
      sql += " AND key LIKE ?";
      const escaped = prefix.replace(/%/g, "\\%").replace(/_/g, "\\_");
      params.push(escaped + "%");
      sql += " ESCAPE '\\'";
    }

    if (options?.startAfter) {
      sql += " AND key > ?";
      params.push(options.startAfter);
    } else if (options?.start) {
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
    for (const row of rows) {
      yield [row.key, JSON.parse(row.value)];
    }
  }
}

export class SqliteDurableObjectStorage {
  private db: Database;
  private namespace: string;
  private id: string;
  private _sql: SqlStorage | null = null;
  private _dataDir: string | null = null;
  private _kv: SyncKV | null = null;

  constructor(db: Database, namespace: string, id: string, dataDir?: string) {
    this.db = db;
    this.namespace = namespace;
    this.id = id;
    this._dataDir = dataDir ?? null;
  }

  get kv(): SyncKV {
    if (!this._kv) {
      this._kv = new SyncKV(this.db, this.namespace, this.id);
    }
    return this._kv;
  }

  get sql(): SqlStorage {
    if (!this._sql) {
      if (!this._dataDir) {
        throw new Error("SQL storage not available: dataDir not configured");
      }
      const dbPath = join(this._dataDir, "do-sql", this.namespace, `${this.id}.sqlite`);
      this._sql = new SqlStorage(dbPath);
    }
    return this._sql;
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

  async list(options?: { prefix?: string; start?: string; startAfter?: string; end?: string; limit?: number; reverse?: boolean }): Promise<Map<string, unknown>> {
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

    if (options?.startAfter) {
      sql += " AND key > ?";
      params.push(options.startAfter);
    } else if (options?.start) {
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

  async sync(): Promise<void> {
    // No-op in dev — in production this flushes the write buffer
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

  transactionSync<T>(callback: () => T): T {
    this.db.run("BEGIN IMMEDIATE");
    try {
      const result = callback();
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
  container?: ContainerContext;
  private _concurrencyGate: Promise<void> | null = null;
  private _acceptedWebSockets: Set<AcceptedWebSocket> = new Set();
  private _autoResponsePair: WebSocketRequestResponsePair | null = null;
  private _hibernatableTimeout: number | null = null;
  private _limits: Required<DurableObjectLimits>;
  private _instanceResolver: (() => DurableObjectBase | null) | null = null;
  private _requestQueue: Promise<void> = Promise.resolve();
  private _activeRequests = 0;

  constructor(id: DurableObjectIdImpl, db: Database, namespace: string, dataDir?: string, limits?: DurableObjectLimits) {
    this.id = id;
    this.storage = new SqliteDurableObjectStorage(db, namespace, id.toString(), dataDir);
    this._limits = { ...DO_DEFAULTS, ...limits };
  }

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    let resolve: () => void;
    this._concurrencyGate = new Promise<void>(r => { resolve = r; });
    return callback().finally(() => {
      this._concurrencyGate = null;
      resolve!();
    });
  }

  /** @internal Wait until blockConcurrencyWhile completes */
  async _waitForReady(): Promise<void> {
    while (this._concurrencyGate) {
      await this._concurrencyGate;
    }
  }

  /** @internal Whether blockConcurrencyWhile is active */
  _isBlocked(): boolean {
    return this._concurrencyGate !== null;
  }

  /** @internal Whether there are active requests in the queue */
  _hasActiveRequests(): boolean {
    return this._activeRequests > 0;
  }

  /** @internal Enqueue a request — ensures serial execution (E-order) */
  _enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this._requestQueue.then(async () => {
      this._activeRequests++;
      try {
        return await fn();
      } finally {
        this._activeRequests--;
      }
    });
    this._requestQueue = result.then(() => {}, () => {}); // swallow errors for queue
    return result;
  }

  /** @internal Set the instance resolver for WebSocket handler delegation */
  _setInstanceResolver(resolver: () => DurableObjectBase | null) {
    this._instanceResolver = resolver;
  }

  /** @internal Get the DO instance via resolver */
  _resolveInstance(): DurableObjectBase | null {
    return this._instanceResolver?.() ?? null;
  }

  waitUntil(_promise: Promise<unknown>) {
    // no-op in dev
  }

  // --- WebSocket Hibernation API ---

  acceptWebSocket(ws: WebSocket, tags?: string[]): void {
    const tagList = tags ?? [];
    if (tagList.length > this._limits.maxTagsPerWebSocket) {
      throw new Error(`Exceeded max tags per WebSocket (${this._limits.maxTagsPerWebSocket})`);
    }
    for (const tag of tagList) {
      if (tag.length > this._limits.maxTagLength) {
        throw new Error(`Tag exceeds max length of ${this._limits.maxTagLength} characters`);
      }
    }
    if (this._acceptedWebSockets.size >= this._limits.maxConcurrentWebSockets) {
      throw new Error(`Exceeded max concurrent WebSocket connections (${this._limits.maxConcurrentWebSockets})`);
    }
    const entry: AcceptedWebSocket = { ws, tags: tagList, autoResponseTimestamp: null };
    this._acceptedWebSockets.add(entry);

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
      const instance = this._resolveInstance();
      const obj = instance as unknown as Record<string, unknown>;
      if (instance && typeof obj.webSocketMessage === "function") {
        (obj.webSocketMessage as (ws: WebSocket, message: string | ArrayBuffer) => Promise<void>).call(instance, ws, message);
      }
    });

    ws.addEventListener("close", (event: CloseEvent) => {
      this._acceptedWebSockets.delete(entry);
      const instance = this._resolveInstance();
      const obj = instance as unknown as Record<string, unknown>;
      if (instance && typeof obj.webSocketClose === "function") {
        (obj.webSocketClose as (ws: WebSocket, code: number, reason: string, wasClean: boolean) => Promise<void>).call(instance, ws, event.code, event.reason, event.wasClean);
      }
    });

    ws.addEventListener("error", (event: Event) => {
      const instance = this._resolveInstance();
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
    if (pair) {
      if (pair.request.length > this._limits.maxAutoResponseLength) {
        throw new Error(`Auto-response request exceeds max length of ${this._limits.maxAutoResponseLength} characters`);
      }
      if (pair.response.length > this._limits.maxAutoResponseLength) {
        throw new Error(`Auto-response response exceeds max length of ${this._limits.maxAutoResponseLength} characters`);
      }
    }
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

  setHibernatableWebSocketEventTimeout(ms?: number): void {
    this._hibernatableTimeout = ms ?? null;
  }

  getHibernatableWebSocketEventTimeout(): number | null {
    return this._hibernatableTimeout;
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

// Properties that should NOT be proxied as RPC (JS internals, Promise protocol, etc.)
const NON_RPC_PROPS = new Set<string | symbol>([
  "then", "catch", "finally",  // Promise/thenable protocol
  "toJSON", "valueOf", "toString",  // conversion
  Symbol.toPrimitive, Symbol.toStringTag, Symbol.iterator, Symbol.asyncIterator,
]);

// Properties handled specially on the stub (not forwarded as RPC)
const STUB_PROPS = new Set(["id", "name", "fetch"]);

// --- Namespace ---

export class DurableObjectNamespaceImpl {
  private instances = new Map<string, DurableObjectBase>();
  private _stubs = new Map<string, unknown>();
  private _knownIds = new Map<string, DurableObjectIdImpl>();
  private _class?: new (ctx: DurableObjectStateImpl, env: unknown) => DurableObjectBase;
  private _env?: unknown;
  private db: Database;
  private namespaceName: string;
  private alarmTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private dataDir: string | undefined;
  private limits: DurableObjectLimits | undefined;
  private _lastActivity = new Map<string, number>();
  private _evictionTimer: ReturnType<typeof setInterval> | null = null;
  private _evictionTimeoutMs: number;
  private _containerConfig?: ContainerConfig;
  private _containerRuntimes = new Map<string, import("./container").ContainerRuntime>();

  constructor(db: Database, namespaceName: string, dataDir?: string, limits?: DurableObjectLimits) {
    this.db = db;
    this.namespaceName = namespaceName;
    this.dataDir = dataDir;
    this.limits = limits;
    this._evictionTimeoutMs = limits?.evictionTimeoutMs ?? 120_000;
    if (this._evictionTimeoutMs > 0) {
      this._evictionTimer = setInterval(() => this._evictIdle(), 30_000);
    }
  }

  /** Called after worker module is loaded to wire the actual class */
  _setClass(cls: new (ctx: DurableObjectStateImpl, env: unknown) => DurableObjectBase, env: unknown) {
    this._class = cls;
    this._env = env;
    // Restore persisted alarms on startup
    this._restoreAlarms();
  }

  /** Set container config for this namespace (makes it a container namespace) */
  _setContainerConfig(config: ContainerConfig) {
    this._containerConfig = config;
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

    const state = instance.ctx as DurableObjectStateImpl;

    // Run alarm through the request queue (serialized)
    await state._enqueue(async () => {
      await state._waitForReady();

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
    });
  }

  /** @internal Get or create a DO instance by id string */
  private _getOrCreateInstance(idStr: string, doId?: DurableObjectIdImpl): DurableObjectBase | null {
    if (this.instances.has(idStr)) return this.instances.get(idStr)!;
    if (!this._class) return null;

    // Use provided doId, or look up known id (preserves name after eviction), or create new
    const id = doId ?? this._knownIds.get(idStr) ?? new DurableObjectIdImpl(idStr);
    if (doId) this._knownIds.set(idStr, doId);

    const state = new DurableObjectStateImpl(id, this.db, this.namespaceName, this.dataDir, this.limits);

    // Wire container runtime if this is a container namespace
    if (this._containerConfig) {
      const { ContainerRuntime, ContainerContext } = require("./container") as typeof import("./container");
      const runtime = new ContainerRuntime(
        this._containerConfig.className,
        idStr,
        this._containerConfig.image,
        this._containerConfig.dockerManager,
      );
      this._containerRuntimes.set(idStr, runtime);
      state.container = new ContainerContext(runtime);
    }

    const instance = new this._class(state, this._env);

    // Wire container runtime to ContainerBase instance
    if (this._containerConfig && this._containerRuntimes.has(idStr)) {
      const { ContainerBase } = require("./container") as typeof import("./container");
      if (instance instanceof ContainerBase) {
        instance._wireRuntime(this._containerRuntimes.get(idStr)!);
      }
    }

    // Wire instance resolver for WebSocket handler delegation
    state._setInstanceResolver(() => this.instances.get(idStr) ?? null);
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
    this._lastActivity.set(idStr, Date.now());
    return instance;
  }

  /** @internal Evict idle instances */
  private _evictIdle() {
    const now = Date.now();
    for (const [idStr, lastActivity] of this._lastActivity) {
      if (now - lastActivity < this._evictionTimeoutMs) continue;
      const instance = this.instances.get(idStr);
      if (!instance) continue;
      const state = instance.ctx as DurableObjectStateImpl;
      // Skip if blockConcurrencyWhile is active
      if (state._isBlocked()) continue;
      // Skip if there are active requests
      if (state._hasActiveRequests()) continue;
      // Skip if instance has accepted WebSockets
      if (state.getWebSockets().length > 0) continue;
      // Evict
      this.instances.delete(idStr);
      this._lastActivity.delete(idStr);
      // _knownIds and alarmTimers survive eviction
    }
  }

  /** @internal Destroy this namespace: clear timers, evict instances without active WebSockets */
  destroy(): void {
    if (this._evictionTimer) {
      clearInterval(this._evictionTimer);
      this._evictionTimer = null;
    }
    for (const timer of this.alarmTimers.values()) clearTimeout(timer);
    this.alarmTimers.clear();
    // Cleanup container runtimes
    for (const [idStr, runtime] of this._containerRuntimes) {
      runtime.cleanup().catch(() => {});
      this._containerRuntimes.delete(idStr);
    }
    // Keep instances with active WebSockets alive; evict the rest
    for (const [idStr, instance] of this.instances) {
      const state = instance.ctx as DurableObjectStateImpl;
      if (state.getWebSockets().length === 0) {
        this.instances.delete(idStr);
      }
    }
    this._lastActivity.clear();
  }

  /** @internal Get a raw instance for testing (no proxy) */
  _getInstance(idStr: string): DurableObjectBase | null {
    return this.instances.get(idStr) ?? null;
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

    // Return cached stub if available — stub survives eviction
    if (this._stubs.has(idStr)) return this._stubs.get(idStr)!;

    if (!this._class) throw new Error("DurableObject class not wired yet. Call _setClass() first.");

    // Store the known id (preserves name)
    this._knownIds.set(idStr, id);

    // Ensure instance exists
    this._getOrCreateInstance(idStr, id);

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    // Return a Proxy stub that lazily resolves instances (survives eviction)
    const stub = new Proxy({} as Record<string, unknown>, {
      get(_target, prop: string | symbol) {
        // Non-RPC props (Promise protocol, symbols, conversion)
        if (NON_RPC_PROPS.has(prop)) return undefined;

        // stub.id — returns the DurableObjectId
        if (prop === "id") return id;
        // stub.name — returns the name if available
        if (prop === "name") return id.name;

        // stub.fetch() — calls the DO's fetch() handler
        if (prop === "fetch") {
          return (input: RequestInfo | URL, init?: RequestInit) => {
            const instance = self._getOrCreateInstance(idStr, id)!;
            const state = instance.ctx as DurableObjectStateImpl;
            self._lastActivity.set(idStr, Date.now());
            return state._enqueue(async () => {
              await state._waitForReady();
              const fetchFn = (instance as unknown as Record<string, unknown>).fetch;
              if (typeof fetchFn !== "function") {
                throw new Error("Durable Object does not implement fetch()");
              }
              const request = input instanceof Request ? input : new Request(input instanceof URL ? input.href : input, init);
              return (fetchFn as (req: Request) => Promise<Response>).call(instance, request);
            });
          };
        }

        // RPC: return a callable that also acts as a thenable for property access
        const rpcCallable = (...args: unknown[]) => {
          const instance = self._getOrCreateInstance(idStr, id)!;
          const state = instance.ctx as DurableObjectStateImpl;
          self._lastActivity.set(idStr, Date.now());
          return state._enqueue(async () => {
            await state._waitForReady();
            const val = (instance as unknown as Record<string, unknown>)[prop as string];
            if (typeof val === "function") {
              return (val as (...a: unknown[]) => unknown).call(instance, ...args);
            }
            throw new Error(`"${String(prop)}" is not a method on the Durable Object`);
          });
        };

        // Make it thenable for property access: `await stub.myProp`
        rpcCallable.then = (
          onFulfilled?: ((value: unknown) => unknown) | null,
          onRejected?: ((reason: unknown) => unknown) | null,
        ) => {
          const instance = self._getOrCreateInstance(idStr, id)!;
          const state = instance.ctx as DurableObjectStateImpl;
          self._lastActivity.set(idStr, Date.now());
          const promise = state._enqueue(async () => {
            await state._waitForReady();
            const val = (instance as unknown as Record<string, unknown>)[prop as string];
            if (typeof val === "function") {
              return val.bind(instance);
            }
            return val;
          });
          return promise.then(onFulfilled, onRejected);
        };

        return rpcCallable;
      },
    });

    this._stubs.set(idStr, stub);
    return stub;
  }
}
