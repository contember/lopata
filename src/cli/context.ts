import type { Database } from 'bun:sqlite'
import { join, resolve } from 'node:path'
import type { WranglerConfig } from '../config'
import { autoLoadConfig, loadConfig } from '../config'

export interface CliContext {
	args: string[]
	config: () => Promise<WranglerConfig>
	db: () => Database
	dataDir: () => string
}

/** Parse a flag value from argv. Returns the value after the flag, or undefined. */
export function parseFlag(args: string[], name: string): string | undefined {
	const idx = args.indexOf(name)
	return idx !== -1 ? args[idx + 1] : undefined
}

/** Check if a boolean flag is present. */
export function hasFlag(args: string[], name: string): boolean {
	return args.includes(name)
}

/** Get positional args (everything that's not a flag or flag value). */
export function positionalArgs(args: string[], flags: string[]): string[] {
	const result: string[] = []
	for (let i = 0; i < args.length; i++) {
		if (flags.includes(args[i]!)) {
			i++ // skip flag value
			continue
		}
		if (args[i]!.startsWith('-')) continue
		result.push(args[i]!)
	}
	return result
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

export function createContext(argv: string[]): CliContext {
	// Strip "bun src/cli.ts" or similar prefix — find first non-file arg
	const args = argv.slice(2)

	const configPath = parseFlag(args, '--config') ?? parseFlag(args, '-c')
	const envName = parseFlag(args, '--env') ?? parseFlag(args, '-e')
	const baseDir = process.cwd()

	let _config: WranglerConfig | null = null
	let _db: Database | null = null

	return {
		args,
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
			const dataDir = join(baseDir, '.bunflare')
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
		dataDir: () => join(baseDir, '.bunflare'),
	}
}
