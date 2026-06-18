import type { Plugin } from 'vite'
import { configPlugin } from './config-plugin.ts'
import { devServerPlugin } from './dev-server-plugin.ts'
import { globalsPlugin } from './globals-plugin.ts'
import { modulesPlugin } from './modules-plugin.ts'
import { reactRouterPlugin } from './react-router-plugin.ts'

export interface LopataPluginConfig {
	/** Path to wrangler.jsonc/.json/.toml config. Auto-detected if not specified. */
	configPath?: string
	/** Vite environment name for SSR. Default: "ssr" */
	viteEnvironment?: { name?: string }
	/** Host patterns that route to the main worker (takes priority over wildcard auxiliary hosts). */
	hosts?: string[]
	/**
	 * Auxiliary workers. Unlike the main worker (which runs in-process via Vite
	 * SSR), each aux worker runs in its own Bun Worker thread and is loaded via
	 * native Bun import — it does NOT go through Vite's transform pipeline
	 * (aliases, `import.meta.glob`, env replacement, plugins). Intended for
	 * workers reached over a service binding (APIs, queue/cron consumers) that
	 * don't rely on Vite transforms; author them as plain Bun-resolvable modules.
	 */
	auxiliaryWorkers?: { configPath: string; name?: string; hosts?: string[] }[]
}

/**
 * Lopata Vite plugin — drop-in replacement for `@cloudflare/vite-plugin`.
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
export function lopata(config?: LopataPluginConfig): Plugin[] {
	const envName = config?.viteEnvironment?.name ?? 'ssr'

	return [
		configPlugin(envName),
		modulesPlugin(envName),
		globalsPlugin(),
		devServerPlugin({
			configPath: config?.configPath,
			envName,
			hosts: config?.hosts,
			auxiliaryWorkers: config?.auxiliaryWorkers,
		}),
		reactRouterPlugin(),
	]
}
