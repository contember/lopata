/**
 * Service Binding — worker-to-worker communication via HTTP fetch and RPC.
 *
 * The binding is a Proxy that supports:
 * - `.fetch(request | url, init?)` — calls the target worker's fetch() handler
 * - `.myMethod(args)` — RPC call to the target's entrypoint class method
 */

type WorkerModule = Record<string, unknown>;

export class ServiceBinding {
  private _workerModule: WorkerModule | null = null;
  private _env: Record<string, unknown> | null = null;
  private _entrypoint: string | undefined;
  private _serviceName: string;

  constructor(serviceName: string, entrypoint?: string) {
    this._serviceName = serviceName;
    this._entrypoint = entrypoint;
  }

  _wire(workerModule: WorkerModule, env: Record<string, unknown>): void {
    this._workerModule = workerModule;
    this._env = env;
  }

  get isWired(): boolean {
    return this._workerModule !== null;
  }

  private _getTarget(): { fetch?: (req: Request, env: unknown, ctx: unknown) => Promise<Response> } & Record<string, unknown> {
    if (!this._workerModule) {
      throw new Error(`Service binding "${this._serviceName}" is not wired — target worker not loaded`);
    }
    if (this._entrypoint) {
      const cls = this._workerModule[this._entrypoint] as (new (...args: unknown[]) => Record<string, unknown>) | undefined;
      if (!cls) {
        throw new Error(`Entrypoint "${this._entrypoint}" not exported from worker module`);
      }
      return new cls(this._env);
    }
    return this._workerModule.default as Record<string, unknown>;
  }

  async fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
    const target = this._getTarget();
    if (!target?.fetch) {
      throw new Error(`Service binding "${this._serviceName}" target has no fetch() handler`);
    }
    const url = input instanceof URL ? input.toString() : input;
    const request = typeof url === "string" ? new Request(url, init) : url;
    const ctx = {
      waitUntil(_promise: Promise<unknown>) {},
      passThroughOnException() {},
    };
    return target.fetch(request, this._env, ctx);
  }

  toProxy(): Record<string, unknown> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return new Proxy({} as Record<string, unknown>, {
      get(_obj, prop: string) {
        if (prop === "fetch") {
          return self.fetch.bind(self);
        }
        if (prop === "_wire") {
          return self._wire.bind(self);
        }
        if (prop === "isWired") {
          return self.isWired;
        }
        // RPC: return an async function that calls the method on the target
        return (...args: unknown[]) => {
          const target = self._getTarget();
          const method = target[prop];
          if (typeof method !== "function") {
            throw new Error(`Service binding "${self._serviceName}": "${prop}" is not a method on the target`);
          }
          return (method as (...a: unknown[]) => unknown).call(target, ...args);
        };
      },
    });
  }
}

/**
 * Create a service binding proxy.
 */
export function createServiceBinding(serviceName: string, entrypoint?: string): Record<string, unknown> {
  const binding = new ServiceBinding(serviceName, entrypoint);
  return binding.toProxy();
}
