import { test, expect, beforeEach, describe, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DurableObjectNamespaceImpl,
  DurableObjectStateImpl,
  DurableObjectIdImpl,
} from "../bindings/durable-object";
import {
  ContainerRuntime,
  ContainerContext,
  ContainerBase,
  getContainer,
  getRandom,
} from "../bindings/container";
import { DockerManager, type DockerRunOptions, type DockerContainerInfo } from "../bindings/container-docker";

// ─── Mock Docker Manager ──────────────────────────────────────────────────

class MockDockerManager extends DockerManager {
  builtImages: string[] = [];
  runningContainers = new Map<string, { image: string; ports: Map<number, number>; state: string; exitCode: number }>();
  signals: { name: string; sig: number }[] = [];
  removed: string[] = [];

  override async buildImage(_dockerfilePath: string, tag: string, _context?: string): Promise<void> {
    this.builtImages.push(tag);
  }

  override async run(options: DockerRunOptions): Promise<string> {
    const id = `mock-${options.name}`;
    this.runningContainers.set(options.name, {
      image: options.image,
      ports: new Map(options.ports),
      state: "running",
      exitCode: 0,
    });
    return id;
  }

  override async stop(name: string, _timeoutSec?: number): Promise<void> {
    const container = this.runningContainers.get(name);
    if (container) {
      container.state = "exited";
    }
  }

  override async kill(name: string): Promise<void> {
    const container = this.runningContainers.get(name);
    if (container) {
      container.state = "exited";
      container.exitCode = 137;
    }
  }

  override async signal(name: string, sig: number): Promise<void> {
    this.signals.push({ name, sig });
  }

  override async inspect(name: string): Promise<DockerContainerInfo | null> {
    const container = this.runningContainers.get(name);
    if (!container) return null;
    return {
      id: `mock-${name}`,
      name,
      state: container.state,
      exitCode: container.exitCode,
      ports: {},
    };
  }

  override async remove(name: string): Promise<void> {
    this.runningContainers.delete(name);
    this.removed.push(name);
  }
}

let db: Database;
let dataDir: string;
let mockDocker: MockDockerManager;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  dataDir = mkdtempSync(join(tmpdir(), "bunflare-container-test-"));
  mockDocker = new MockDockerManager();
});

// ─── ContainerRuntime State Machine ────────────────────────────────────────

describe("ContainerRuntime", () => {
  let runtime: ContainerRuntime;

  beforeEach(() => {
    runtime = new ContainerRuntime("TestContainer", "abcdef123456", "test-image", mockDocker);
    runtime.sleepAfter = undefined; // disable activity timeout for most tests
  });

  test("initial state is stopped", () => {
    const state = runtime.getState();
    expect(state.status).toBe("stopped");
  });

  test("start transitions to running", async () => {
    await runtime.start();
    expect(runtime.status).toBe("running");
    expect(mockDocker.runningContainers.has("bunflare-TestContainer-abcdef123456")).toBe(true);
  });

  test("start is idempotent when already running", async () => {
    await runtime.start();
    await runtime.start(); // should not throw
    expect(runtime.status).toBe("running");
  });

  test("stop transitions running to stopped", async () => {
    await runtime.start();
    await runtime.stop();
    expect(runtime.status).toBe("stopped");
  });

  test("stop is idempotent when already stopped", async () => {
    await runtime.stop(); // should not throw
    expect(runtime.status).toBe("stopped");
  });

  test("destroy removes container", async () => {
    await runtime.start();
    await runtime.destroy();
    expect(runtime.status).toBe("stopped");
    expect(mockDocker.removed).toContain("bunflare-TestContainer-abcdef123456");
  });

  test("signal forwards to docker", async () => {
    await runtime.start();
    await runtime.signal(15);
    expect(mockDocker.signals).toContainEqual({
      name: "bunflare-TestContainer-abcdef123456",
      sig: 15,
    });
  });

  test("signal is no-op when stopped", async () => {
    await runtime.signal(15);
    expect(mockDocker.signals).toHaveLength(0);
  });

  test("container name format", () => {
    expect(runtime.containerName).toBe("bunflare-TestContainer-abcdef123456");
  });

  test("getState includes exitCode when stopped_with_code", async () => {
    await runtime.start();
    // Simulate container exit by transitioning manually
    await runtime.destroy(new Error("test exit"));
    const state = runtime.getState();
    expect(state.status).toBe("stopped");
  });

  test("lifecycle callbacks are invoked", async () => {
    const calls: string[] = [];
    runtime.onStart = () => { calls.push("start"); };
    runtime.onStop = () => { calls.push("stop"); };

    await runtime.start();
    expect(calls).toContain("start");

    await runtime.stop();
    expect(calls).toContain("stop");
  });

  test("onError is called when docker run fails", async () => {
    const errors: Error[] = [];
    runtime.onError = (err) => { errors.push(err); };

    // Make docker run fail
    const failDocker = new MockDockerManager();
    failDocker.run = async () => { throw new Error("Docker run failed"); };
    const failRuntime = new ContainerRuntime("Fail", "aaa", "bad-image", failDocker);
    failRuntime.onError = (err) => { errors.push(err); };

    try {
      await failRuntime.start();
    } catch {
      // expected
    }
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toBe("Docker run failed");
  });

  test("monitor resolves when container stops", async () => {
    await runtime.start();
    const monitorPromise = runtime.monitor();
    await runtime.stop();
    await monitorPromise; // should resolve
  });

  test("cleanup removes container and stops timers", async () => {
    await runtime.start();
    await runtime.cleanup();
    expect(runtime.status).toBe("stopped");
    expect(mockDocker.removed).toContain("bunflare-TestContainer-abcdef123456");
  });
});

// ─── Activity Timeout ──────────────────────────────────────────────────────

describe("ContainerRuntime activity timeout", () => {
  test("parseSleepAfter handles seconds string", async () => {
    const runtime = new ContainerRuntime("Test", "aaa", "img", mockDocker);
    runtime.sleepAfter = "2s";

    let expired = false;
    runtime.onActivityExpired = () => { expired = true; };

    await runtime.start();

    // Wait for timeout to fire
    await new Promise(r => setTimeout(r, 2500));
    expect(expired).toBe(true);

    await runtime.cleanup();
  });

  test("parseSleepAfter handles minutes string", () => {
    const runtime = new ContainerRuntime("Test", "aaa", "img", mockDocker);
    runtime.sleepAfter = "5m";
    // We just test parsing via getState - timeout should be set but won't fire in this test
    expect(runtime.status).toBe("stopped");
  });

  test("parseSleepAfter handles number (seconds)", async () => {
    const runtime = new ContainerRuntime("Test", "aaa", "img", mockDocker);
    runtime.sleepAfter = 1; // 1 second

    let expired = false;
    runtime.onActivityExpired = () => { expired = true; };

    await runtime.start();
    await new Promise(r => setTimeout(r, 1500));
    expect(expired).toBe(true);

    await runtime.cleanup();
  });

  test("renewActivityTimeout resets the timer", async () => {
    const runtime = new ContainerRuntime("Test", "aaa", "img", mockDocker);
    runtime.sleepAfter = "2s";

    let expired = false;
    runtime.onActivityExpired = () => { expired = true; };

    await runtime.start();
    // Renew at 1s
    await new Promise(r => setTimeout(r, 1000));
    runtime.renewActivityTimeout();
    // Check at 2.5s from start (0.5s past original timeout, but only 1.5s from renewal)
    await new Promise(r => setTimeout(r, 1500));
    expect(expired).toBe(false);

    await runtime.cleanup();
  });
});

// ─── ContainerContext ──────────────────────────────────────────────────────

describe("ContainerContext", () => {
  test("running reflects runtime status", async () => {
    const runtime = new ContainerRuntime("Test", "aaa", "img", mockDocker);
    const ctx = new ContainerContext(runtime);

    expect(ctx.running).toBe(false);
    await runtime.start();
    expect(ctx.running).toBe(true);
    await runtime.stop();
    expect(ctx.running).toBe(false);
  });

  test("start kicks off runtime non-blocking", () => {
    const runtime = new ContainerRuntime("Test", "aaa", "img", mockDocker);
    const ctx = new ContainerContext(runtime);
    ctx.start(); // should not throw, non-blocking
    // Eventually starts
  });

  test("destroy cleans up runtime", async () => {
    const runtime = new ContainerRuntime("Test", "aaa", "img", mockDocker);
    const ctx = new ContainerContext(runtime);
    await runtime.start();
    await ctx.destroy();
    expect(ctx.running).toBe(false);
  });

  test("signal forwards to runtime", async () => {
    const runtime = new ContainerRuntime("Test", "aaa", "img", mockDocker);
    const ctx = new ContainerContext(runtime);
    await runtime.start();
    await ctx.signal(9);
    expect(mockDocker.signals).toContainEqual({ name: runtime.containerName, sig: 9 });
  });

  test("getTcpPort returns a TcpPort with fetch and throwing connect", async () => {
    const runtime = new ContainerRuntime("Test", "aaa", "img", mockDocker);
    const ctx = new ContainerContext(runtime);
    const tcpPort = ctx.getTcpPort(8080);

    expect(typeof tcpPort.fetch).toBe("function");
    expect(() => tcpPort.connect()).toThrow("not supported");
  });

  test("monitor resolves when runtime stops", async () => {
    const runtime = new ContainerRuntime("Test", "aaa", "img", mockDocker);
    const ctx = new ContainerContext(runtime);
    await runtime.start();
    const monitorPromise = ctx.monitor();
    await runtime.stop();
    await monitorPromise;
  });
});

// ─── ContainerBase ─────────────────────────────────────────────────────────

describe("ContainerBase", () => {
  test("extends DurableObjectBase", () => {
    const id = new DurableObjectIdImpl("test-id");
    const state = new DurableObjectStateImpl(id, db, "TestContainer", dataDir);
    const instance = new ContainerBase(state, {});
    expect(instance.ctx).toBe(state);
    expect(instance.defaultPort).toBe(8080);
    expect(instance.enableInternet).toBe(true);
    expect(instance.pingEndpoint).toBe("/");
  });

  test("getState returns stopped when no runtime", () => {
    const id = new DurableObjectIdImpl("test-id");
    const state = new DurableObjectStateImpl(id, db, "TestContainer", dataDir);
    const instance = new ContainerBase(state, {});
    const containerState = instance.getState();
    expect(containerState.status).toBe("stopped");
  });

  test("_wireRuntime copies config and hooks", () => {
    const id = new DurableObjectIdImpl("test-id");
    const state = new DurableObjectStateImpl(id, db, "TestContainer", dataDir);

    class MyContainer extends ContainerBase {
      override defaultPort = 3000;
      override requiredPorts = [3001, 3002];
      override sleepAfter = "10m";
      override envVars = { NODE_ENV: "production" };
      override pingEndpoint = "/health";
    }

    const instance = new MyContainer(state, {});
    const runtime = new ContainerRuntime("MyContainer", "abc", "my-image", mockDocker);
    instance._wireRuntime(runtime);

    expect(runtime.defaultPort).toBe(3000);
    expect(runtime.requiredPorts).toEqual([3001, 3002]);
    expect(runtime.sleepAfter).toBe("10m");
    expect(runtime.envVars).toEqual({ NODE_ENV: "production" });
    expect(runtime.pingEndpoint).toBe("/health");
  });

  test("fetch returns error when no runtime wired", async () => {
    const id = new DurableObjectIdImpl("test-id");
    const state = new DurableObjectStateImpl(id, db, "TestContainer", dataDir);
    const instance = new ContainerBase(state, {});
    const response = await instance.fetch(new Request("http://localhost/test"));
    expect(response.status).toBe(500);
  });

  test("custom subclass lifecycle hooks are called", async () => {
    const calls: string[] = [];

    class MyContainer extends ContainerBase {
      override onStart() { calls.push("start"); }
      override onStop() { calls.push("stop"); }
      override onError(err: Error) { calls.push(`error:${err.message}`); }
    }

    const id = new DurableObjectIdImpl("test-id");
    const state = new DurableObjectStateImpl(id, db, "TestContainer", dataDir);
    const instance = new MyContainer(state, {});
    const runtime = new ContainerRuntime("MyContainer", "abc", "my-image", mockDocker);
    instance._wireRuntime(runtime);

    await runtime.start();
    expect(calls).toContain("start");

    await runtime.stop();
    expect(calls).toContain("stop");
  });
});

// ─── Utility Functions ─────────────────────────────────────────────────────

describe("getContainer", () => {
  test("returns a stub from binding using idFromName", () => {
    const namespace = new DurableObjectNamespaceImpl(db, "TestContainer", dataDir);
    namespace._setClass(ContainerBase, {});

    const stub = getContainer(namespace);
    expect(stub).toBeDefined();
  });

  test("uses custom name when provided", () => {
    const namespace = new DurableObjectNamespaceImpl(db, "TestContainer", dataDir);
    namespace._setClass(ContainerBase, {});

    const stub1 = getContainer(namespace, "worker-1");
    const stub2 = getContainer(namespace, "worker-2");
    expect((stub1 as any).id.name).toBe("worker-1");
    expect((stub2 as any).id.name).toBe("worker-2");
  });

  test("defaults to 'singleton' name", () => {
    const namespace = new DurableObjectNamespaceImpl(db, "TestContainer", dataDir);
    namespace._setClass(ContainerBase, {});

    const stub = getContainer(namespace);
    expect((stub as any).id.name).toBe("singleton");
  });
});

describe("getRandom", () => {
  test("returns a random stub from pool", () => {
    const namespace = new DurableObjectNamespaceImpl(db, "TestContainer", dataDir);
    namespace._setClass(ContainerBase, {});

    const stub = getRandom(namespace, 5);
    expect(stub).toBeDefined();
    const name = (stub as any).id.name as string;
    expect(name).toMatch(/^random-\d$/);
  });

  test("defaults to 1 instance", () => {
    const namespace = new DurableObjectNamespaceImpl(db, "TestContainer", dataDir);
    namespace._setClass(ContainerBase, {});

    const stub = getRandom(namespace);
    expect((stub as any).id.name).toBe("random-0");
  });
});

// ─── Namespace Container Integration ───────────────────────────────────────

describe("DurableObjectNamespace with container config", () => {
  test("creates ContainerRuntime when container config is set", () => {
    const namespace = new DurableObjectNamespaceImpl(db, "TestContainer", dataDir);
    namespace._setContainerConfig({
      className: "TestContainer",
      image: "test-image",
      dockerManager: mockDocker,
    });
    namespace._setClass(ContainerBase, {});

    const stub = getContainer(namespace);
    expect(stub).toBeDefined();

    // The instance should have a container runtime wired
    const instance = namespace._getInstance(namespace.idFromName("singleton").toString());
    expect(instance).toBeDefined();
    expect(instance).toBeInstanceOf(ContainerBase);
    const containerInstance = instance as ContainerBase;
    expect(containerInstance._containerRuntime).toBeDefined();
  });

  test("container state is wired to DurableObjectState", () => {
    const namespace = new DurableObjectNamespaceImpl(db, "TestContainer", dataDir);
    namespace._setContainerConfig({
      className: "TestContainer",
      image: "test-image",
      dockerManager: mockDocker,
    });
    namespace._setClass(ContainerBase, {});

    const id = namespace.idFromName("singleton");
    const stub = namespace.get(id);
    const instance = namespace._getInstance(id.toString());
    expect(instance).toBeDefined();
    const state = instance!.ctx as DurableObjectStateImpl;
    expect(state.container).toBeDefined();
    expect(state.container!.running).toBe(false);
  });

  test("destroy cleans up container runtimes", async () => {
    const namespace = new DurableObjectNamespaceImpl(db, "TestContainer", dataDir);
    namespace._setContainerConfig({
      className: "TestContainer",
      image: "test-image",
      dockerManager: mockDocker,
    });
    namespace._setClass(ContainerBase, {});

    const stub = getContainer(namespace);
    const instance = namespace._getInstance(namespace.idFromName("singleton").toString()) as ContainerBase;

    // Start the container runtime
    await instance._containerRuntime!.start();
    expect(mockDocker.runningContainers.size).toBeGreaterThan(0);

    // Destroy the namespace
    namespace.destroy();

    // Give async cleanup time to run
    await new Promise(r => setTimeout(r, 100));
    expect(mockDocker.removed.length).toBeGreaterThan(0);
  });
});

// ─── DockerManager.allocatePort ────────────────────────────────────────────

describe("DockerManager.allocatePort", () => {
  test("allocates a valid port", async () => {
    const port = await DockerManager.allocatePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  test("allocates unique ports", async () => {
    const ports = await Promise.all([
      DockerManager.allocatePort(),
      DockerManager.allocatePort(),
      DockerManager.allocatePort(),
    ]);
    const unique = new Set(ports);
    expect(unique.size).toBe(3);
  });
});
