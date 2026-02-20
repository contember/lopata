import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openD1Database } from '../bindings/d1'
import type { CliContext } from './context'
import { parseFlag, resolveBinding } from './context'

export async function run(ctx: CliContext, args: string[]) {
	const action = args[0]

	switch (action) {
		case 'list': {
			const config = await ctx.config()
			const databases = config.d1_databases ?? []
			if (databases.length === 0) {
				console.log('No D1 databases configured.')
				return
			}
			for (const db of databases) {
				console.log(`${db.binding}  ${db.database_name}  ${db.database_id}`)
			}
			break
		}
		case 'execute': {
			const dbName = args[1]
			if (!dbName) {
				console.error("Usage: lopata d1 execute <database> --command 'SQL' | --file <path>")
				process.exit(1)
			}
			const config = await ctx.config()
			const databases = config.d1_databases ?? []
			const dbConfig = databases.find(
				d => d.binding === dbName || d.database_name === dbName,
			)
			if (!dbConfig) {
				const names = databases.map(d => `${d.binding}/${d.database_name}`).join(', ')
				console.error(`Database "${dbName}" not found. Available: ${names || '(none)'}`)
				process.exit(1)
			}

			const command = parseFlag(ctx.args, '--command')
			const filePath = parseFlag(ctx.args, '--file')
			if (!command && !filePath) {
				console.error("Usage: lopata d1 execute <database> --command 'SQL' | --file <path>")
				process.exit(1)
			}

			const sql = command ?? readFileSync(resolve(filePath!), 'utf-8')
			const d1 = openD1Database(ctx.dataDir(), dbConfig.database_name)
			const result = await d1.exec(sql)
			console.log(`Executed ${result.count} statement(s) in ${result.duration.toFixed(1)}ms`)
			break
		}
		case 'migrations': {
			const subAction = args[1]
			if (subAction !== 'apply') {
				console.error('Usage: lopata d1 migrations apply [database]')
				process.exit(1)
			}
			const targetDb = args[2]
			const config = await ctx.config()
			await applyMigrations(config.d1_databases ?? [], ctx.dataDir(), targetDb)
			break
		}
		default:
			console.error(`Usage: lopata d1 <list|execute|migrations> [options]`)
			process.exit(1)
	}
}

/**
 * Apply D1 migrations. Extracted from src/d1-migrate.ts for CLI reuse.
 */
export async function applyMigrations(
	databases: { binding: string; database_name: string; database_id: string; migrations_dir?: string }[],
	dataDir: string,
	targetDb?: string,
): Promise<number> {
	const filtered = targetDb
		? databases.filter(d => d.binding === targetDb || d.database_name === targetDb)
		: databases

	if (filtered.length === 0) {
		if (targetDb) {
			console.error(`Database "${targetDb}" not found.`)
			process.exit(1)
		}
		console.log('No D1 databases configured.')
		return 0
	}

	const d1Dir = join(dataDir, 'd1')
	mkdirSync(d1Dir, { recursive: true })
	const baseDir = process.cwd()
	let totalApplied = 0

	for (const dbConfig of filtered) {
		const { database_name, binding, migrations_dir } = dbConfig

		if (!migrations_dir) {
			console.log(`${binding} (${database_name}): no migrations_dir, skipping`)
			continue
		}

		const migrationsPath = resolve(baseDir, migrations_dir)
		if (!existsSync(migrationsPath)) {
			console.log(`${binding} (${database_name}): migrations_dir not found: ${migrationsPath}`)
			continue
		}

		const dbPath = join(d1Dir, `${database_name}.sqlite`)
		const db = new Database(dbPath, { create: true })
		db.run('PRAGMA journal_mode=WAL')

		db.run(`
			CREATE TABLE IF NOT EXISTS d1_migrations (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL UNIQUE,
				applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
			)
		`)

		const applied = new Set(
			db.query<{ name: string }, []>('SELECT name FROM d1_migrations ORDER BY id').all().map(r => r.name),
		)

		const files = readdirSync(migrationsPath)
			.filter(f => f.endsWith('.sql'))
			.sort()

		const pending = files.filter(f => !applied.has(f))

		if (pending.length === 0) {
			console.log(`${binding} (${database_name}): up to date (${applied.size} migrations)`)
			db.close()
			continue
		}

		console.log(`${binding} (${database_name}): applying ${pending.length} migration(s)...`)

		for (const file of pending) {
			const sql = readFileSync(join(migrationsPath, file), 'utf-8')
			try {
				db.run('BEGIN')
				db.run(sql)
				db.run('INSERT INTO d1_migrations (name) VALUES (?)', [file])
				db.run('COMMIT')
				console.log(`  + ${file}`)
				totalApplied++
			} catch (err) {
				db.run('ROLLBACK')
				console.error(`  x ${file}: ${err}`)
				db.close()
				process.exit(1)
			}
		}

		db.close()
	}

	console.log(`Done. Applied ${totalApplied} migration(s).`)
	return totalApplied
}
