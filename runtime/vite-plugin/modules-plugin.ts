import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));

const VIRTUAL_MODULES: Record<string, string> = {
  "cloudflare:workers": "\0cloudflare:workers",
  "cloudflare:workflows": "\0cloudflare:workflows",
  "@cloudflare/containers": "\0@cloudflare/containers",
};

function resolvePath(relativePath: string): string {
  return resolve(__dirname, "..", relativePath);
}

/**
 * Resolves Cloudflare virtual modules (cloudflare:workers, cloudflare:workflows,
 * @cloudflare/containers) to re-exports from Bunflare runtime binding implementations.
 *
 * Only active in the SSR environment.
 */
export function modulesPlugin(envName: string): Plugin {
  return {
    name: "bunflare:modules",

    resolveId(id: string) {
      if (this.environment?.name !== envName) return;
      if (id in VIRTUAL_MODULES) {
        return VIRTUAL_MODULES[id];
      }
    },

    load(id: string) {
      if (id === "\0cloudflare:workers") {
        const durableObject = resolvePath("bindings/durable-object");
        const workflow = resolvePath("bindings/workflow");
        const websocketPair = resolvePath("bindings/websocket-pair");

        // env is a proxy to globalThis.__bunflare_env so it works across
        // Vite SSR runner and native Bun module graphs (which are separate
        // module instances — a direct re-export of globalEnv would be empty
        // in the SSR runner because setGlobalEnv() writes to the native instance).
        return `
export { DurableObjectBase as DurableObject } from "${durableObject}";
export { WorkflowEntrypointBase as WorkflowEntrypoint } from "${workflow}";
export { WebSocketRequestResponsePair } from "${durableObject}";
export { WebSocketPair } from "${websocketPair}";
export const env = new Proxy({}, {
  get(_, prop) { return globalThis.__bunflare_env?.[prop]; },
  set(_, prop, value) { if (globalThis.__bunflare_env) globalThis.__bunflare_env[prop] = value; return true; },
  has(_, prop) { return prop in (globalThis.__bunflare_env ?? {}); },
  ownKeys() { return Object.keys(globalThis.__bunflare_env ?? {}); },
  getOwnPropertyDescriptor(_, prop) {
    const target = globalThis.__bunflare_env;
    if (target && prop in target) return { configurable: true, enumerable: true, value: target[prop] };
  },
});
export class WorkerEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this[Symbol.for("bunflare.RpcTarget")] = true;
  }
}
export class RpcTarget {
  constructor() {
    this[Symbol.for("bunflare.RpcTarget")] = true;
  }
}
`;
      }

      if (id === "\0cloudflare:workflows") {
        const workflow = resolvePath("bindings/workflow");
        return `export { NonRetryableError } from "${workflow}";`;
      }

      if (id === "\0@cloudflare/containers") {
        const container = resolvePath("bindings/container");
        return `
export { ContainerBase as Container } from "${container}";
export { getContainer, getRandom } from "${container}";
`;
      }
    },
  };
}
