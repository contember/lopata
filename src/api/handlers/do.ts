import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getDatabase, getDataDir } from '../../db'
import { generateSqlFromPrompt } from '../generate-sql'
import type { D1Table, DoDetail, DoInstance, DoNamespace, HandlerContext, OkResponse, QueryResult } from '../types'
import { getAllConfigs, getDoNamespace } from '../types'

export const handlers = {
	'do.listNamespaces'(_input: {}, ctx: HandlerContext): DoNamespace[] {
		const db = getDatabase()
		const rows = db.query<{ namespace: string; count: number }, []>(
			'SELECT namespace, COUNT(*) as count FROM do_instances GROUP BY namespace ORDER BY namespace',
		).all()
		const rowMap = new Map(rows.map(r => [r.namespace, r]))
		for (const config of getAllConfigs(ctx)) {
			for (const b of config.durable_objects?.bindings ?? []) {
				if (!rowMap.has(b.class_name)) {
					rows.push({ namespace: b.class_name, count: 0 })
				}
			}
		}
		rows.sort((a, b) => a.namespace.localeCompare(b.namespace))
		return rows
	},

	'do.listInstances'({ ns }: { ns: string }): DoInstance[] {
		const db = getDatabase()
		const instances = db.query<{ id: string; name: string | null }, [string]>(
			'SELECT id, name FROM do_instances WHERE namespace = ? ORDER BY id',
		).all(ns)

		const kvCounts = db.query<{ id: string; key_count: number }, [string]>(
			'SELECT id, COUNT(*) as key_count FROM do_storage WHERE namespace = ? GROUP BY id',
		).all(ns)
		const kvMap = new Map(kvCounts.map(r => [r.id, r.key_count]))

		const alarms = db.query<{ id: string; alarm_time: number }, [string]>(
			'SELECT id, alarm_time FROM do_alarms WHERE namespace = ?',
		).all(ns)
		const alarmMap = new Map(alarms.map(a => [a.id, a.alarm_time]))

		return instances.map(inst => ({
			id: inst.id,
			name: inst.name,
			key_count: kvMap.get(inst.id) ?? 0,
			alarm: alarmMap.get(inst.id) ?? null,
		}))
	},

	'do.getInstance'({ ns, id }: { ns: string; id: string }, ctx: HandlerContext): DoDetail {
		const db = getDatabase()
		const entries = db.query<{ key: string; value: string }, [string, string]>(
			'SELECT key, value FROM do_storage WHERE namespace = ? AND id = ? ORDER BY key',
		).all(ns, id)

		const alarm = db.query<{ alarm_time: number }, [string, string]>(
			'SELECT alarm_time FROM do_alarms WHERE namespace = ? AND id = ?',
		).get(ns, id)

		const namespace = getDoNamespace(ctx, ns)
		return { entries, alarm: alarm?.alarm_time ?? null, hasAlarmHandler: namespace?.hasAlarmHandler() ?? false }
	},

	'do.deleteEntry'({ ns, id, key }: { ns: string; id: string; key: string }): OkResponse {
		const db = getDatabase()
		db.prepare('DELETE FROM do_storage WHERE namespace = ? AND id = ? AND key = ?').run(ns, id, key)
		return { ok: true }
	},

	'do.listSqlTables'({ ns, id }: { ns: string; id: string }): D1Table[] {
		const dbPath = join(getDataDir(), 'do-sql', ns, `${id}.sqlite`)
		if (!existsSync(dbPath)) return []

		const dodb = new Database(dbPath)
		try {
			const tables = dodb.query<{ name: string; sql: string }, []>(
				"SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			).all()

			return tables.map(t => {
				const row = dodb.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM "${t.name}"`).get()
				return { name: t.name, sql: t.sql, rows: row?.count ?? 0 }
			})
		} finally {
			dodb.close()
		}
	},

	async 'do.triggerAlarm'({ ns, id }: { ns: string; id: string }, ctx: HandlerContext): Promise<OkResponse> {
		const namespace = getDoNamespace(ctx, ns)
		if (!namespace) throw new Error(`Durable Object namespace "${ns}" not found (worker not loaded?)`)
		await namespace.triggerAlarm(id)
		return { ok: true }
	},

	async 'do.generateSql'({ ns, id, prompt }: { ns: string; id: string; prompt: string }, ctx: HandlerContext): Promise<{ sql: string }> {
		const dbPath = join(getDataDir(), 'do-sql', ns, `${id}.sqlite`)
		if (!existsSync(dbPath)) throw new Error('SQL database not found for this instance')
		const sql = await generateSqlFromPrompt(new Database(dbPath), prompt, ctx.lopataConfig)
		return { sql }
	},

	'do.sqlQuery'({ ns, id, sql }: { ns: string; id: string; sql: string }): QueryResult {
		if (!sql) throw new Error('Missing sql field')

		const dbPath = join(getDataDir(), 'do-sql', ns, `${id}.sqlite`)
		if (!existsSync(dbPath)) throw new Error('SQL database not found for this instance')

		const dodb = new Database(dbPath)
		try {
			const stmt = dodb.prepare(sql)
			if (stmt.columnNames.length > 0) {
				const rows = stmt.all() as Record<string, unknown>[]
				return { columns: stmt.columnNames, rows, count: rows.length }
			} else {
				stmt.run()
				const changes = dodb.query<{ c: number }, []>('SELECT changes() as c').get()?.c ?? 0
				return { columns: [], rows: [], count: changes, message: `${changes} row(s) affected` }
			}
		} finally {
			dodb.close()
		}
	},
}
