import { test, expect, beforeEach, describe } from "bun:test";
import {
  InMemoryDurableObjectStorage,
  DurableObjectIdImpl,
  DurableObjectStateImpl,
  DurableObjectBase,
  DurableObjectNamespaceImpl,
} from "../bindings/durable-object";

describe("DurableObjectStorage", () => {
  let storage: InMemoryDurableObjectStorage;

  beforeEach(() => {
    storage = new InMemoryDurableObjectStorage();
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
});

describe("DurableObjectState", () => {
  test("has id and storage", () => {
    const id = new DurableObjectIdImpl("test-id", "test");
    const state = new DurableObjectStateImpl(id);
    expect(state.id).toBe(id);
    expect(state.storage).toBeInstanceOf(InMemoryDurableObjectStorage);
  });

  test("waitUntil is no-op", () => {
    const state = new DurableObjectStateImpl(new DurableObjectIdImpl("id"));
    state.waitUntil(Promise.resolve()); // should not throw
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
    ns = new DurableObjectNamespaceImpl();
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
    const ns2 = new DurableObjectNamespaceImpl();
    const id = new DurableObjectIdImpl("test");
    expect(() => ns2.get(id)).toThrow("not wired");
  });
});
