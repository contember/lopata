import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface BunflareConfig {
	/** Path to the main worker's wrangler config (HTTP entrypoint) */
	main: string
	/** Auxiliary workers, each with a service name and wrangler config path */
	workers?: Array<{
		name: string
		config: string
	}>
	/** Enable real cron scheduling based on wrangler triggers.crons (default: false) */
	cron?: boolean
	/**
	 * DO isolation mode:
	 * - "dev" (default) — all DO instances run in-process (fast, shared memory, hot reload)
	 * - "isolated" — each DO instance runs in a separate Bun Worker thread (faithful to CF production)
	 */
	isolation?: 'dev' | 'isolated'
	/** Browser Rendering binding config for local dev */
	browser?: {
		/** WS endpoint of an existing Chrome instance. If set, uses puppeteer-core connect(). */
		wsEndpoint?: string
		/** Path to Chrome executable (only used when spawning without wsEndpoint). */
		executablePath?: string
		/** Headless mode (default: true, only used when spawning). */
		headless?: boolean
	}
}

export function defineConfig(config: BunflareConfig): BunflareConfig {
	return config
}

/**
 * Try to load `bunflare.config.ts` from the given directory.
 * Returns null if the file doesn't exist.
 * All paths in the returned config are resolved relative to baseDir.
 */
export async function loadBunflareConfig(baseDir: string): Promise<BunflareConfig | null> {
	const configPath = join(baseDir, 'bunflare.config.ts')
	if (!existsSync(configPath)) return null

	const mod = await import(configPath)
	const config: BunflareConfig = mod.default ?? mod

	// Resolve all paths relative to baseDir
	config.main = resolve(baseDir, config.main)
	if (config.workers) {
		for (const worker of config.workers) {
			worker.config = resolve(baseDir, worker.config)
		}
	}

	return config
}
