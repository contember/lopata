import { test, expect, describe } from "bun:test";
import { createServiceBinding } from "../bindings/service-binding";

describe("Service Binding", () => {
  // Mock worker module with default fetch handler
  const mockWorkerModule: Record<string, unknown> = {
    default: {
      fetch: async (request: Request, _env: unknown, _ctx: unknown) => {
        const url = new URL(request.url);
        return new Response(`Hello from ${url.pathname}`, { status: 200 });
      },
    },
  };

  const mockEnv = { MY_VAR: "test" };

  describe("HTTP mode (fetch)", () => {
    test("fetch with Request object", async () => {
      const proxy = createServiceBinding("my-worker");
      (proxy._wire as Function)(mockWorkerModule, mockEnv);

      const fetch = proxy.fetch as Function;
      const response = await fetch(new Request("http://localhost/hello"));
      expect(response).toBeInstanceOf(Response);
      expect(await response.text()).toBe("Hello from /hello");
      expect(response.status).toBe(200);
    });

    test("fetch with URL string", async () => {
      const proxy = createServiceBinding("my-worker");
      (proxy._wire as Function)(mockWorkerModule, mockEnv);

      const fetch = proxy.fetch as Function;
      const response = await fetch("http://localhost/path");
      expect(await response.text()).toBe("Hello from /path");
    });

    test("fetch with URL string and init", async () => {
      const workerModule: Record<string, unknown> = {
        default: {
          fetch: async (request: Request) => {
            return new Response(`Method: ${request.method}`);
          },
        },
      };

      const proxy = createServiceBinding("my-worker");
      (proxy._wire as Function)(workerModule, mockEnv);

      const fetch = proxy.fetch as Function;
      const response = await fetch("http://localhost/api", { method: "POST" });
      expect(await response.text()).toBe("Method: POST");
    });

    test("fetch passes env to target handler", async () => {
      const workerModule: Record<string, unknown> = {
        default: {
          fetch: async (_request: Request, env: Record<string, string>) => {
            return new Response(`Env: ${env.MY_VAR}`);
          },
        },
      };

      const proxy = createServiceBinding("my-worker");
      (proxy._wire as Function)(workerModule, mockEnv);

      const fetch = proxy.fetch as Function;
      const response = await fetch("http://localhost/");
      expect(await response.text()).toBe("Env: test");
    });

    test("fetch throws if not wired", async () => {
      const proxy = createServiceBinding("my-worker");
      const fetch = proxy.fetch as Function;
      expect(fetch(new Request("http://localhost/"))).rejects.toThrow("not wired");
    });

    test("fetch throws if target has no fetch handler", async () => {
      const workerModule: Record<string, unknown> = {
        default: {},
      };

      const proxy = createServiceBinding("my-worker");
      (proxy._wire as Function)(workerModule, mockEnv);

      const fetch = proxy.fetch as Function;
      expect(fetch(new Request("http://localhost/"))).rejects.toThrow("no fetch() handler");
    });
  });

  describe("RPC mode", () => {
    test("call method on default export", async () => {
      const workerModule: Record<string, unknown> = {
        default: {
          fetch: async () => new Response("ok"),
          greet(name: string) {
            return `Hello, ${name}!`;
          },
        },
      };

      const proxy = createServiceBinding("my-worker");
      (proxy._wire as Function)(workerModule, mockEnv);

      const greet = proxy.greet as Function;
      expect(greet("World")).toBe("Hello, World!");
    });

    test("call async method on default export", async () => {
      const workerModule: Record<string, unknown> = {
        default: {
          fetch: async () => new Response("ok"),
          async getUser(id: number) {
            return { id, name: "Alice" };
          },
        },
      };

      const proxy = createServiceBinding("my-worker");
      (proxy._wire as Function)(workerModule, mockEnv);

      const getUser = proxy.getUser as Function;
      const user = await getUser(1);
      expect(user).toEqual({ id: 1, name: "Alice" });
    });

    test("throws if method does not exist", () => {
      const workerModule: Record<string, unknown> = {
        default: {
          fetch: async () => new Response("ok"),
        },
      };

      const proxy = createServiceBinding("my-worker");
      (proxy._wire as Function)(workerModule, mockEnv);

      const nonExistent = proxy.nonExistent as Function;
      expect(() => nonExistent()).toThrow("is not a method");
    });
  });

  describe("Named entrypoint (RPC)", () => {
    class MyEntrypoint {
      env: Record<string, unknown>;
      constructor(env: Record<string, unknown>) {
        this.env = env;
      }
      greet(name: string) {
        return `Hello from entrypoint, ${name}! Env: ${this.env.MY_VAR}`;
      }
      async compute(a: number, b: number) {
        return a + b;
      }
    }

    const workerModule: Record<string, unknown> = {
      default: {
        fetch: async () => new Response("default"),
      },
      MyEntrypoint,
    };

    test("calls method on named entrypoint", async () => {
      const proxy = createServiceBinding("my-worker", "MyEntrypoint");
      (proxy._wire as Function)(workerModule, mockEnv);

      const greet = proxy.greet as Function;
      expect(greet("World")).toBe("Hello from entrypoint, World! Env: test");
    });

    test("async method on named entrypoint", async () => {
      const proxy = createServiceBinding("my-worker", "MyEntrypoint");
      (proxy._wire as Function)(workerModule, mockEnv);

      const compute = proxy.compute as Function;
      expect(await compute(2, 3)).toBe(5);
    });

    test("named entrypoint receives env via constructor", async () => {
      const proxy = createServiceBinding("my-worker", "MyEntrypoint");
      (proxy._wire as Function)(workerModule, { MY_VAR: "custom" });

      const greet = proxy.greet as Function;
      expect(greet("Test")).toBe("Hello from entrypoint, Test! Env: custom");
    });

    test("throws if named entrypoint not found", () => {
      const proxy = createServiceBinding("my-worker", "NonExistent");
      (proxy._wire as Function)(workerModule, mockEnv);

      const method = proxy.someMethod as Function;
      expect(() => method()).toThrow('Entrypoint "NonExistent" not exported');
    });

    test("fetch on named entrypoint calls entrypoint's fetch if available", async () => {
      class FetchableEntrypoint {
        env: Record<string, unknown>;
        constructor(env: Record<string, unknown>) {
          this.env = env;
        }
        async fetch(request: Request) {
          return new Response(`Entrypoint fetch: ${new URL(request.url).pathname}`);
        }
      }

      const module: Record<string, unknown> = {
        default: { fetch: async () => new Response("default") },
        FetchableEntrypoint,
      };

      const proxy = createServiceBinding("my-worker", "FetchableEntrypoint");
      (proxy._wire as Function)(module, mockEnv);

      const fetch = proxy.fetch as Function;
      const response = await fetch(new Request("http://localhost/test"));
      expect(await response.text()).toBe("Entrypoint fetch: /test");
    });
  });

  describe("isWired", () => {
    test("false before wiring", () => {
      const proxy = createServiceBinding("my-worker");
      expect(proxy.isWired).toBe(false);
    });

    test("true after wiring", () => {
      const proxy = createServiceBinding("my-worker");
      (proxy._wire as Function)(mockWorkerModule, mockEnv);
      expect(proxy.isWired).toBe(true);
    });
  });
});
