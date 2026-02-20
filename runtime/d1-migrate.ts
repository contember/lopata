/**
 * Apply D1 migrations for all databases defined in wrangler config.
 *
 * Usage: bun runtime/d1-migrate.ts [--config path/to/wrangler.jsonc] [--env envName]
 *
 * Equivalent to: wrangler d1 migrations apply <db> --local
 *
 * This is a backward-compatible wrapper around the CLI migration logic.
 */

import { join, resolve } from 'node:path'
import { applyMigrations } from './cli/d1'
import { autoLoadConfig, loadConfig } from './config'

// Parse CLI flags
function parseFlag(name: string): string | undefined {
	const idx = process.argv.indexOf(name)
	return idx !== -1 ? process.argv[idx + 1] : undefined
}

const configPath = parseFlag('--config') ?? parseFlag('-c')
const envName = parseFlag('--env') ?? parseFlag('-e')
const baseDir = process.cwd()

const config = configPath
	? await loadConfig(resolve(baseDir, configPath), envName)
	: await autoLoadConfig(baseDir, envName)

const databases = config.d1_databases ?? []

if (databases.length === 0) {
	console.log('[d1-migrate] No D1 databases configured.')
	process.exit(0)
}

const dataDir = join(baseDir, '.bunflare')
await applyMigrations(databases, dataDir)
