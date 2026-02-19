import { DockerManager, type DockerRunOptions } from "./container-docker";
import { DurableObjectBase, type DurableObjectStateImpl } from "./durable-object";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ContainerStatus =
  | "stopped"
  | "running"
  | "healthy"
  | "stopping"
  | "stopped_with_code";

export interface ContainerState {
  status: ContainerStatus;
  lastChange: number;
  exitCode?: number;
}

export interface ContainerConfig {
  image: string;
  className: string;
  maxInstances?: number;
  dockerManager: DockerManager;
}

interface TcpPort {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  connect(): never;
}

// ─── ContainerRuntime ───────────────────────────────────────────────────────
// Per-DO-instance lifecycle manager that runs one Docker container.

export class ContainerRuntime {
  private _status: ContainerStatus = "stopped";
  private _lastChange = Date.now();
  private _exitCode?: number;
  private _hostPorts = new Map<number, number>(); // containerPort -> hostPort
  private _containerName: string;
  private _docker: DockerManager;
  private _image: string;
  private _healthCheckTimer?: ReturnType<typeof setInterval>;
  private _activityTimer?: ReturnType<typeof setTimeout>;
  private _monitorTimer?: ReturnType<typeof setInterval>;
  private _monitorResolve?: () => void;
  private _monitorReject?: (err: Error) => void;
  private _monitorPromise?: Promise<void>;

  // Config from ContainerBase subclass
  defaultPort = 8080;
  requiredPorts: number[] = [];
  sleepAfter?: string | number;
  envVars: Record<string, string> = {};
  entrypoint?: string[];
  enableInternet = true;
  pingEndpoint = "/";

  // Lifecycle callbacks
  onStart?: () => void | Promise<void>;
  onStop?: () => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
  onActivityExpired?: () => void | Promise<void>;

  constructor(className: string, idHex: string, image: string, docker: DockerManager) {
    this._containerName = `bunflare-${className}-${idHex.slice(0, 12)}`;
    this._image = image;
    this._docker = docker;
  }

  get status(): ContainerStatus {
    return this._status;
  }

  get containerName(): string {
    return this._containerName;
  }

  getState(): ContainerState {
    return {
      status: this._status,
      lastChange: this._lastChange,
      ...(this._exitCode !== undefined ? { exitCode: this._exitCode } : {}),
    };
  }

  private _transition(status: ContainerStatus, exitCode?: number) {
    this._status = status;
    this._lastChange = Date.now();
    if (exitCode !== undefined) this._exitCode = exitCode;
  }

  /**
   * Start the Docker container (non-blocking kickoff).
   */
  async start(options?: { envVars?: Record<string, string> }): Promise<void> {
    if (this._status === "running" || this._status === "healthy") return;

    this._transition("running");

    // Check if a container with this name already exists (e.g. after process crash)
    const existing = await this._docker.inspect(this._containerName);
    if (existing) {
      if (existing.state === "running") {
        // Recover port mappings from the running container
        this._hostPorts.clear();
        this._recoverPortMappings(existing.ports);
        await this.onStart?.();
        this._startHealthCheck();
        this._startMonitor();
        this.renewActivityTimeout();
        return;
      }
      // Container exists but isn't running — remove it before creating a new one
      await this._docker.remove(this._containerName);
    }

    // Determine ports to expose
    const ports = new Set<number>([this.defaultPort, ...this.requiredPorts]);
    this._hostPorts.clear();

    for (const port of ports) {
      const hostPort = await DockerManager.allocatePort();
      this._hostPorts.set(port, hostPort);
    }

    // Merge env vars
    const mergedEnv = { ...this.envVars, ...options?.envVars };

    // Build image if needed (lazy, mtime-cached)
    const sanitized = this._image.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "");
    const tag = `bunflare-${sanitized || "image"}`;
    // If image looks like a Dockerfile path, build it
    const isDockerfile = /Dockerfile/i.test(this._image) || this._image.startsWith("./") || this._image.startsWith("/");
    if (isDockerfile) {
      await this._docker.buildImage(this._image, tag);
    }

    const runOpts: DockerRunOptions = {
      image: isDockerfile ? tag : this._image,
      name: this._containerName,
      ports: this._hostPorts,
      envVars: mergedEnv,
      entrypoint: this.entrypoint,
      enableInternet: this.enableInternet,
    };

    try {
      await this._docker.run(runOpts);
    } catch (err) {
      this._transition("stopped");
      await this.onError?.(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }

    await this.onStart?.();

    // Start health check polling
    this._startHealthCheck();

    // Start docker monitor
    this._startMonitor();

    // Start activity timeout
    this.renewActivityTimeout();
  }

  /**
   * Stop the container gracefully.
   */
  async stop(signal?: number): Promise<void> {
    if (this._status === "stopped" || this._status === "stopped_with_code" || this._status === "stopping") return;

    this._transition("stopping");
    this._stopTimers();

    try {
      if (signal !== undefined) {
        await this._docker.signal(this._containerName, signal);
        // Give it a few seconds to exit after signal
        await new Promise(r => setTimeout(r, 3000));
      }
      await this._docker.stop(this._containerName, 10);
      await this._docker.remove(this._containerName);
    } catch {
      // Force remove on error
      await this._docker.remove(this._containerName).catch(() => {});
    }

    this._transition("stopped");
    await this.onStop?.();
    this._monitorResolve?.();
  }

  /**
   * Destroy the container immediately.
   */
  async destroy(error?: Error): Promise<void> {
    this._stopTimers();
    await this._docker.remove(this._containerName).catch(() => {});
    this._transition("stopped");
    if (error) {
      await this.onError?.(error);
    }
    this._monitorResolve?.();
  }

  /**
   * Send a signal to the container.
   */
  async signal(sig: number): Promise<void> {
    if (this._status !== "running" && this._status !== "healthy") return;
    await this._docker.signal(this._containerName, sig);
  }

  /**
   * Forward an HTTP request to the container.
   */
  async fetch(input: RequestInfo | URL, init?: RequestInit, port?: number): Promise<Response> {
    const targetPort = port ?? this.defaultPort;
    const hostPort = this._hostPorts.get(targetPort);
    if (!hostPort) {
      throw new Error(`No port mapping for container port ${targetPort}`);
    }

    const request = input instanceof Request ? input : new Request(input instanceof URL ? input.href : input, init);
    const url = new URL(request.url);
    url.hostname = "localhost";
    url.port = String(hostPort);
    url.protocol = "http:";

    const proxiedRequest = new Request(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
    });

    this.renewActivityTimeout();
    return globalThis.fetch(proxiedRequest);
  }

  /**
   * Get the host port mapped to a container port.
   */
  getHostPort(containerPort: number): number | undefined {
    return this._hostPorts.get(containerPort);
  }

  /**
   * Renew the activity timeout.
   */
  renewActivityTimeout(): void {
    if (this._activityTimer) clearTimeout(this._activityTimer);
    const timeoutMs = this._parseSleepAfter();
    if (timeoutMs === null) return;

    this._activityTimer = setTimeout(async () => {
      if (this._status !== "running" && this._status !== "healthy") return;
      if (this.onActivityExpired) {
        await this.onActivityExpired();
      } else {
        // Default: SIGTERM
        await this.stop(15);
      }
    }, timeoutMs);
  }

  /**
   * Returns a promise that resolves when the container exits normally,
   * or rejects on error.
   */
  monitor(): Promise<void> {
    if (!this._monitorPromise) {
      this._monitorPromise = new Promise<void>((resolve, reject) => {
        this._monitorResolve = resolve;
        this._monitorReject = reject;
      });
    }
    return this._monitorPromise;
  }

  /**
   * Cleanup: stop timers, remove container.
   */
  async cleanup(): Promise<void> {
    this._stopTimers();
    await this._docker.remove(this._containerName).catch(() => {});
    this._transition("stopped");
    this._monitorResolve?.();
  }

  // ─── Private ────────────────────────────────────────────────────────────

  /**
   * Recover host port mappings from docker inspect Ports object.
   * Format: { "8080/tcp": [{ "HostIp": "...", "HostPort": "49152" }], ... }
   */
  private _recoverPortMappings(ports: Record<string, unknown>) {
    for (const [key, bindings] of Object.entries(ports)) {
      if (!Array.isArray(bindings) || bindings.length === 0) continue;
      const containerPort = parseInt(key, 10);
      if (isNaN(containerPort)) continue;
      const hostPort = parseInt(bindings[0].HostPort, 10);
      if (isNaN(hostPort)) continue;
      this._hostPorts.set(containerPort, hostPort);
    }
  }

  private _startHealthCheck() {
    if (this._healthCheckTimer) clearInterval(this._healthCheckTimer);
    let consecutiveOk = 0;

    this._healthCheckTimer = setInterval(async () => {
      if (this._status !== "running") {
        if (this._healthCheckTimer) clearInterval(this._healthCheckTimer);
        return;
      }

      const hostPort = this._hostPorts.get(this.defaultPort);
      if (!hostPort) return;

      try {
        const resp = await fetch(`http://localhost:${hostPort}${this.pingEndpoint}`, {
          signal: AbortSignal.timeout(2000),
        });
        if (resp.status >= 200 && resp.status < 300) {
          consecutiveOk++;
          if (consecutiveOk >= 1) {
            this._transition("healthy");
            if (this._healthCheckTimer) clearInterval(this._healthCheckTimer);
          }
        } else {
          consecutiveOk = 0;
        }
      } catch {
        consecutiveOk = 0;
      }
    }, 500);
  }

  private _startMonitor() {
    if (this._monitorTimer) clearInterval(this._monitorTimer);

    this._monitorTimer = setInterval(async () => {
      if (this._status === "stopped" || this._status === "stopped_with_code" || this._status === "stopping") {
        if (this._monitorTimer) clearInterval(this._monitorTimer);
        return;
      }

      const info = await this._docker.inspect(this._containerName);
      if (!info) return;

      if (info.state === "exited" || info.state === "dead") {
        const exitCode = info.exitCode ?? 1;
        this._stopTimers();
        this._transition("stopped_with_code", exitCode);
        await this._docker.remove(this._containerName).catch(() => {});
        await this.onStop?.();
        this._monitorResolve?.();
      }
    }, 2000);
  }

  private _stopTimers() {
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
      this._healthCheckTimer = undefined;
    }
    if (this._activityTimer) {
      clearTimeout(this._activityTimer);
      this._activityTimer = undefined;
    }
    if (this._monitorTimer) {
      clearInterval(this._monitorTimer);
      this._monitorTimer = undefined;
    }
  }

  private _parseSleepAfter(): number | null {
    if (this.sleepAfter === undefined || this.sleepAfter === null) return null;
    if (typeof this.sleepAfter === "number") return this.sleepAfter * 1000;
    const str = this.sleepAfter;
    const match = str.match(/^(\d+)(s|m|h)$/);
    if (!match) return null;
    const value = parseInt(match[1]!, 10);
    switch (match[2]) {
      case "s": return value * 1000;
      case "m": return value * 60_000;
      case "h": return value * 3_600_000;
      default: return null;
    }
  }
}

// ─── ContainerContext ───────────────────────────────────────────────────────
// Implements the `ctx.container` low-level API.

export class ContainerContext {
  private _runtime: ContainerRuntime;

  constructor(runtime: ContainerRuntime) {
    this._runtime = runtime;
  }

  get running(): boolean {
    const s = this._runtime.status;
    return s === "running" || s === "healthy";
  }

  start(options?: { envVars?: Record<string, string> }): void {
    // Non-blocking kickoff
    this._runtime.start(options).catch(err => {
      console.error(`[bunflare] Container start error:`, err);
    });
  }

  async destroy(error?: Error): Promise<void> {
    await this._runtime.destroy(error);
  }

  async signal(sig: number): Promise<void> {
    await this._runtime.signal(sig);
  }

  getTcpPort(port: number): TcpPort {
    const runtime = this._runtime;
    return {
      fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        return runtime.fetch(input, init, port);
      },
      connect(): never {
        throw new Error("TCP connect() is not supported in bunflare dev mode. Use fetch() for HTTP forwarding.");
      },
    };
  }

  monitor(): Promise<void> {
    return this._runtime.monitor();
  }
}

// ─── ContainerBase ──────────────────────────────────────────────────────────
// User subclasses this. Extends DurableObjectBase with container lifecycle.

export class ContainerBase extends DurableObjectBase {
  // Configuration properties (override in subclass)
  defaultPort: number | undefined = 8080;
  requiredPorts: number[] = [];
  sleepAfter: string | number = "10m";
  envVars: Record<string, string> = {};
  entrypoint?: string[];
  enableInternet = true;
  pingEndpoint = "/";

  /** @internal Container runtime, set during instance creation */
  _containerRuntime?: ContainerRuntime;

  // ─── Lifecycle hooks (override in subclass) ─────────────────────────

  onStart(): void | Promise<void> {}
  onStop(_params?: unknown): void | Promise<void> {}
  onError(_error: unknown): void | Promise<void> {}

  onActivityExpired(): void | Promise<void> {
    // Default: send SIGTERM to stop container
    return this._containerRuntime?.stop(15);
  }

  // ─── Methods ────────────────────────────────────────────────────────

  /**
   * Fetch handler: auto-start if stopped, renew timeout, forward to container.
   * Reads `cf-container-target-port` header (set by switchPort()) to determine port.
   */
  async fetch(request: Request): Promise<Response> {
    if (!this._containerRuntime) {
      return new Response("Container runtime not initialized", { status: 500 });
    }

    const status = this._containerRuntime.status;
    if (status === "stopped" || status === "stopped_with_code") {
      await this.startAndWaitForPorts();
    }

    // Check for port override via switchPort() header
    let port: number | undefined;
    const portHeader = request.headers.get("cf-container-target-port");
    if (portHeader) {
      const parsed = parseInt(portHeader, 10);
      if (!isNaN(parsed)) port = parsed;
    }

    return this._containerRuntime.fetch(request, undefined, port);
  }

  /**
   * Forward an HTTP request to the container.
   * Supports multiple call signatures matching the real Container API:
   * - containerFetch(request: Request, port?: number)
   * - containerFetch(url: string | URL, init?: RequestInit, port?: number)
   */
  async containerFetch(
    requestOrUrl: Request | string | URL,
    portOrInit?: number | RequestInit,
    portParam?: number,
  ): Promise<Response> {
    if (!this._containerRuntime) {
      return new Response("Container runtime not initialized", { status: 500 });
    }

    const { input, init, port } = this._parseContainerFetchArgs(requestOrUrl, portOrInit, portParam);
    return this._containerRuntime.fetch(input, init, port);
  }

  /** Parse flexible containerFetch arguments */
  private _parseContainerFetchArgs(
    requestOrUrl: Request | string | URL,
    portOrInit?: number | RequestInit,
    portParam?: number,
  ): { input: RequestInfo | URL; init?: RequestInit; port?: number } {
    if (requestOrUrl instanceof Request) {
      // containerFetch(request, port?)
      const port = typeof portOrInit === "number" ? portOrInit : portParam;
      return { input: requestOrUrl, port };
    }
    // containerFetch(url, init?, port?)
    const init = typeof portOrInit === "object" ? portOrInit : undefined;
    const port = typeof portOrInit === "number" ? portOrInit : portParam;
    return { input: requestOrUrl, init, port };
  }

  /**
   * Start the container and wait until it's healthy or running.
   * Supports flexible call signatures matching the real Container API:
   * - startAndWaitForPorts()
   * - startAndWaitForPorts(ports?, cancellationOptions?, startOptions?)
   * - startAndWaitForPorts({ports?, abort?, ...})
   */
  async startAndWaitForPorts(
    portsOrArgs?: number | number[] | { ports?: number | number[]; abort?: AbortSignal; envVars?: Record<string, string> },
    cancellationOptions?: { abort?: AbortSignal },
    startOptions?: { envVars?: Record<string, string> },
  ): Promise<void> {
    if (!this._containerRuntime) throw new Error("Container runtime not initialized");

    // Parse args — extract abort signal and start options
    let abort: AbortSignal | undefined;
    let envVars: Record<string, string> | undefined;

    if (typeof portsOrArgs === "object" && portsOrArgs !== null && !Array.isArray(portsOrArgs) && !(typeof portsOrArgs === "number")) {
      // Object form: startAndWaitForPorts({ports, abort, envVars})
      abort = portsOrArgs.abort;
      envVars = portsOrArgs.envVars;
    } else {
      abort = cancellationOptions?.abort;
      envVars = startOptions?.envVars;
    }

    await this._containerRuntime.start(envVars ? { envVars } : undefined);

    // Wait for healthy (with timeout)
    const timeout = 60_000;
    const started = Date.now();
    while (this._containerRuntime.status === "running" && Date.now() - started < timeout) {
      if (abort?.aborted) throw new Error("Container startup aborted");
      await new Promise(r => setTimeout(r, 200));
    }

    if (this._containerRuntime.status !== "healthy" && this._containerRuntime.status !== "running") {
      throw new Error(`Container failed to start (status: ${this._containerRuntime.status})`);
    }
  }

  /**
   * Start the container.
   */
  async start(_startOptions?: unknown, _waitOptions?: unknown): Promise<void> {
    await this._containerRuntime?.start().catch(err => {
      console.error("[bunflare] Container start error:", err);
    });
  }

  /**
   * Stop the container.
   */
  async stop(signal?: number | string): Promise<void> {
    const sig = typeof signal === "string" ? undefined : signal;
    await this._containerRuntime?.stop(sig);
  }

  /**
   * Destroy the container.
   */
  async destroy(): Promise<void> {
    await this._containerRuntime?.destroy();
  }

  /**
   * Get current container state.
   */
  async getState(): Promise<ContainerState> {
    if (!this._containerRuntime) {
      return { status: "stopped", lastChange: Date.now() };
    }
    return this._containerRuntime.getState();
  }

  /**
   * Renew the activity timeout.
   */
  renewActivityTimeout(): void {
    this._containerRuntime?.renewActivityTimeout();
  }

  /**
   * Schedule a deferred callback via DO alarm.
   */
  async schedule(when: number | Date, _callback: string, _payload?: unknown): Promise<void> {
    const time = when instanceof Date ? when.getTime() : when;
    await this.ctx.storage.setAlarm(time);
  }

  /** @internal Wire the container runtime with config from this instance */
  _wireRuntime(runtime: ContainerRuntime): void {
    this._containerRuntime = runtime;

    // Copy config from instance to runtime
    runtime.defaultPort = this.defaultPort ?? 8080;
    runtime.requiredPorts = this.requiredPorts;
    runtime.sleepAfter = this.sleepAfter;
    runtime.envVars = this.envVars;
    runtime.entrypoint = this.entrypoint;
    runtime.enableInternet = this.enableInternet;
    runtime.pingEndpoint = this.pingEndpoint;

    // Wire lifecycle callbacks
    runtime.onStart = () => this.onStart();
    runtime.onStop = () => this.onStop();
    runtime.onError = (err) => this.onError(err);
    runtime.onActivityExpired = () => this.onActivityExpired();
  }
}

// ─── Utility Functions ──────────────────────────────────────────────────────

/**
 * Get a Container DO stub by name (defaults to "singleton").
 */
export function getContainer(binding: any, name?: string): unknown {
  const id = binding.idFromName(name ?? "singleton");
  return binding.get(id);
}

/**
 * Get a random Container DO stub from a pool of instances.
 */
export function getRandom(binding: any, instances?: number): unknown {
  const count = instances ?? 1;
  const index = Math.floor(Math.random() * count);
  const id = binding.idFromName(`random-${index}`);
  return binding.get(id);
}
