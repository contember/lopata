import { plugin } from "bun";
import { DurableObjectBase } from "./bindings/durable-object";
import { WorkflowEntrypointBase } from "./bindings/workflow";

plugin({
  name: "cloudflare-workers-shim",
  setup(build) {
    build.module("cloudflare:workers", () => {
      return {
        exports: {
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
          RpcTarget: class {},
        },
        loader: "object",
      };
    });

    build.module("cloudflare:workflows", () => {
      return {
        exports: {
          NonRetryableError: class NonRetryableError extends Error {
            constructor(message: string) {
              super(message);
              this.name = "NonRetryableError";
            }
          },
        },
        loader: "object",
      };
    });
  },
});
