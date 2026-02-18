import { test, expect, beforeEach, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db";
import {
  DurableObjectBase,
  DurableObjectNamespaceImpl,
  DurableObjectStateImpl,
} from "../bindings/durable-object";
import { createServiceBinding } from "../bindings/service-binding";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

/**
 * Error propagation: DO → service binding → second worker
 *
 * Tests that errors thrown inside a service-bound worker propagate
 * correctly back through the service binding and through the DO stub.
 */
describe("Error propagation: DO → service binding → worker", () => {
  // ─── Second worker that throws errors ──────────────────────────
  const failingWorkerModule: Record<string, unknown> = {
    default: {
      async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/sync-throw") {
          throw new Error("sync kaboom in fetch");
        }
        if (url.pathname === "/async-throw") {
          await new Promise((r) => setTimeout(r, 5));
          throw new TypeError("async kaboom in fetch");
        }
        if (url.pathname === "/custom-error") {
          const err = new Error("custom error");
          (err as any).code = "WORKER_FAIL";
          (err as any).statusCode = 503;
          throw err;
        }
        return new Response("ok");
      },

      async explode(): Promise<string> {
        throw new Error("RPC explode");
      },

      async delayedExplode(): Promise<string> {
        await new Promise((r) => setTimeout(r, 5));
        throw new RangeError("async RPC explode");
      },

      async nestedFail(): Promise<string> {
        // Simulate a deeper call chain
        return await innerCall();
      },
    },
  };

  async function innerCall(): Promise<string> {
    throw new Error("deeply nested error");
  }

  // ─── DO that calls the second worker via service binding ───────
  class BridgeDO extends DurableObjectBase {
    async callFetch(path: string): Promise<string> {
      const svc = (this.env as any).FAILING_WORKER;
      const response = await svc.fetch(
        new Request(`http://fake-host${path}`)
      );
      return await response.text();
    }

    async callRpc(method: string): Promise<string> {
      const svc = (this.env as any).FAILING_WORKER;
      return await svc[method]();
    }

    async callFetchAndReturnStatus(path: string): Promise<number> {
      const svc = (this.env as any).FAILING_WORKER;
      const response = await svc.fetch(
        new Request(`http://fake-host${path}`)
      );
      return response.status;
    }

    // DO that catches the error itself and returns info about it
    async callAndCatch(path: string): Promise<{ name: string; message: string; code?: string }> {
      const svc = (this.env as any).FAILING_WORKER;
      try {
        await svc.fetch(new Request(`http://fake-host${path}`));
        return { name: "none", message: "no error" };
      } catch (e: any) {
        return {
          name: e.name,
          message: e.message,
          code: e.code,
        };
      }
    }
  }

  function setup() {
    const serviceProxy = createServiceBinding("failing-worker");
    (serviceProxy._wire as Function)(failingWorkerModule, {});

    const env = { FAILING_WORKER: serviceProxy };
    const ns = new DurableObjectNamespaceImpl(db, "BridgeDO", undefined, {
      evictionTimeoutMs: 0,
    });
    ns._setClass(BridgeDO, env);
    const stub = ns.get(ns.idFromName("test")) as any;
    return { stub, ns };
  }

  // ─── fetch() error propagation ─────────────────────────────────

  test("sync throw in worker fetch propagates through DO", async () => {
    const { stub } = setup();
    await expect(stub.callFetch("/sync-throw")).rejects.toThrow(
      "sync kaboom in fetch"
    );
  });

  test("async throw in worker fetch propagates through DO", async () => {
    const { stub } = setup();
    await expect(stub.callFetch("/async-throw")).rejects.toThrow(
      "async kaboom in fetch"
    );
  });

  test("error type is preserved (TypeError)", async () => {
    const { stub } = setup();
    try {
      await stub.callFetch("/async-throw");
      expect.unreachable("should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(TypeError);
      expect(e.message).toBe("async kaboom in fetch");
    }
  });

  test("custom error properties are preserved", async () => {
    const { stub } = setup();
    const info = await stub.callAndCatch("/custom-error");
    expect(info.name).toBe("Error");
    expect(info.message).toBe("custom error");
    expect(info.code).toBe("WORKER_FAIL");
  });

  test("successful fetch still works in same DO", async () => {
    const { stub } = setup();
    const result = await stub.callFetch("/ok");
    expect(result).toBe("ok");
  });

  // ─── RPC error propagation ─────────────────────────────────────

  test("RPC throw propagates through DO", async () => {
    const { stub } = setup();
    await expect(stub.callRpc("explode")).rejects.toThrow("RPC explode");
  });

  test("async RPC throw propagates through DO", async () => {
    const { stub } = setup();
    await expect(stub.callRpc("delayedExplode")).rejects.toThrow(
      "async RPC explode"
    );
  });

  test("RPC error type is preserved (RangeError)", async () => {
    const { stub } = setup();
    try {
      await stub.callRpc("delayedExplode");
      expect.unreachable("should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(RangeError);
    }
  });

  test("deeply nested RPC error propagates", async () => {
    const { stub } = setup();
    await expect(stub.callRpc("nestedFail")).rejects.toThrow(
      "deeply nested error"
    );
  });

  // ─── DO resilience after errors ────────────────────────────────

  test("DO remains usable after error from service binding", async () => {
    const { stub } = setup();

    // First call fails
    await expect(stub.callFetch("/sync-throw")).rejects.toThrow();

    // Second call succeeds — DO is not stuck
    const result = await stub.callFetch("/ok");
    expect(result).toBe("ok");
  });

  test("DO remains usable after RPC error", async () => {
    const { stub } = setup();

    await expect(stub.callRpc("explode")).rejects.toThrow();

    // Can still make successful calls
    const result = await stub.callFetch("/ok");
    expect(result).toBe("ok");
  });

  test("multiple sequential errors don't corrupt DO state", async () => {
    const { stub } = setup();

    await expect(stub.callFetch("/sync-throw")).rejects.toThrow();
    await expect(stub.callFetch("/async-throw")).rejects.toThrow();
    await expect(stub.callRpc("explode")).rejects.toThrow();

    // DO should still work fine
    const result = await stub.callFetch("/ok");
    expect(result).toBe("ok");
  });

  // ─── Concurrent error scenarios ────────────────────────────────

  test("concurrent calls: one fails, one succeeds", async () => {
    const { stub } = setup();

    const [failResult, okResult] = await Promise.allSettled([
      stub.callFetch("/sync-throw"),
      stub.callFetch("/ok"),
    ]);

    expect(failResult.status).toBe("rejected");
    expect((failResult as PromiseRejectedResult).reason.message).toBe(
      "sync kaboom in fetch"
    );
    expect(okResult.status).toBe("fulfilled");
    expect((okResult as PromiseFulfilledResult<string>).value).toBe("ok");
  });

  // ─── DO → DO → service binding chain ──────────────────────────

  test("error propagates through DO → DO → service binding chain", async () => {
    const serviceProxy = createServiceBinding("failing-worker");
    (serviceProxy._wire as Function)(failingWorkerModule, {});

    // Inner DO calls the service binding
    class InnerDO extends DurableObjectBase {
      async callService(): Promise<string> {
        const svc = (this.env as any).FAILING_WORKER;
        return await svc.explode();
      }
    }

    const innerNs = new DurableObjectNamespaceImpl(db, "InnerDO", undefined, {
      evictionTimeoutMs: 0,
    });
    innerNs._setClass(InnerDO, { FAILING_WORKER: serviceProxy });

    // Outer DO calls the inner DO
    class OuterDO extends DurableObjectBase {
      async callInner(): Promise<string> {
        const innerStub = (this.env as any).INNER_NS.get(
          (this.env as any).INNER_NS.idFromName("test")
        );
        return await innerStub.callService();
      }
    }

    const outerNs = new DurableObjectNamespaceImpl(db, "OuterDO", undefined, {
      evictionTimeoutMs: 0,
    });
    outerNs._setClass(OuterDO, { INNER_NS: innerNs });

    const outerStub = outerNs.get(outerNs.idFromName("test")) as any;
    await expect(outerStub.callInner()).rejects.toThrow("RPC explode");
  });
});
