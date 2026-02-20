import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface LopataConfig {
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
	/** AI SQL generation config for the D1 console */
	ai?: {
		/** OpenRouter API key (fallback: OPENROUTER_API_KEY env var) */
		apiKey?: string
		/** Model to use (default: "anthropic/claude-haiku-4.5") */
		model?: string
	}
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

export function defineConfig(config: LopataConfig): LopataConfig {
	return config
}

/**
 * Try to load `lopata.config.ts` from the given directory.
 * Returns null if the file doesn't exist.
 * All paths in the returned config are resolved relative to baseDir.
 */
export async function loadLopataConfig(baseDir: string): Promise<LopataConfig | null> {
	const configPath = join(baseDir, 'lopata.config.ts')
	if (!existsSync(configPath)) return null

	const mod = await import(configPath)
	const config: LopataConfig = mod.default ?? mod

	// Resolve all paths relative to baseDir
	config.main = resolve(baseDir, config.main)
	if (config.workers) {
		for (const worker of config.workers) {
			worker.config = resolve(baseDir, worker.config)
		}
	}

	return config
}
