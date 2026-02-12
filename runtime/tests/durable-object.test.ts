import { test, expect, beforeEach, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db";
import {
  SqliteDurableObjectStorage,
  DurableObjectIdImpl,
  DurableObjectStateImpl,
  DurableObjectBase,
  DurableObjectNamespaceImpl,
  WebSocketRequestResponsePair,
} from "../bindings/durable-object";

/** Minimal mock WebSocket for testing state.acceptWebSocket() and friends */
class MockWebSocket extends EventTarget {
  sent: (string | ArrayBuffer)[] = [];
  readyState = 1; // OPEN

  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }

  close(_code?: number, _reason?: string) {
    this.readyState = 3; // CLOSED
    this.dispatchEvent(new CloseEvent("close", { code: _code ?? 1000, reason: _reason ?? "", wasClean: true }));
  }

  /** Simulate receiving a message */
  _receiveMessage(data: string | ArrayBuffer) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  /** Simulate an error */
  _triggerError() {
    this.dispatchEvent(new Event("error"));
  }
}

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

describe("DurableObjectStorage", () => {
  let storage: SqliteDurableObjectStorage;

  beforeEach(() => {
    storage = new SqliteDurableObjectStorage(db, "TestDO", "instance1");
  });

  test("get non-existent key returns undefined", async () => {
    expect(await storage.get("missing")).toBeUndefined();
  });

  test("put and get single key", async () => {
    await storage.put("count", 42);
    expect(await storage.get<number>("count")).toBe(42);
  });

  test("put overwrites existing value", async () => {
    await storage.put("key", "first");
    await storage.put("key", "second");
    expect(await storage.get<string>("key")).toBe("second");
  });

  test("put and get complex value", async () => {
    await storage.put("data", { nested: { array: [1, 2, 3] } });
    expect(await storage.get<{ nested: { array: number[] } }>("data")).toEqual({ nested: { array: [1, 2, 3] } });
  });

  test("put entries object", async () => {
    await storage.put({ a: 1, b: 2, c: 3 });
    expect(await storage.get<number>("a")).toBe(1);
    expect(await storage.get<number>("b")).toBe(2);
    expect(await storage.get<number>("c")).toBe(3);
  });

  test("get multiple keys returns Map", async () => {
    await storage.put("a", 1);
    await storage.put("b", 2);
    const result = await storage.get(["a", "b", "missing"]);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(2);
    expect(result.get("a")).toBe(1);
    expect(result.get("b")).toBe(2);
    expect(result.has("missing")).toBe(false);
  });

  test("get empty keys array returns empty Map", async () => {
    const result = await storage.get([]);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  test("delete single key returns boolean", async () => {
    await storage.put("key", "val");
    expect(await storage.delete("key")).toBe(true);
    expect(await storage.get("key")).toBeUndefined();
  });

  test("delete non-existent key returns false", async () => {
    expect(await storage.delete("missing")).toBe(false);
  });

  test("delete multiple keys returns count", async () => {
    await storage.put("a", 1);
    await storage.put("b", 2);
    const count = await storage.delete(["a", "b", "missing"]);
    expect(count).toBe(2);
  });

  test("delete empty keys array returns 0", async () => {
    expect(await storage.delete([])).toBe(0);
  });

  test("deleteAll removes all keys for this instance", async () => {
    await storage.put("a", 1);
    await storage.put("b", 2);
    await storage.deleteAll();
    expect(await storage.get("a")).toBeUndefined();
    expect(await storage.get("b")).toBeUndefined();
    const result = await storage.list();
    expect(result.size).toBe(0);
  });

  test("list all keys", async () => {
    await storage.put("x", 1);
    await storage.put("y", 2);
    const result = await storage.list();
    expect(result.size).toBe(2);
    expect(result.get("x")).toBe(1);
    expect(result.get("y")).toBe(2);
  });

  test("list with prefix", async () => {
    await storage.put("user:1", "a");
    await storage.put("user:2", "b");
    await storage.put("post:1", "c");
    const result = await storage.list({ prefix: "user:" });
    expect(result.size).toBe(2);
    expect(result.has("post:1")).toBe(false);
  });

  test("list with limit", async () => {
    await storage.put("a", 1);
    await storage.put("b", 2);
    await storage.put("c", 3);
    const result = await storage.list({ limit: 2 });
    expect(result.size).toBe(2);
  });

  test("list with start and end", async () => {
    await storage.put("a", 1);
    await storage.put("b", 2);
    await storage.put("c", 3);
    await storage.put("d", 4);
    const result = await storage.list({ start: "b", end: "d" });
    expect(result.size).toBe(2);
    expect(result.has("b")).toBe(true);
    expect(result.has("c")).toBe(true);
    expect(result.has("a")).toBe(false);
    expect(result.has("d")).toBe(false);
  });

  test("list with reverse", async () => {
    await storage.put("a", 1);
    await storage.put("b", 2);
    await storage.put("c", 3);
    const result = await storage.list({ reverse: true, limit: 2 });
    expect(result.size).toBe(2);
    const keys = [...result.keys()];
    expect(keys[0]).toBe("c");
    expect(keys[1]).toBe("b");
  });

  test("list empty storage", async () => {
    const result = await storage.list();
    expect(result.size).toBe(0);
  });

  test("transaction executes closure", async () => {
    await storage.transaction(async (txn) => {
      await txn.put("key", "value");
    });
    expect(await storage.get<string>("key")).toBe("value");
  });

  test("namespace isolation — different namespaces don't share data", async () => {
    const storage2 = new SqliteDurableObjectStorage(db, "OtherDO", "instance1");
    await storage.put("shared-key", "from-TestDO");
    await storage2.put("shared-key", "from-OtherDO");
    expect(await storage.get<string>("shared-key")).toBe("from-TestDO");
    expect(await storage2.get<string>("shared-key")).toBe("from-OtherDO");
  });

  test("instance isolation — different instances don't share data", async () => {
    const storage2 = new SqliteDurableObjectStorage(db, "TestDO", "instance2");
    await storage.put("key", "instance1-value");
    await storage2.put("key", "instance2-value");
    expect(await storage.get<string>("key")).toBe("instance1-value");
    expect(await storage2.get<string>("key")).toBe("instance2-value");
  });

  test("persistence across storage instances with same db/namespace/id", async () => {
    await storage.put("persistent", "data");
    const storage2 = new SqliteDurableObjectStorage(db, "TestDO", "instance1");
    expect(await storage2.get<string>("persistent")).toBe("data");
  });
});

describe("DurableObjectId", () => {
  test("toString returns id", () => {
    const id = new DurableObjectIdImpl("abc123");
    expect(id.toString()).toBe("abc123");
  });

  test("stores name when provided", () => {
    const id = new DurableObjectIdImpl("abc123", "myName");
    expect(id.name).toBe("myName");
  });

  test("name is undefined when not provided", () => {
    const id = new DurableObjectIdImpl("abc123");
    expect(id.name).toBeUndefined();
  });

  test("equals returns true for same id", () => {
    const id1 = new DurableObjectIdImpl("abc123");
    const id2 = new DurableObjectIdImpl("abc123");
    expect(id1.equals(id2)).toBe(true);
  });

  test("equals returns false for different ids", () => {
    const id1 = new DurableObjectIdImpl("abc123");
    const id2 = new DurableObjectIdImpl("def456");
    expect(id1.equals(id2)).toBe(false);
  });
});

describe("DurableObjectState", () => {
  test("has id and storage", () => {
    const id = new DurableObjectIdImpl("test-id", "test");
    const state = new DurableObjectStateImpl(id, db, "TestDO");
    expect(state.id).toBe(id);
    expect(state.storage).toBeInstanceOf(SqliteDurableObjectStorage);
  });

  test("waitUntil is no-op", () => {
    const state = new DurableObjectStateImpl(new DurableObjectIdImpl("id"), db, "TestDO");
    state.waitUntil(Promise.resolve()); // should not throw
  });

  test("blockConcurrencyWhile executes callback and returns result", async () => {
    const id = new DurableObjectIdImpl("test-id");
    const state = new DurableObjectStateImpl(id, db, "TestDO");
    const result = await state.blockConcurrencyWhile(async () => {
      await state.storage.put("initialized", true);
      return 42;
    });
    expect(result).toBe(42);
    expect(await state.storage.get<boolean>("initialized")).toBe(true);
  });
});

describe("DurableObjectNamespace", () => {
  class TestCounter extends DurableObjectBase {
    async getCount(): Promise<number> {
      return ((await this.ctx.storage.get<number>("count")) ?? 0);
    }
    async increment(): Promise<number> {
      const count = (await this.getCount()) + 1;
      await this.ctx.storage.put("count", count);
      return count;
    }
  }

  let ns: DurableObjectNamespaceImpl;

  beforeEach(() => {
    ns = new DurableObjectNamespaceImpl(db, "TestCounter");
    ns._setClass(TestCounter, {});
  });

  test("idFromName returns deterministic id", () => {
    const id1 = ns.idFromName("test");
    const id2 = ns.idFromName("test");
    expect(id1.toString()).toBe(id2.toString());
    expect(id1.name).toBe("test");
  });

  test("idFromName different names produce different ids", () => {
    const id1 = ns.idFromName("a");
    const id2 = ns.idFromName("b");
    expect(id1.toString()).not.toBe(id2.toString());
  });

  test("idFromString wraps raw id", () => {
    const id = ns.idFromString("raw-id-hex");
    expect(id.toString()).toBe("raw-id-hex");
    expect(id.name).toBeUndefined();
  });

  test("get returns proxy stub with callable methods", async () => {
    const id = ns.idFromName("counter1");
    const stub = ns.get(id) as any;
    expect(await stub.getCount()).toBe(0);
    expect(await stub.increment()).toBe(1);
    expect(await stub.increment()).toBe(2);
    expect(await stub.getCount()).toBe(2);
  });

  test("same id returns same instance (shared state)", async () => {
    const id = ns.idFromName("counter1");
    const stub1 = ns.get(id) as any;
    await stub1.increment();

    const stub2 = ns.get(id) as any;
    expect(await stub2.getCount()).toBe(1);
  });

  test("different ids have independent state", async () => {
    const id1 = ns.idFromName("a");
    const id2 = ns.idFromName("b");
    const stub1 = ns.get(id1) as any;
    const stub2 = ns.get(id2) as any;

    await stub1.increment();
    await stub1.increment();

    expect(await stub1.getCount()).toBe(2);
    expect(await stub2.getCount()).toBe(0);
  });

  test("get throws if class not wired", () => {
    const ns2 = new DurableObjectNamespaceImpl(db, "Unwired");
    const id = new DurableObjectIdImpl("test");
    expect(() => ns2.get(id)).toThrow("not wired");
  });

  test("newUniqueId returns unique ids", () => {
    const id1 = ns.newUniqueId();
    const id2 = ns.newUniqueId();
    expect(id1.toString()).not.toBe(id2.toString());
    expect(id1.name).toBeUndefined();
  });

  test("newUniqueId accepts jurisdiction option (ignored)", () => {
    const id = ns.newUniqueId({ jurisdiction: "eu" });
    expect(id.toString().length).toBeGreaterThan(0);
  });

  test("getByName is shorthand for idFromName + get", async () => {
    const stub1 = ns.getByName("counter1") as { increment(): Promise<number>; getCount(): Promise<number> };
    await stub1.increment();

    const id = ns.idFromName("counter1");
    const stub2 = ns.get(id) as { getCount(): Promise<number> };
    expect(await stub2.getCount()).toBe(1);
  });

  test("blockConcurrencyWhile defers proxy calls until ready", async () => {
    const order: string[] = [];

    class SlowInitDO extends DurableObjectBase {
      constructor(ctx: DurableObjectStateImpl, env: unknown) {
        super(ctx, env);
        ctx.blockConcurrencyWhile(async () => {
          await new Promise((r) => setTimeout(r, 50));
          order.push("init-done");
        });
      }
      async hello(): Promise<string> {
        order.push("hello");
        return "world";
      }
    }

    const ns2 = new DurableObjectNamespaceImpl(db, "SlowInit");
    ns2._setClass(SlowInitDO, {});
    const stub = ns2.get(ns2.idFromName("test")) as { hello(): Promise<string> };
    const result = await stub.hello();
    expect(result).toBe("world");
    expect(order).toEqual(["init-done", "hello"]);
  });

  test("data persists across namespace instances (same db)", async () => {
    const id = ns.idFromName("counter1");
    const stub = ns.get(id) as any;
    await stub.increment();
    await stub.increment();

    // Create a new namespace instance pointing to same db
    const ns2 = new DurableObjectNamespaceImpl(db, "TestCounter");
    ns2._setClass(TestCounter, {});
    const stub2 = ns2.get(id) as any;
    expect(await stub2.getCount()).toBe(2);
  });
});

describe("DurableObject Alarms", () => {
  describe("Storage alarm methods", () => {
    let storage: SqliteDurableObjectStorage;

    beforeEach(() => {
      storage = new SqliteDurableObjectStorage(db, "TestDO", "instance1");
    });

    test("getAlarm returns null when no alarm set", async () => {
      expect(await storage.getAlarm()).toBeNull();
    });

    test("setAlarm and getAlarm", async () => {
      const time = Date.now() + 60000;
      await storage.setAlarm(time);
      expect(await storage.getAlarm()).toBe(time);
    });

    test("setAlarm accepts Date object", async () => {
      const date = new Date(Date.now() + 60000);
      await storage.setAlarm(date);
      expect(await storage.getAlarm()).toBe(date.getTime());
    });

    test("setAlarm replaces existing alarm", async () => {
      await storage.setAlarm(Date.now() + 60000);
      const newTime = Date.now() + 120000;
      await storage.setAlarm(newTime);
      expect(await storage.getAlarm()).toBe(newTime);
    });

    test("deleteAlarm removes alarm", async () => {
      await storage.setAlarm(Date.now() + 60000);
      await storage.deleteAlarm();
      expect(await storage.getAlarm()).toBeNull();
    });

    test("deleteAlarm on non-existent alarm is no-op", async () => {
      await storage.deleteAlarm(); // should not throw
      expect(await storage.getAlarm()).toBeNull();
    });

    test("alarm isolation between instances", async () => {
      const storage2 = new SqliteDurableObjectStorage(db, "TestDO", "instance2");
      const time1 = Date.now() + 60000;
      const time2 = Date.now() + 120000;
      await storage.setAlarm(time1);
      await storage2.setAlarm(time2);
      expect(await storage.getAlarm()).toBe(time1);
      expect(await storage2.getAlarm()).toBe(time2);
    });
  });

  describe("Alarm firing via namespace", () => {
    test("alarm fires at scheduled time", async () => {
      const alarmCalls: { retryCount: number; isRetry: boolean }[] = [];

      class AlarmDO extends DurableObjectBase {
        async alarm(info: { retryCount: number; isRetry: boolean }) {
          alarmCalls.push(info);
        }
      }

      const ns = new DurableObjectNamespaceImpl(db, "AlarmDO");
      ns._setClass(AlarmDO, {});

      const id = ns.idFromName("test");
      const stub = ns.get(id) as { ctx: DurableObjectStateImpl };
      // Access inner instance storage via the proxy
      const instance = ns.get(id) as unknown as DurableObjectBase;
      await instance.ctx.storage.setAlarm(Date.now() + 10);

      // Wait for alarm to fire
      await new Promise((r) => setTimeout(r, 50));

      expect(alarmCalls.length).toBe(1);
      expect(alarmCalls[0]!.retryCount).toBe(0);
      expect(alarmCalls[0]!.isRetry).toBe(false);
    });

    test("alarm is cleared from DB after firing", async () => {
      class AlarmDO extends DurableObjectBase {
        async alarm() {}
      }

      const ns = new DurableObjectNamespaceImpl(db, "AlarmDO2");
      ns._setClass(AlarmDO, {});

      const id = ns.idFromName("test");
      const instance = ns.get(id) as unknown as DurableObjectBase;
      await instance.ctx.storage.setAlarm(Date.now() + 10);

      await new Promise((r) => setTimeout(r, 50));

      expect(await instance.ctx.storage.getAlarm()).toBeNull();
    });

    test("setAlarm replaces previous timer", async () => {
      let callCount = 0;

      class AlarmDO extends DurableObjectBase {
        async alarm() {
          callCount++;
        }
      }

      const ns = new DurableObjectNamespaceImpl(db, "AlarmDO3");
      ns._setClass(AlarmDO, {});

      const id = ns.idFromName("test");
      const instance = ns.get(id) as unknown as DurableObjectBase;

      // Set alarm far in the future
      await instance.ctx.storage.setAlarm(Date.now() + 100000);
      // Replace with a near alarm
      await instance.ctx.storage.setAlarm(Date.now() + 10);

      await new Promise((r) => setTimeout(r, 50));

      expect(callCount).toBe(1);
    });

    test("deleteAlarm cancels pending timer", async () => {
      let called = false;

      class AlarmDO extends DurableObjectBase {
        async alarm() {
          called = true;
        }
      }

      const ns = new DurableObjectNamespaceImpl(db, "AlarmDO4");
      ns._setClass(AlarmDO, {});

      const id = ns.idFromName("test");
      const instance = ns.get(id) as unknown as DurableObjectBase;
      await instance.ctx.storage.setAlarm(Date.now() + 30);
      await instance.ctx.storage.deleteAlarm();

      await new Promise((r) => setTimeout(r, 80));

      expect(called).toBe(false);
    });

    test("alarm retries on error with backoff info", async () => {
      const attempts: { retryCount: number; isRetry: boolean }[] = [];
      let shouldFail = true;

      class AlarmDO extends DurableObjectBase {
        async alarm(info: { retryCount: number; isRetry: boolean }) {
          attempts.push(info);
          if (shouldFail) {
            shouldFail = false;
            throw new Error("Simulated failure");
          }
        }
      }

      const ns = new DurableObjectNamespaceImpl(db, "AlarmDO5");
      ns._setClass(AlarmDO, {});

      const id = ns.idFromName("test");
      const instance = ns.get(id) as unknown as DurableObjectBase;
      await instance.ctx.storage.setAlarm(Date.now() + 10);

      // Wait for first fire + retry (backoff is 1s for retry 0, but we set timeout to be enough)
      await new Promise((r) => setTimeout(r, 1200));

      expect(attempts.length).toBe(2);
      expect(attempts[0]).toEqual({ retryCount: 0, isRetry: false });
      expect(attempts[1]).toEqual({ retryCount: 1, isRetry: true });
    });

    test("past-due alarm fires immediately on restore", async () => {
      let fired = false;

      class AlarmDO extends DurableObjectBase {
        async alarm() {
          fired = true;
        }
      }

      // Insert a past-due alarm directly into DB
      db.query("INSERT OR REPLACE INTO do_alarms (namespace, id, alarm_time) VALUES (?, ?, ?)")
        .run("AlarmDO6", "past-due-id", Date.now() - 1000);

      const ns = new DurableObjectNamespaceImpl(db, "AlarmDO6");
      ns._setClass(AlarmDO, {}); // _restoreAlarms should schedule it immediately

      await new Promise((r) => setTimeout(r, 50));

      expect(fired).toBe(true);
    });

    test("alarm persists across namespace instances", async () => {
      class AlarmDO extends DurableObjectBase {
        async alarm() {}
      }

      const ns = new DurableObjectNamespaceImpl(db, "AlarmDO7");
      ns._setClass(AlarmDO, {});

      const id = ns.idFromName("test");
      const instance = ns.get(id) as unknown as DurableObjectBase;
      const futureTime = Date.now() + 600000;
      await instance.ctx.storage.setAlarm(futureTime);

      // Create a new storage instance pointing to same db/namespace/id
      const storage2 = new SqliteDurableObjectStorage(db, "AlarmDO7", id.toString());
      expect(await storage2.getAlarm()).toBe(futureTime);
    });
  });
});

describe("DurableObject WebSocket Support", () => {
  describe("WebSocketRequestResponsePair", () => {
    test("stores request and response", () => {
      const pair = new WebSocketRequestResponsePair("ping", "pong");
      expect(pair.request).toBe("ping");
      expect(pair.response).toBe("pong");
    });
  });

  describe("State WebSocket methods", () => {
    let state: DurableObjectStateImpl;

    beforeEach(() => {
      const id = new DurableObjectIdImpl("ws-test");
      state = new DurableObjectStateImpl(id, db, "WsDO");
    });

    test("acceptWebSocket registers a WebSocket", () => {
      const ws = new MockWebSocket();
      state.acceptWebSocket(ws as unknown as WebSocket);
      expect(state.getWebSockets()).toHaveLength(1);
      expect(state.getWebSockets()[0]).toBe(ws as unknown as WebSocket);
    });

    test("acceptWebSocket with tags", () => {
      const ws = new MockWebSocket();
      state.acceptWebSocket(ws as unknown as WebSocket, ["user:1", "room:lobby"]);
      expect(state.getTags(ws as unknown as WebSocket)).toEqual(["user:1", "room:lobby"]);
    });

    test("getWebSockets filters by tag", () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      const ws3 = new MockWebSocket();
      state.acceptWebSocket(ws1 as unknown as WebSocket, ["room:a"]);
      state.acceptWebSocket(ws2 as unknown as WebSocket, ["room:b"]);
      state.acceptWebSocket(ws3 as unknown as WebSocket, ["room:a", "room:b"]);

      const roomA = state.getWebSockets("room:a");
      expect(roomA).toHaveLength(2);
      expect(roomA).toContain(ws1 as unknown as WebSocket);
      expect(roomA).toContain(ws3 as unknown as WebSocket);

      const roomB = state.getWebSockets("room:b");
      expect(roomB).toHaveLength(2);
      expect(roomB).toContain(ws2 as unknown as WebSocket);
      expect(roomB).toContain(ws3 as unknown as WebSocket);
    });

    test("getWebSockets without tag returns all", () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      state.acceptWebSocket(ws1 as unknown as WebSocket);
      state.acceptWebSocket(ws2 as unknown as WebSocket, ["tagged"]);
      expect(state.getWebSockets()).toHaveLength(2);
    });

    test("getTags returns empty array for unknown ws", () => {
      const ws = new MockWebSocket();
      expect(state.getTags(ws as unknown as WebSocket)).toEqual([]);
    });

    test("closed WebSocket is removed from accepted set", () => {
      const ws = new MockWebSocket();
      state.acceptWebSocket(ws as unknown as WebSocket);
      expect(state.getWebSockets()).toHaveLength(1);
      ws.close();
      expect(state.getWebSockets()).toHaveLength(0);
    });

    test("setWebSocketAutoResponse and getWebSocketAutoResponse", () => {
      expect(state.getWebSocketAutoResponse()).toBeNull();
      const pair = new WebSocketRequestResponsePair("ping", "pong");
      state.setWebSocketAutoResponse(pair);
      expect(state.getWebSocketAutoResponse()).toBe(pair);
    });

    test("setWebSocketAutoResponse with no arg clears it", () => {
      state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
      state.setWebSocketAutoResponse();
      expect(state.getWebSocketAutoResponse()).toBeNull();
    });

    test("auto-response sends response and skips handler", async () => {
      const messages: (string | ArrayBuffer)[] = [];
      class WsDO extends DurableObjectBase {
        async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer) {
          messages.push(message);
        }
      }
      const instance = new WsDO(state, {});
      state._doInstance = instance;

      state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

      const ws = new MockWebSocket();
      state.acceptWebSocket(ws as unknown as WebSocket);

      ws._receiveMessage("ping");
      await new Promise((r) => setTimeout(r, 10));

      // Auto-response was sent
      expect(ws.sent).toEqual(["pong"]);
      // Handler was NOT called
      expect(messages).toEqual([]);
    });

    test("non-matching message goes to handler", async () => {
      const messages: (string | ArrayBuffer)[] = [];
      class WsDO extends DurableObjectBase {
        async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer) {
          messages.push(message);
        }
      }
      const instance = new WsDO(state, {});
      state._doInstance = instance;

      state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

      const ws = new MockWebSocket();
      state.acceptWebSocket(ws as unknown as WebSocket);

      ws._receiveMessage("hello");
      await new Promise((r) => setTimeout(r, 10));

      expect(ws.sent).toEqual([]);
      expect(messages).toEqual(["hello"]);
    });

    test("getWebSocketAutoResponseTimestamp", () => {
      const ws = new MockWebSocket();
      state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
      state.acceptWebSocket(ws as unknown as WebSocket);

      // Before auto-response, timestamp is null
      expect(state.getWebSocketAutoResponseTimestamp(ws as unknown as WebSocket)).toBeNull();

      ws._receiveMessage("ping");

      // After auto-response, timestamp is set
      const ts = state.getWebSocketAutoResponseTimestamp(ws as unknown as WebSocket);
      expect(ts).toBeInstanceOf(Date);
      expect(ts!.getTime()).toBeCloseTo(Date.now(), -2);
    });

    test("getWebSocketAutoResponseTimestamp returns null for unknown ws", () => {
      const ws = new MockWebSocket();
      expect(state.getWebSocketAutoResponseTimestamp(ws as unknown as WebSocket)).toBeNull();
    });

    test("setHibernatableWebSocketEventTimeout is no-op", () => {
      state.setHibernatableWebSocketEventTimeout(5000);
      // does not throw
    });

    test("getHibernatableWebSocketEventTimeout returns null", () => {
      expect(state.getHibernatableWebSocketEventTimeout()).toBeNull();
    });
  });

  describe("WebSocket handler delegation via namespace", () => {
    test("webSocketMessage handler is called", async () => {
      const received: { ws: unknown; msg: string | ArrayBuffer }[] = [];

      class WsDO extends DurableObjectBase {
        async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
          received.push({ ws, msg: message });
        }
      }

      const ns = new DurableObjectNamespaceImpl(db, "WsDO1");
      ns._setClass(WsDO, {});

      const stub = ns.get(ns.idFromName("test")) as unknown as DurableObjectBase;
      const ws = new MockWebSocket();
      stub.ctx.acceptWebSocket(ws as unknown as WebSocket);

      ws._receiveMessage("hello world");
      await new Promise((r) => setTimeout(r, 10));

      expect(received).toHaveLength(1);
      expect(received[0]!.msg).toBe("hello world");
      expect(received[0]!.ws).toBe(ws);
    });

    test("webSocketClose handler is called", async () => {
      const closed: { code: number; reason: string }[] = [];

      class WsDO extends DurableObjectBase {
        async webSocketClose(_ws: WebSocket, code: number, reason: string, _wasClean: boolean) {
          closed.push({ code, reason });
        }
      }

      const ns = new DurableObjectNamespaceImpl(db, "WsDO2");
      ns._setClass(WsDO, {});

      const stub = ns.get(ns.idFromName("test")) as unknown as DurableObjectBase;
      const ws = new MockWebSocket();
      stub.ctx.acceptWebSocket(ws as unknown as WebSocket);

      ws.close(1001, "going away");
      await new Promise((r) => setTimeout(r, 10));

      expect(closed).toHaveLength(1);
      expect(closed[0]).toEqual({ code: 1001, reason: "going away" });
    });

    test("webSocketError handler is called", async () => {
      let errorCalled = false;

      class WsDO extends DurableObjectBase {
        async webSocketError(_ws: WebSocket, _error: unknown) {
          errorCalled = true;
        }
      }

      const ns = new DurableObjectNamespaceImpl(db, "WsDO3");
      ns._setClass(WsDO, {});

      const stub = ns.get(ns.idFromName("test")) as unknown as DurableObjectBase;
      const ws = new MockWebSocket();
      stub.ctx.acceptWebSocket(ws as unknown as WebSocket);

      ws._triggerError();
      await new Promise((r) => setTimeout(r, 10));

      expect(errorCalled).toBe(true);
    });
  });
});
