import { plugin } from "bun";
import { DurableObjectBase, WebSocketRequestResponsePair } from "./bindings/durable-object";
import { WorkflowEntrypointBase, NonRetryableError } from "./bindings/workflow";
import { ContainerBase, getContainer, getRandom } from "./bindings/container";
import { SqliteCacheStorage } from "./bindings/cache";
import { HTMLRewriter } from "./bindings/html-rewriter";
import { WebSocketPair } from "./bindings/websocket-pair";
import { IdentityTransformStream, FixedLengthStream } from "./bindings/cf-streams";
import { patchGlobalCrypto } from "./bindings/crypto-extras";
import { getDatabase } from "./db";
import { globalEnv } from "./env";

// Register global `caches` object (CacheStorage)
Object.defineProperty(globalThis, "caches", {
  value: new SqliteCacheStorage(getDatabase()),
  writable: false,
  configurable: true,
});

// Register global `HTMLRewriter` class
Object.defineProperty(globalThis, "HTMLRewriter", {
  value: HTMLRewriter,
  writable: false,
  configurable: true,
});

// Register global `WebSocketPair` class
Object.defineProperty(globalThis, "WebSocketPair", {
  value: WebSocketPair,
  writable: false,
  configurable: true,
});

// Register global CF stream classes
Object.defineProperty(globalThis, "IdentityTransformStream", {
  value: IdentityTransformStream,
  writable: false,
  configurable: true,
});

Object.defineProperty(globalThis, "FixedLengthStream", {
  value: FixedLengthStream,
  writable: false,
  configurable: true,
});

// Patch crypto with CF-specific extensions (timingSafeEqual, DigestStream)
patchGlobalCrypto();

// Set navigator.userAgent to match Cloudflare Workers
Object.defineProperty(globalThis.navigator, "userAgent", {
  value: "Cloudflare-Workers",
  writable: false,
  configurable: true,
});

// Set navigator.language (behind enable_navigator_language compat flag in CF)
if (!globalThis.navigator.language) {
  Object.defineProperty(globalThis.navigator, "language", {
    value: "en",
    writable: false,
    configurable: true,
  });
}

// Set performance.timeOrigin to 0 (CF semantics)
Object.defineProperty(globalThis.performance, "timeOrigin", {
  value: 0,
  writable: false,
  configurable: true,
});

// Register scheduler.wait(ms) — await-able setTimeout alternative
Object.defineProperty(globalThis, "scheduler", {
  value: {
    wait(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  },
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
          protected ctx: unknown;
          protected env: unknown;
          constructor(ctx: unknown, env: unknown) {
            this.ctx = ctx;
            this.env = env;
          }
        },
        WebSocketRequestResponsePair,
        WebSocketPair,
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

    build.module("@cloudflare/containers", () => {
      return {
        exports: {
          Container: ContainerBase,
          getContainer,
          getRandom,
        },
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
