import type { Plugin } from "vite";
import { configPlugin } from "./config-plugin.ts";
import { modulesPlugin } from "./modules-plugin.ts";
import { globalsPlugin } from "./globals-plugin.ts";
import { devServerPlugin } from "./dev-server-plugin.ts";
import { reactRouterPlugin } from "./react-router-plugin.ts";

export interface BunflarePluginConfig {
  /** Path to wrangler.jsonc/.json/.toml config. Auto-detected if not specified. */
  configPath?: string;
  /** Vite environment name for SSR. Default: "ssr" */
  viteEnvironment?: { name?: string };
  /** Auxiliary workers loaded via native Bun import (not through Vite). */
  auxiliaryWorkers?: { configPath: string }[];
}

/**
 * Bunflare Vite plugin — drop-in replacement for `@cloudflare/vite-plugin`.
 *
 * Provides Cloudflare Worker compatibility in Vite dev mode:
 * - CF module resolution (cloudflare:workers, cloudflare:workflows, @cloudflare/containers)
 * - Global CF APIs (caches, HTMLRewriter, WebSocketPair, etc.)
 * - Bindings (KV, R2, D1, DO, Workflows, Queues, etc.) backed by SQLite/FS
 * - SSR middleware that calls worker.fetch() with the built env
 *
 * Install as a dependency (or link:) so Vite externalizes it at config bundle time.
 * Runtime imports then go through Bun's native module loader.
 */
export function bunflare(config?: BunflarePluginConfig): Plugin[] {
  const envName = config?.viteEnvironment?.name ?? "ssr";

  return [
    configPlugin(envName),
    modulesPlugin(envName),
    globalsPlugin(),
    devServerPlugin({
      configPath: config?.configPath,
      envName,
      auxiliaryWorkers: config?.auxiliaryWorkers,
    }),
    reactRouterPlugin(),
  ];
}
