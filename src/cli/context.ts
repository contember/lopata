import type { Database } from 'bun:sqlite'
import { join, resolve } from 'node:path'
import { parseArgs as nodeParseArgs } from 'node:util'
import type { WranglerConfig } from '../config'
import { autoLoadConfig, loadConfig } from '../config'

export interface CliContext {
	envName: string | undefined
	config: () => Promise<WranglerConfig>
	db: () => Database
	dataDir: () => string
}

interface ParseArgsStringOption {
	type: 'string'
	short?: string
}

interface ParseArgsBooleanOption {
	type: 'boolean'
	short?: string
}

type ParseArgsOption = ParseArgsStringOption | ParseArgsBooleanOption

type ParseArgsValues<T extends Record<string, ParseArgsOption>> = {
	[K in keyof T]: T[K] extends ParseArgsBooleanOption ? boolean | undefined : string | undefined
}

/** Parse CLI args with strict validation — throws on unknown flags. */
export function parseArgs<const T extends Record<string, ParseArgsOption>>(
	args: string[],
	options: T,
): { values: ParseArgsValues<T>; positionals: string[] } {
	try {
		return nodeParseArgs({ args, options, strict: true, allowPositionals: true }) as unknown as {
			values: ParseArgsValues<T>
			positionals: string[]
		}
	} catch (err: unknown) {
		console.error((err as Error).message)
		process.exit(1)
	}
}

/** Exit with an error if --remote is passed, suggesting the equivalent wrangler command. */
export function rejectRemoteFlag(args: string[]): void {
	if (args.includes('--remote')) {
		const wranglerCmd = `wrangler ${args.join(' ')}`
		console.error(`Error: --remote is not supported by lopata. Lopata is a local-only runtime.\nDid you mean: ${wranglerCmd}`)
		process.exit(1)
	}
}

/**
 * Resolve a single binding from config when multiple bindings of the same type exist.
 * If there's exactly one, auto-select it. If multiple, require the flag.
 */
export function resolveBinding<T extends { binding?: string; bucket_name?: string; queue?: string }>(
	bindings: T[] | undefined,
	flagValue: string | undefined,
	typeName: string,
	matchField: keyof T = 'binding' as keyof T,
): T {
	if (!bindings || bindings.length === 0) {
		console.error(`No ${typeName} bindings configured.`)
		process.exit(1)
	}
	if (bindings.length === 1) return bindings[0]!
	if (!flagValue) {
		const names = bindings.map(b => String(b[matchField])).join(', ')
		console.error(`Multiple ${typeName} bindings found: ${names}. Use the appropriate flag to select one.`)
		process.exit(1)
	}
	const match = bindings.find(b => String(b[matchField]) === flagValue)
	if (!match) {
		const names = bindings.map(b => String(b[matchField])).join(', ')
		console.error(`${typeName} binding "${flagValue}" not found. Available: ${names}`)
		process.exit(1)
	}
	return match
}

export function createContext(configPath: string | undefined, envName: string | undefined): CliContext {
	const baseDir = process.cwd()

	let _config: WranglerConfig | null = null
	let _db: Database | null = null

	return {
		envName,
		config: async () => {
			if (_config) return _config
			_config = configPath
				? await loadConfig(resolve(baseDir, configPath), envName)
				: await autoLoadConfig(baseDir, envName)
			return _config
		},
		db: () => {
			if (_db) return _db
			const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
			const { mkdirSync } = require('node:fs') as typeof import('node:fs')
			const dataDir = join(baseDir, '.lopata')
			mkdirSync(dataDir, { recursive: true })
			mkdirSync(join(dataDir, 'r2'), { recursive: true })
			mkdirSync(join(dataDir, 'd1'), { recursive: true })
			const dbPath = join(dataDir, 'data.sqlite')
			_db = new Database(dbPath, { create: true })
			_db.run('PRAGMA journal_mode=WAL')
			// Run schema migrations
			const { runMigrations } = require('../db') as typeof import('../db')
			runMigrations(_db)
			return _db
		},
		dataDir: () => join(baseDir, '.lopata'),
	}
}
