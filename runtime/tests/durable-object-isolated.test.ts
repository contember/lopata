import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../db";
import {
  DurableObjectNamespaceImpl,
  DurableObjectIdImpl,
} from "../bindings/durable-object";
import { WorkerExecutorFactory } from "../bindings/do-executor-worker";

/**
 * Isolated-mode tests.
 *
 * These run the same DO contract as the in-process tests but with each
 * DO instance in a separate Bun Worker thread (WorkerExecutor).
 *
 * Setup: writes a temp worker module + wrangler config to disk, then
 * creates a WorkerExecutorFactory pointing at them.
 */

let tempDir: string;
let dataDir: string;
let db: Database;
let factory: WorkerExecutorFactory;
let modulePath: string;
let configPath: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "bunflare-isolated-"));
  dataDir = join(tempDir, ".bunflare");
  mkdirSync(dataDir, { recursive: true });

  // Create a worker module with test DO classes
  modulePath = join(tempDir, "worker.ts");
  writeFileSync(modulePath, `
    import { DurableObject } from "cloudflare:workers";

    export class TestCounter extends DurableObject {
      async getCount() {
        return (await this.ctx.storage.get("count")) ?? 0;
      }
      async increment() {
        const count = ((await this.ctx.storage.get("count")) ?? 0) + 1;
        await this.ctx.storage.put("count", count);
        return count;
      }
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/count") {
          const count = await this.getCount();
          return new Response(String(count));
        }
        if (url.pathname === "/increment") {
          const count = await this.increment();
          return new Response(String(count));
        }
        return new Response("Not Found", { status: 404 });
      }
    }

    export class AlarmDO extends DurableObject {
      async alarm(info) {
        await this.ctx.storage.put("alarm-fired", true);
        await this.ctx.storage.put("retry-count", info.retryCount);
      }
    }

    export class FireAndForgetDO extends DurableObject {
      async startBackground() {
        // Fire-and-forget: this promise should die with worker.terminate()
        (async () => {
          await new Promise(r => setTimeout(r, 5000));
          await this.ctx.storage.put("background-done", true);
        })();
        return "started";
      }
      async checkBackground() {
        return (await this.ctx.storage.get("background-done")) ?? false;
      }
    }

    export default {
      async fetch() {
        return new Response("ok");
      }
    };
  `);

  // Create wrangler config
  configPath = join(tempDir, "wrangler.json");
  writeFileSync(configPath, JSON.stringify({
    name: "test-isolated",
    main: "./worker.ts",
    durable_objects: {
      bindings: [
        { name: "COUNTER", class_name: "TestCounter" },
        { name: "ALARM", class_name: "AlarmDO" },
        { name: "FIRE_AND_FORGET", class_name: "FireAndForgetDO" },
      ],
    },
  }));

  // Create DB
  const dbPath = join(dataDir, "data.sqlite");
  db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode=WAL");
  runMigrations(db);

  // Create factory
  factory = new WorkerExecutorFactory();
  factory.configure(modulePath, configPath);
});

afterAll(() => {
  db.close();
});

describe("Isolated DO — basic RPC", () => {
  test("RPC method calls work through worker thread", async () => {
    const ns = new DurableObjectNamespaceImpl(db, "TestCounter", dataDir, { evictionTimeoutMs: 0 }, factory);
    ns._setClass(class {} as any, {}); // Dummy class — worker loads the real one

    const id = ns.idFromName("rpc-test");
    const stub = ns.get(id) as any;

    const count0 = await stub.getCount();
    expect(count0).toBe(0);

    const count1 = await stub.increment();
    expect(count1).toBe(1);

    const count2 = await stub.increment();
    expect(count2).toBe(2);

    const count = await stub.getCount();
    expect(count).toBe(2);

    // Cleanup
    const executor = ns._getExecutor(id.toString());
    if (executor) await executor.dispose();
  });

  test("stub.fetch works through worker thread", async () => {
    const ns = new DurableObjectNamespaceImpl(db, "TestCounter", dataDir, { evictionTimeoutMs: 0 }, factory);
    ns._setClass(class {} as any, {});

    const id = ns.idFromName("fetch-test");
    const stub = ns.get(id) as any;

    // Increment twice via fetch
    await stub.fetch("http://fake/increment");
    await stub.fetch("http://fake/increment");

    // Read count via fetch
    const resp = await stub.fetch("http://fake/count");
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("2");

    const executor = ns._getExecutor(id.toString());
    if (executor) await executor.dispose();
  });

  test("different ids have independent state", async () => {
    const ns = new DurableObjectNamespaceImpl(db, "TestCounter", dataDir, { evictionTimeoutMs: 0 }, factory);
    ns._setClass(class {} as any, {});

    const id1 = ns.idFromName("iso-a");
    const id2 = ns.idFromName("iso-b");
    const stub1 = ns.get(id1) as any;
    const stub2 = ns.get(id2) as any;

    await stub1.increment();
    await stub1.increment();

    expect(await stub1.getCount()).toBe(2);
    expect(await stub2.getCount()).toBe(0);

    const exec1 = ns._getExecutor(id1.toString());
    const exec2 = ns._getExecutor(id2.toString());
    if (exec1) await exec1.dispose();
    if (exec2) await exec2.dispose();
  });
});

describe("Isolated DO — dispose terminates worker", () => {
  test("fire-and-forget promises die with worker.terminate()", async () => {
    const ns = new DurableObjectNamespaceImpl(db, "FireAndForgetDO", dataDir, { evictionTimeoutMs: 0 }, factory);
    ns._setClass(class {} as any, {});

    const id = ns.idFromName("fire-forget-test");
    const stub = ns.get(id) as any;

    // Start background work
    const result = await stub.startBackground();
    expect(result).toBe("started");

    // Dispose (terminate worker) — background promise should die
    const executor = ns._getExecutor(id.toString());
    if (executor) await executor.dispose();

    // Wait a bit
    await new Promise(r => setTimeout(r, 200));

    // Create a new instance to check if background work completed
    // (it should NOT have because the worker was terminated)
    const ns2 = new DurableObjectNamespaceImpl(db, "FireAndForgetDO", dataDir, { evictionTimeoutMs: 0 }, factory);
    ns2._setClass(class {} as any, {});

    const stub2 = ns2.get(id) as any;
    const bgDone = await stub2.checkBackground();
    expect(bgDone).toBe(false);

    const exec2 = ns2._getExecutor(id.toString());
    if (exec2) await exec2.dispose();
  });

  test("dispose rejects in-flight commands", async () => {
    const ns = new DurableObjectNamespaceImpl(db, "TestCounter", dataDir, { evictionTimeoutMs: 0 }, factory);
    ns._setClass(class {} as any, {});

    const id = ns.idFromName("dispose-reject-test");
    const stub = ns.get(id) as any;

    // Get stub working first
    await stub.getCount();

    // Start a slow operation and immediately dispose
    const executor = ns._getExecutor(id.toString())!;
    const slowPromise = stub.increment();
    await executor.dispose();

    // The slow operation should be rejected
    await expect(slowPromise).rejects.toThrow();
  });
});

describe("Isolated DO — stub properties", () => {
  test("stub.id and stub.name work", async () => {
    const ns = new DurableObjectNamespaceImpl(db, "TestCounter", dataDir, { evictionTimeoutMs: 0 }, factory);
    ns._setClass(class {} as any, {});

    const id = ns.idFromName("props-test");
    const stub = ns.get(id) as any;

    expect(stub.id).toBe(id);
    expect(stub.name).toBe("props-test");

    const executor = ns._getExecutor(id.toString());
    if (executor) await executor.dispose();
  });

  test("stub.then is undefined (not thenable)", () => {
    const ns = new DurableObjectNamespaceImpl(db, "TestCounter", dataDir, { evictionTimeoutMs: 0 }, factory);
    ns._setClass(class {} as any, {});

    const id = ns.idFromName("then-test");
    const stub = ns.get(id) as any;

    expect(stub.then).toBeUndefined();
    expect(stub.catch).toBeUndefined();
    expect(stub.finally).toBeUndefined();
  });
});

describe("Isolated DO — data persistence", () => {
  test("data persists across executor lifecycles (same DB)", async () => {
    const ns1 = new DurableObjectNamespaceImpl(db, "TestCounter", dataDir, { evictionTimeoutMs: 0 }, factory);
    ns1._setClass(class {} as any, {});

    const id = ns1.idFromName("persist-test");
    const stub1 = ns1.get(id) as any;
    await stub1.increment();
    await stub1.increment();
    expect(await stub1.getCount()).toBe(2);

    // Dispose first executor
    const exec1 = ns1._getExecutor(id.toString());
    if (exec1) await exec1.dispose();

    // Create new namespace + executor pointing to same DB
    const ns2 = new DurableObjectNamespaceImpl(db, "TestCounter", dataDir, { evictionTimeoutMs: 0 }, factory);
    ns2._setClass(class {} as any, {});

    const stub2 = ns2.get(id) as any;
    expect(await stub2.getCount()).toBe(2);

    const exec2 = ns2._getExecutor(id.toString());
    if (exec2) await exec2.dispose();
  });
});
