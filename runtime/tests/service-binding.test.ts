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
      // Sync methods now return Promise (async consistency)
      const result = await greet("World");
      expect(result).toBe("Hello, World!");
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

    test("throws if method does not exist", async () => {
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
      // Now returns Promise (async consistency)
      const result = await greet("World");
      expect(result).toBe("Hello from entrypoint, World! Env: test");
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
      const result = await greet("Test");
      expect(result).toBe("Hello from entrypoint, Test! Env: custom");
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

  describe("RPC property access", () => {
    test("await a non-function property returns its value", async () => {
      const workerModule: Record<string, unknown> = {
        default: {
          fetch: async () => new Response("ok"),
          version: "1.2.3",
          config: { debug: true, level: 5 },
        },
      };

      const proxy = createServiceBinding("my-worker");
      (proxy._wire as Function)(workerModule, mockEnv);

      const version = await proxy.version;
      expect(version).toBe("1.2.3");

      const config = await proxy.config;
      expect(config).toEqual({ debug: true, level: 5 });
    });

    test("await a function property returns the bound function", async () => {
      const workerModule: Record<string, unknown> = {
        default: {
          fetch: async () => new Response("ok"),
          greet(name: string) { return `Hi ${name}`; },
        },
      };

      const proxy = createServiceBinding("my-worker");
      (proxy._wire as Function)(workerModule, mockEnv);

      // Awaiting a function property returns the function itself
      const fn = await proxy.greet;
      expect(typeof fn).toBe("function");
    });

    test("await undefined property returns undefined", async () => {
      const workerModule: Record<string, unknown> = {
        default: {
          fetch: async () => new Response("ok"),
        },
      };

      const proxy = createServiceBinding("my-worker");
      (proxy._wire as Function)(workerModule, mockEnv);

      const val = await proxy.nonExistentProp;
      expect(val).toBeUndefined();
    });

    test("property access on named entrypoint", async () => {
      class ConfigEntrypoint {
        env: Record<string, unknown>;
        appName = "my-app";
        constructor(env: Record<string, unknown>) {
          this.env = env;
        }
      }

      const workerModule: Record<string, unknown> = {
        default: { fetch: async () => new Response("ok") },
        ConfigEntrypoint,
      };

      const proxy = createServiceBinding("my-worker", "ConfigEntrypoint");
      (proxy._wire as Function)(workerModule, mockEnv);

      const name = await proxy.appName;
      expect(name).toBe("my-app");
    });
  });

  describe("Async consistency", () => {
    test("sync method returns a Promise", async () => {
      const workerModule: Record<string, unknown> = {
        default: {
          fetch: async () => new Response("ok"),
          add(a: number, b: number) { return a + b; },
        },
      };

      const proxy = createServiceBinding("my-worker");
      (proxy._wire as Function)(workerModule, mockEnv);

      const add = proxy.add as Function;
      const result = add(3, 4);
      // Must be a Promise
      expect(result).toBeInstanceOf(Promise);
      expect(await result).toBe(7);
    });

    test("async method still returns a Promise", async () => {
      const workerModule: Record<string, unknown> = {
        default: {
          fetch: async () => new Response("ok"),
          async multiply(a: number, b: number) { return a * b; },
        },
      };

      const proxy = createServiceBinding("my-worker");
      (proxy._wire as Function)(workerModule, mockEnv);

      const multiply = proxy.multiply as Function;
      const result = multiply(3, 4);
      expect(result).toBeInstanceOf(Promise);
      expect(await result).toBe(12);
    });
  });

  describe("Advanced serialization (Request/Response as RPC params)", () => {
    test("pass Request as RPC argument", async () => {
      const workerModule: Record<string, unknown> = {
        default: {
          fetch: async () => new Response("ok"),
          async handleRequest(req: Request) {
            return { url: req.url, method: req.method };
          },
        },
      };

      const proxy = createServiceBinding("my-worker");
      (proxy._wire as Function)(workerModule, mockEnv);

      const handleRequest = proxy.handleRequest as Function;
      const result = await handleRequest(new Request("http://example.com/api", { method: "POST" }));
      expect(result.url).toBe("http://example.com/api");
      expect(result.method).toBe("POST");
    });

    test("return Response from RPC method", async () => {
      const workerModule: Record<string, unknown> = {
        default: {
          fetch: async () => new Response("ok"),
          async makeResponse() {
            return new Response("rpc-response", { status: 201 });
          },
        },
      };

      const proxy = createServiceBinding("my-worker");
      (proxy._wire as Function)(workerModule, mockEnv);

      const makeResponse = proxy.makeResponse as Function;
      const response: Response = await makeResponse();
      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(201);
      expect(await response.text()).toBe("rpc-response");
    });

    test("pass ReadableStream as RPC argument", async () => {
      const workerModule: Record<string, unknown> = {
        default: {
          fetch: async () => new Response("ok"),
          async consumeStream(stream: ReadableStream) {
            const reader = stream.getReader();
            const chunks: Uint8Array[] = [];
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
            }
            return new TextDecoder().decode(chunks[0]);
          },
        },
      };

      const proxy = createServiceBinding("my-worker");
      (proxy._wire as Function)(workerModule, mockEnv);

      const consumeStream = proxy.consumeStream as Function;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("streamed-data"));
          controller.close();
        },
      });
      const result = await consumeStream(stream);
      expect(result).toBe("streamed-data");
    });
  });

  describe("Subrequest limits", () => {
    test("tracks subrequest count for fetch calls", async () => {
      const proxy = createServiceBinding("my-worker", undefined, { maxSubrequests: 3 });
      (proxy._wire as Function)(mockWorkerModule, mockEnv);

      const fetch = proxy.fetch as Function;
      await fetch("http://localhost/1");
      await fetch("http://localhost/2");
      await fetch("http://localhost/3");
      // 4th should throw
      expect(fetch("http://localhost/4")).rejects.toThrow("subrequest limit exceeded");
    });

    test("tracks subrequest count for RPC calls", async () => {
      const workerModule: Record<string, unknown> = {
        default: {
          fetch: async () => new Response("ok"),
          noop() { return "ok"; },
        },
      };

      const proxy = createServiceBinding("my-worker", undefined, { maxSubrequests: 2 });
      (proxy._wire as Function)(workerModule, mockEnv);

      const noop = proxy.noop as Function;
      await noop();
      await noop();
      // 3rd should throw
      expect(() => noop()).toThrow("subrequest limit exceeded");
    });

    test("subrequest count can be read", () => {
      const proxy = createServiceBinding("my-worker", undefined, { maxSubrequests: 100 });
      expect(proxy._subrequestCount).toBe(0);
    });
  });

  describe("TCP connect()", () => {
    test("connect() throws not supported error", () => {
      const proxy = createServiceBinding("my-worker");
      (proxy._wire as Function)(mockWorkerModule, mockEnv);

      const connect = proxy.connect as Function;
      expect(() => connect("example.com:443")).toThrow("not supported in local dev mode");
    });
  });

  describe("Promise protocol safety", () => {
    test("proxy is not a thenable itself (then returns undefined)", () => {
      const proxy = createServiceBinding("my-worker");
      (proxy._wire as Function)(mockWorkerModule, mockEnv);

      // The proxy itself should not have a .then that makes it look like a Promise
      // (which would cause auto-unwrapping). Direct .then access on proxy should be undefined.
      expect((proxy as Record<string, unknown>).then).toBeUndefined();
    });

    test("can be used in Promise.resolve without auto-unwrapping", async () => {
      const proxy = createServiceBinding("my-worker");
      (proxy._wire as Function)(mockWorkerModule, mockEnv);

      // Promise.resolve should not try to call .then on the proxy
      const resolved = await Promise.resolve(proxy);
      expect(resolved).toBe(proxy);
    });
  });
});
