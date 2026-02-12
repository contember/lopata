import { test, expect, beforeEach, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db";
import {
  SqliteDurableObjectStorage,
  DurableObjectIdImpl,
  DurableObjectStateImpl,
  DurableObjectBase,
  DurableObjectNamespaceImpl,
} from "../bindings/durable-object";

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
