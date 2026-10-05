import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseTOML } from 'smol-toml'
import type { WorkflowLimits } from './bindings/workflow'

export interface WorkerExportDeclaration {
	type: 'worker'
	cache?: { enabled: boolean }
}

export type DurableObjectExportDeclaration =
	& { type: 'durable-object' }
	& (
		| { state?: 'created'; storage: 'sqlite' | 'legacy-kv'; container?: string }
		| { state: 'deleted' }
		| { state: 'renamed'; renamed_to: string }
		| { state: 'transferred'; transferred_to: string }
		| { state: 'expecting-transfer'; storage: 'sqlite' | 'legacy-kv'; transfer_from: string; container?: string }
	)

export interface WorkflowExportDeclaration {
	type: 'workflow'
	name: string
	limits?: { steps?: number }
	schedules?: string | string[]
	default_retention?: { success_retention?: string | number; error_retention?: string | number }
}

// Non-Worker declarations are preserved here; their lifecycle is not implemented by the cache runtime.
export type ExportDeclaration = WorkerExportDeclaration | DurableObjectExportDeclaration | WorkflowExportDeclaration

export interface WranglerConfig {
	name: string
	cache?: { enabled: boolean; cross_version_cache?: boolean }
	exports?: Record<string, ExportDeclaration>
	/**
	 * Entry module. Optional: a worker that only has `assets` is an assets-only
	 * (static-site) worker — Cloudflare runs no script for it, and neither do we.
	 * A config with neither `main` nor `assets` is rejected by `GenerationManager`;
	 * `loadConfig` itself allows it, because `lopata kv|r2|d1`, `d1-migrate` and the
	 * testing helper load bindings-only configs that are never served.
	 */
	main?: string
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
		remote?: boolean
	}[]
	ai?: { binding: string }
	ai_search_namespaces?: {
		binding: string
		namespace: string
		remote?: boolean
	}[]
	artifacts?: {
		binding: string
		namespace: string
	}[]
	worker_loaders?: {
		binding: string
	}[]
	hyperdrive?: {
		binding: string
		id: string
		localConnectionString?: string
	}[]
	vpc_networks?: {
		binding: string
		network_id?: string
		tunnel_id?: string
		remote?: boolean
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
	media?: {
		binding: string
	}
	containers?: {
		class_name: string
		image: string
		max_instances?: number
		instance_type?: string
		name?: string
	}[]
	routes?: (string | { pattern: string; zone_name?: string; custom_domain?: boolean })[]
	analytics_engine_datasets?: { binding: string; dataset?: string }[]
	browser?: { binding: string }
	version_metadata?: { binding: string }
	flagship?: { binding: string; app_id: string }
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
		config = Bun.JSONC.parse(raw) as WranglerConfig
	}
	const merged = applyEnvOverrides(config, envName)
	validateWorkerCacheConfig(merged)
	return merged
}

export function validateWorkerCacheConfig(config: WranglerConfig): void {
	function object(value: unknown, path: string): Record<string, unknown> {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object`)
		return Object.fromEntries(Object.entries(value))
	}
	function cacheBlock(value: unknown, path: string, crossVersion: boolean): void {
		const block = object(value, path)
		if (typeof block.enabled !== 'boolean') throw new TypeError(`${path}.enabled must be a boolean`)
		if (block.cross_version_cache !== undefined && (!crossVersion || typeof block.cross_version_cache !== 'boolean')) {
			throw new TypeError(`${path}.cross_version_cache is only supported as a top-level boolean`)
		}
		if (Object.keys(block).some(key => key !== 'enabled' && !(crossVersion && key === 'cross_version_cache'))) {
			throw new TypeError(`${path} contains an unsupported field`)
		}
	}
	if (config.cache !== undefined) cacheBlock(config.cache, 'cache', true)
	if (config.exports !== undefined) {
		for (const [name, value] of Object.entries(object(config.exports, 'exports'))) {
			const entry = object(value, `exports.${name}`)
			if (entry.type === 'worker') {
				if (entry.cache !== undefined) cacheBlock(entry.cache, `exports.${name}.cache`, false)
			} else if (entry.type === 'durable-object' || entry.type === 'workflow') {
				if (entry.cache !== undefined) throw new TypeError(`exports.${name}.cache is only supported on worker exports`)
			} else {
				throw new TypeError(`exports.${name}.type must be "worker", "durable-object", or "workflow"`)
			}
		}
	}
}

/**
 * True when the worker has a script. A worker WITHOUT one is assets-only: Cloudflare
 * serves it purely from `assets`, so there is no module to import, spawn or watch.
 *
 * A type guard so callers that go on to resolve `config.main` are narrowed.
 */
export function hasScript(config: WranglerConfig): config is WranglerConfig & { main: string } {
	return !!config.main
}

/**
 * Auto-detect config file in a directory. Tries wrangler.jsonc, wrangler.json, wrangler.toml.
 */
export async function autoLoadConfig(baseDir: string, envName?: string): Promise<WranglerConfig> {
	return loadConfig(findConfigPath(baseDir), envName)
}

/** Resolve the wrangler config path under `baseDir` (jsonc | json | toml). */
export function findConfigPath(baseDir: string): string {
	const candidates = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']
	for (const name of candidates) {
		const fullPath = join(baseDir, name)
		if (existsSync(fullPath)) return fullPath
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
