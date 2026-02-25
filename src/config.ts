import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseTOML } from 'smol-toml'
import type { WorkflowLimits } from './bindings/workflow'

export interface WranglerConfig {
	name: string
	main: string
	compatibility_date?: string
	compatibility_flags?: string[]
	kv_namespaces?: { binding: string; id: string }[]
	r2_buckets?: { binding: string; bucket_name: string }[]
	durable_objects?: {
		bindings: { name: string; class_name: string }[]
	}
	workflows?: { name: string; binding: string; class_name: string; limits?: Partial<WorkflowLimits> }[]
	d1_databases?: { binding: string; database_name: string; database_id: string; migrations_dir?: string }[]
	queues?: {
		producers?: { binding: string; queue: string; delivery_delay?: number }[]
		consumers?: {
			queue: string
			max_batch_size?: number
			max_batch_timeout?: number
			max_retries?: number
			dead_letter_queue?: string
			max_concurrency?: number
			retry_delay?: number
		}[]
	}
	send_email?: {
		name: string
		destination_address?: string
		allowed_destination_addresses?: string[]
	}[]
	ai?: { binding: string }
	hyperdrive?: {
		binding: string
		id: string
		localConnectionString?: string
	}[]
	services?: { binding: string; service: string; entrypoint?: string; props?: Record<string, unknown> }[]
	triggers?: { crons?: string[] }
	vars?: Record<string, string>
	assets?: {
		directory: string
		binding?: string
		html_handling?: 'none' | 'auto-trailing-slash' | 'force-trailing-slash' | 'drop-trailing-slash'
		not_found_handling?: 'none' | '404-page' | 'single-page-application'
		run_worker_first?: boolean | string[]
	}
	images?: {
		binding: string
	}
	containers?: {
		class_name: string
		image: string
		max_instances?: number
		instance_type?: string
		name?: string
	}[]
	analytics_engine_datasets?: { binding: string; dataset?: string }[]
	browser?: { binding: string }
	version_metadata?: { binding: string }
	migrations?: {
		tag: string
		new_classes?: string[]
		new_sqlite_classes?: string[]
		renamed_classes?: { from: string; to: string }[]
		deleted_classes?: string[]
	}[]
	env?: Record<string, Partial<Omit<WranglerConfig, 'env'>>>
}

/**
 * Load config from an explicit path (JSON/JSONC/TOML).
 */
export async function loadConfig(path: string, envName?: string): Promise<WranglerConfig> {
	const raw = await Bun.file(path).text()
	let config: WranglerConfig
	if (path.endsWith('.toml')) {
		config = parseTOML(raw) as unknown as WranglerConfig
	} else {
		config = Bun.JSONC.parse(raw)
	}
	return applyEnvOverrides(config, envName)
}

/**
 * Auto-detect config file in a directory. Tries wrangler.jsonc, wrangler.json, wrangler.toml.
 */
export async function autoLoadConfig(baseDir: string, envName?: string): Promise<WranglerConfig> {
	const candidates = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']
	for (const name of candidates) {
		const fullPath = join(baseDir, name)
		if (existsSync(fullPath)) {
			return loadConfig(fullPath, envName)
		}
	}
	throw new Error(`No wrangler config found in ${baseDir} (tried: ${candidates.join(', ')})`)
}

/**
 * Merge environment-specific overrides into the base config.
 * Environment sections can override: vars, bindings, routes, triggers, etc.
 */
function applyEnvOverrides(config: WranglerConfig, envName?: string): WranglerConfig {
	if (!envName || !config.env) return config
	const envConfig = config.env[envName]
	if (!envConfig) {
		throw new Error(`Environment "${envName}" not found in config. Available: ${Object.keys(config.env).join(', ')}`)
	}
	// Shallow merge: env-specific values override top-level ones
	const { env: _env, ...base } = config
	const merged = { ...base }
	for (const [key, value] of Object.entries(envConfig)) {
		if (value !== undefined) {
			;(merged as Record<string, unknown>)[key] = value
		}
	}
	return merged
}
