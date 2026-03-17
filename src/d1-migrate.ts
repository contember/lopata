/**
 * Apply D1 migrations for all databases defined in wrangler config.
 *
 * Usage: bun src/d1-migrate.ts [--config path/to/wrangler.jsonc] [--env envName]
 *
 * Equivalent to: wrangler d1 migrations apply <db> --local
 *
 * This is a backward-compatible wrapper around the CLI migration logic.
 */

import { join, resolve } from 'node:path'
import { parseFlag, rejectRemoteFlag } from './cli/context'
import { applyMigrations } from './cli/d1'
import { autoLoadConfig, loadConfig } from './config'

const args = process.argv.slice(2)
rejectRemoteFlag(args)

const configPath = parseFlag(args, '--config') ?? parseFlag(args, '-c')
const envName = parseFlag(args, '--env') ?? parseFlag(args, '-e')
const baseDir = process.cwd()

const config = configPath
	? await loadConfig(resolve(baseDir, configPath), envName)
	: await autoLoadConfig(baseDir, envName)

const databases = config.d1_databases ?? []

if (databases.length === 0) {
	console.log('[d1-migrate] No D1 databases configured.')
	process.exit(0)
}

const dataDir = join(baseDir, '.lopata')
await applyMigrations(databases, dataDir)
