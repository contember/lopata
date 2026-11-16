import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { runMigrations } from '../src/db'

describe('runMigrations', () => {
	test('creates all tables on a fresh database', () => {
		const db = new Database(':memory:')
		runMigrations(db)

		const tables = db
			.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as { name: string }[]
		const names = tables.map((t) => t.name)

		expect(names).toContain('kv')
		expect(names).toContain('r2_objects')
		expect(names).toContain('do_storage')
		expect(names).toContain('do_alarms')
		expect(names).toContain('queue_messages')
		expect(names).toContain('workflow_instances')
		expect(names).toContain('cache_entries')
	})

	test('is idempotent — running twice does not throw', () => {
		const db = new Database(':memory:')
		runMigrations(db)
		runMigrations(db)

		const tables = db
			.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as { name: string }[]
		expect(tables.length).toBeGreaterThanOrEqual(7)
	})

	test('adds checksum_md5 to an existing r2_multipart_parts table and keeps its rows', () => {
		const db = new Database(':memory:')
		db.run(`CREATE TABLE r2_multipart_parts (
			upload_id TEXT NOT NULL, part_number INTEGER NOT NULL, etag TEXT NOT NULL, size INTEGER NOT NULL,
			file_path TEXT NOT NULL, PRIMARY KEY (upload_id, part_number))`)
		db.run(`INSERT INTO r2_multipart_parts VALUES ('u', 1, 'e', 1, 'p')`)
		runMigrations(db)

		const row = db.query<{ etag: string; checksum_md5: string | null }, []>('SELECT etag, checksum_md5 FROM r2_multipart_parts').get()
		expect(row).toEqual({ etag: 'e', checksum_md5: null })
	})

	test('can insert and read from kv table', () => {
		const db = new Database(':memory:')
		runMigrations(db)

		db.run(
			'INSERT INTO kv (namespace, key, value) VALUES (?, ?, ?)',
			['ns1', 'hello', Buffer.from('world')],
		)
		const row = db.query('SELECT * FROM kv WHERE namespace = ? AND key = ?').get('ns1', 'hello') as {
			namespace: string
			key: string
			value: Buffer
		}
		expect(row.namespace).toBe('ns1')
		expect(row.key).toBe('hello')
		expect(Buffer.from(row.value).toString()).toBe('world')
	})

	test('kv primary key enforces uniqueness', () => {
		const db = new Database(':memory:')
		runMigrations(db)

		db.run('INSERT INTO kv (namespace, key, value) VALUES (?, ?, ?)', ['ns1', 'k', Buffer.from('v1')])
		expect(() => {
			db.run('INSERT INTO kv (namespace, key, value) VALUES (?, ?, ?)', ['ns1', 'k', Buffer.from('v2')])
		}).toThrow()
	})
})
