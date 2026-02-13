import { plugin } from "bun";
import { DurableObjectBase, WebSocketRequestResponsePair } from "./bindings/durable-object";
import { WorkflowEntrypointBase, NonRetryableError } from "./bindings/workflow";
import { SqliteCacheStorage } from "./bindings/cache";
import { getDatabase } from "./db";
import { globalEnv } from "./env";

// Register global `caches` object (CacheStorage)
Object.defineProperty(globalThis, "caches", {
  value: new SqliteCacheStorage(getDatabase()),
  writable: false,
  configurable: true,
});

plugin({
  name: "cloudflare-workers-shim",
  setup(build) {
    build.module("cloudflare:workers", () => {
      // Use a getter so `env` always returns the latest built env object
      const exports: Record<string, unknown> = {
        DurableObject: DurableObjectBase,
        WorkflowEntrypoint: WorkflowEntrypointBase,
        WorkerEntrypoint: class WorkerEntrypoint {
          env: unknown;
          ctx: unknown;
          constructor(env?: unknown) {
            this.env = env;
            this.ctx = {
              waitUntil(_promise: Promise<unknown>) {},
              passThroughOnException() {},
            };
          }
        },
        WebSocketRequestResponsePair,
        RpcTarget: class {},
      };
      Object.defineProperty(exports, "env", {
        get() { return globalEnv; },
        enumerable: true,
      });
      return {
        exports,
        loader: "object",
      };
    });

    build.module("cloudflare:workflows", () => {
      return {
        exports: {
          NonRetryableError,
        },
        loader: "object",
      };
    });
  },
});
