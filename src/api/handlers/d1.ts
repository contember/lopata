import { Database } from 'bun:sqlite'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { d1DatabaseNameFromFile, d1DatabasePath } from '../../bindings/d1'
import { runStatements } from '../../bindings/sql-split'
import { getDataDir } from '../../db'
import { generateSqlFromPrompt } from '../generate-sql'
import type { D1Database as D1DatabaseInfo, D1Table, HandlerContext, QueryResult } from '../types'
import { getAllConfigs } from '../types'

export const handlers = {
	'd1.listDatabases'(_input: {}, ctx: HandlerContext): D1DatabaseInfo[] {
		const d1Dir = join(getDataDir(), 'd1')
		const databases: D1DatabaseInfo[] = []
		const seen = new Set<string>()

		if (existsSync(d1Dir)) {
			for (const f of readdirSync(d1Dir)) {
				const name = d1DatabaseNameFromFile(f)
				if (name === null) continue
				seen.add(name)
				const d1db = new Database(join(d1Dir, f))
				try {
					const tables = d1db.query<{ name: string }, []>(
						"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
					).all()
					databases.push({ name, tables: tables.length })
				} finally {
					d1db.close()
				}
			}
		}

		for (const config of getAllConfigs(ctx)) {
			for (const d of config.d1_databases ?? []) {
				if (!seen.has(d.database_name)) {
					databases.push({ name: d.database_name, tables: 0 })
					seen.add(d.database_name)
				}
			}
		}

		databases.sort((a, b) => a.name.localeCompare(b.name))
		return databases
	},

	'd1.listTables'({ dbName }: { dbName: string }): D1Table[] {
		const dbPath = d1DatabasePath(getDataDir(), dbName)
		if (!existsSync(dbPath)) throw new Error('Database not found')

		const d1db = new Database(dbPath)
		try {
			const tables = d1db.query<{ name: string; sql: string }, []>(
				"SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			).all()

			return tables.map(t => {
				const row = d1db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM "${t.name}"`).get()
				return { name: t.name, sql: t.sql, rows: row?.count ?? 0 }
			})
		} finally {
			d1db.close()
		}
	},

	async 'd1.generateSql'({ dbName, prompt }: { dbName: string; prompt: string }, ctx: HandlerContext): Promise<{ sql: string }> {
		const dbPath = d1DatabasePath(getDataDir(), dbName)
		if (!existsSync(dbPath)) throw new Error('Database not found')
		const sql = await generateSqlFromPrompt(new Database(dbPath), prompt, ctx.lopataConfig)
		return { sql }
	},

	'd1.query'({ dbName, sql }: { dbName: string; sql: string }): QueryResult {
		if (!sql) throw new Error('Missing sql field')

		const dbPath = d1DatabasePath(getDataDir(), dbName)
		if (!existsSync(dbPath)) throw new Error('Database not found')

		const d1db = new Database(dbPath)
		try {
			return runConsoleQuery(d1db, sql)
		} finally {
			d1db.close()
		}
	},
}

/** Runs every statement of a console query, as a D1 query does, and shows the result of the last one. */
export function runConsoleQuery(db: Database, sql: string): QueryResult {
	return runStatements(db, sql, lastSql => {
		const stmt = db.prepare<Record<string, unknown>, []>(lastSql)
		if (stmt.columnNames.length > 0) {
			const rows = stmt.all()
			return { columns: stmt.columnNames, rows, count: rows.length }
		}
		stmt.run()
		const changes = db.query<{ c: number }, []>('SELECT changes() as c').get()?.c ?? 0
		return { columns: [], rows: [], count: changes, message: `${changes} row(s) affected` }
	})
}
