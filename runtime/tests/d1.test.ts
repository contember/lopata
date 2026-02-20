import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { LocalD1Database, LocalD1DatabaseSession, LocalD1PreparedStatement } from '../bindings/d1'

let db: Database
let d1: LocalD1Database

beforeEach(() => {
	db = new Database(':memory:')
	d1 = new LocalD1Database(db)
	// Create a test table
	db.run('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT)')
})

describe('D1Database', () => {
	describe('prepare + run', () => {
		test('insert and return meta with changes', async () => {
			const result = await d1.prepare('INSERT INTO users (name, email) VALUES (?, ?)').bind('Alice', 'alice@example.com').run()
			expect(result.success).toBe(true)
			expect(result.meta.changes).toBe(1)
			expect(result.meta.last_row_id).toBe(1)
			expect(result.meta.served_by).toBe('bunflare-d1')
			expect(result.meta.duration).toBeGreaterThanOrEqual(0)
		})

		test('update returns correct changes count', async () => {
			await d1.prepare('INSERT INTO users (name) VALUES (?)').bind('Alice').run()
			await d1.prepare('INSERT INTO users (name) VALUES (?)').bind('Bob').run()
			const result = await d1.prepare('UPDATE users SET email = ?').bind('test@test.com').run()
			expect(result.meta.changes).toBe(2)
		})
	})

	describe('prepare + first', () => {
		test('returns first row as object', async () => {
			await d1.prepare('INSERT INTO users (name, email) VALUES (?, ?)').bind('Alice', 'alice@example.com').run()
			const row = await d1.prepare('SELECT * FROM users WHERE name = ?').bind('Alice').first<{ id: number; name: string; email: string }>()
			expect(row).not.toBeNull()
			expect(row!.name).toBe('Alice')
			expect(row!.email).toBe('alice@example.com')
		})

		test('returns single column value', async () => {
			await d1.prepare('INSERT INTO users (name, email) VALUES (?, ?)').bind('Alice', 'alice@example.com').run()
			const name = await d1.prepare('SELECT * FROM users WHERE id = ?').bind(1).first<string>('name')
			expect(name).toBe('Alice')
		})

		test('returns null for no results', async () => {
			const row = await d1.prepare('SELECT * FROM users WHERE id = ?').bind(999).first()
			expect(row).toBeNull()
		})

		test('returns null for missing column on empty result', async () => {
			const val = await d1.prepare('SELECT * FROM users WHERE id = ?').bind(999).first('name')
			expect(val).toBeNull()
		})

		test('throws D1_ERROR for non-existent column when row exists', async () => {
			await d1.prepare('INSERT INTO users (name, email) VALUES (?, ?)').bind('Alice', 'alice@example.com').run()
			await expect(
				d1.prepare('SELECT * FROM users WHERE id = ?').bind(1).first('nonexistent'),
			).rejects.toThrow('D1_ERROR')
		})
	})

	describe('prepare + all', () => {
		test('returns all rows', async () => {
			await d1.prepare('INSERT INTO users (name) VALUES (?)').bind('Alice').run()
			await d1.prepare('INSERT INTO users (name) VALUES (?)').bind('Bob').run()
			await d1.prepare('INSERT INTO users (name) VALUES (?)').bind('Charlie').run()

			const result = await d1.prepare('SELECT * FROM users ORDER BY name').all<{ id: number; name: string }>()
			expect(result.success).toBe(true)
			expect(result.results).toHaveLength(3)
			expect(result.results[0]!.name).toBe('Alice')
			expect(result.results[2]!.name).toBe('Charlie')
		})

		test('returns empty results for no matches', async () => {
			const result = await d1.prepare('SELECT * FROM users WHERE name = ?').bind('Nobody').all()
			expect(result.success).toBe(true)
			expect(result.results).toHaveLength(0)
		})
	})

	describe('prepare + raw', () => {
		test('returns rows as arrays', async () => {
			await d1.prepare('INSERT INTO users (name, email) VALUES (?, ?)').bind('Alice', 'alice@example.com').run()
			const rows = await d1.prepare('SELECT id, name, email FROM users').raw()
			expect(rows).toHaveLength(1)
			expect(rows[0]).toEqual([1, 'Alice', 'alice@example.com'])
		})

		test('returns column names as first element with columnNames option', async () => {
			await d1.prepare('INSERT INTO users (name, email) VALUES (?, ?)').bind('Alice', 'alice@example.com').run()
			const rows = await d1.prepare('SELECT id, name, email FROM users').raw({ columnNames: true })
			expect(rows).toHaveLength(2)
			expect(rows[0]).toEqual(['id', 'name', 'email'])
			expect(rows[1]).toEqual([1, 'Alice', 'alice@example.com'])
		})
	})

	describe('batch', () => {
		test('executes multiple statements in a transaction', async () => {
			const results = await d1.batch([
				d1.prepare('INSERT INTO users (name) VALUES (?)').bind('Alice'),
				d1.prepare('INSERT INTO users (name) VALUES (?)').bind('Bob'),
				d1.prepare('SELECT * FROM users ORDER BY name'),
			])
			expect(results).toHaveLength(3)
			expect(results[2]!.results).toHaveLength(2)
			expect((results[2]!.results[0] as { name: string }).name).toBe('Alice')
		})

		test('rolls back on error', async () => {
			try {
				await d1.batch([
					d1.prepare('INSERT INTO users (name) VALUES (?)').bind('Alice'),
					d1.prepare('INSERT INTO nonexistent_table (x) VALUES (?)').bind('fail'),
				])
			} catch {
				// expected
			}
			const result = await d1.prepare('SELECT * FROM users').all()
			expect(result.results).toHaveLength(0)
		})
	})

	describe('exec', () => {
		test('executes multiple SQL statements', async () => {
			const result = await d1.exec(`
        INSERT INTO users (name) VALUES ('Alice');
        INSERT INTO users (name) VALUES ('Bob');
        INSERT INTO users (name) VALUES ('Charlie');
      `)
			expect(result.count).toBe(3)
			expect(result.duration).toBeGreaterThanOrEqual(0)

			const all = await d1.prepare('SELECT * FROM users').all()
			expect(all.results).toHaveLength(3)
		})

		test('can create tables and insert data', async () => {
			await d1.exec('CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT)')
			await d1.exec("INSERT INTO posts (title) VALUES ('Hello')")
			const result = await d1.prepare('SELECT * FROM posts').all<{ title: string }>()
			expect(result.results[0]!.title).toBe('Hello')
		})

		test('handles semicolons inside string literals', async () => {
			await d1.exec("INSERT INTO users (name) VALUES ('semi;colon')")
			const result = await d1.prepare('SELECT name FROM users').first<{ name: string }>()
			expect(result!.name).toBe('semi;colon')
		})

		test('handles line comments with semicolons', async () => {
			const result = await d1.exec(`
        INSERT INTO users (name) VALUES ('Alice'); -- this is a comment with ;
        INSERT INTO users (name) VALUES ('Bob');
      `)
			expect(result.count).toBe(2)
			const all = await d1.prepare('SELECT * FROM users ORDER BY name').all()
			expect(all.results).toHaveLength(2)
		})

		test('handles block comments with semicolons', async () => {
			const result = await d1.exec(`
        INSERT INTO users (name) VALUES ('Alice'); /* comment with ; inside */
        INSERT INTO users (name) VALUES ('Bob');
      `)
			expect(result.count).toBe(2)
			const all = await d1.prepare('SELECT * FROM users ORDER BY name').all()
			expect(all.results).toHaveLength(2)
		})

		test('handles escaped quotes in strings', async () => {
			await d1.exec("INSERT INTO users (name) VALUES ('it''s; ok')")
			const result = await d1.prepare('SELECT name FROM users').first<{ name: string }>()
			expect(result!.name).toBe("it's; ok")
		})

		test('error includes the failing SQL statement', async () => {
			await expect(
				d1.exec("INSERT INTO nonexistent_table (x) VALUES ('fail')"),
			).rejects.toThrow(/D1_EXEC_ERROR.*nonexistent_table/)
		})
	})

	describe('withSession', () => {
		test('returns a D1DatabaseSession instance', () => {
			const session = d1.withSession('some-bookmark')
			expect(session).toBeInstanceOf(LocalD1DatabaseSession)
		})

		test('returns a D1DatabaseSession without bookmark', () => {
			const session = d1.withSession()
			expect(session).toBeInstanceOf(LocalD1DatabaseSession)
		})

		test('session has prepare and batch but not exec/dump/withSession', () => {
			const session = d1.withSession()
			expect(typeof session.prepare).toBe('function')
			expect(typeof session.batch).toBe('function')
			expect(typeof session.getBookmark).toBe('function')
			expect('exec' in session).toBe(false)
			expect('dump' in session).toBe(false)
			expect('withSession' in session).toBe(false)
		})

		test('session.getBookmark() returns null', () => {
			const session = d1.withSession()
			expect(session.getBookmark()).toBeNull()
		})

		test('session.prepare works for queries', async () => {
			await d1.prepare('INSERT INTO users (name) VALUES (?)').bind('Alice').run()
			const session = d1.withSession()
			const row = await session.prepare('SELECT * FROM users WHERE name = ?').bind('Alice').first<{ name: string }>()
			expect(row!.name).toBe('Alice')
		})

		test('session.batch works', async () => {
			const session = d1.withSession()
			const results = await session.batch([
				session.prepare('INSERT INTO users (name) VALUES (?)').bind('Alice'),
				session.prepare('SELECT * FROM users'),
			])
			expect(results).toHaveLength(2)
			expect(results[1]!.results).toHaveLength(1)
		})
	})

	describe('bind', () => {
		test('bind returns a new statement (immutable)', async () => {
			const stmt = d1.prepare('INSERT INTO users (name) VALUES (?)')
			const bound1 = stmt.bind('Alice')
			const bound2 = stmt.bind('Bob')

			await bound1.run()
			await bound2.run()

			const result = await d1.prepare('SELECT * FROM users ORDER BY name').all<{ name: string }>()
			expect(result.results).toHaveLength(2)
			expect(result.results[0]!.name).toBe('Alice')
			expect(result.results[1]!.name).toBe('Bob')
		})
	})

	describe('dump', () => {
		test('returns an ArrayBuffer of the database', async () => {
			await d1.prepare('INSERT INTO users (name) VALUES (?)').bind('Alice').run()
			const buffer = await d1.dump()
			expect(buffer).toBeInstanceOf(ArrayBuffer)
			expect(buffer.byteLength).toBeGreaterThan(0)

			// Verify it's a valid SQLite database by checking magic bytes
			const view = new Uint8Array(buffer)
			const magic = new TextDecoder().decode(view.slice(0, 15))
			expect(magic).toBe('SQLite format 3')
		})
	})

	describe('type conversion', () => {
		test('undefined as bind parameter throws D1_TYPE_ERROR', async () => {
			expect(() => {
				d1.prepare('INSERT INTO users (name) VALUES (?)').bind(undefined)
			}).toThrow('D1_TYPE_ERROR')
		})

		test('boolean true is converted to 1', async () => {
			db.run('CREATE TABLE flags (id INTEGER PRIMARY KEY, active INTEGER)')
			await d1.prepare('INSERT INTO flags (active) VALUES (?)').bind(true).run()
			const row = await d1.prepare('SELECT active FROM flags').first<{ active: number }>()
			expect(row!.active).toBe(1)
		})

		test('boolean false is converted to 0', async () => {
			db.run('CREATE TABLE flags (id INTEGER PRIMARY KEY, active INTEGER)')
			await d1.prepare('INSERT INTO flags (active) VALUES (?)').bind(false).run()
			const row = await d1.prepare('SELECT active FROM flags').first<{ active: number }>()
			expect(row!.active).toBe(0)
		})

		test('ArrayBuffer is stored as BLOB', async () => {
			db.run('CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB)')
			const data = new Uint8Array([1, 2, 3, 4]).buffer
			await d1.prepare('INSERT INTO blobs (data) VALUES (?)').bind(data).run()
			const row = await d1.prepare('SELECT data FROM blobs').first<{ data: Uint8Array }>()
			expect(row!.data).toBeInstanceOf(Uint8Array)
			expect(Array.from(row!.data)).toEqual([1, 2, 3, 4])
		})
	})

	describe('meta accuracy', () => {
		test('rows_written reflects changes for INSERT', async () => {
			const result = await d1.prepare('INSERT INTO users (name) VALUES (?)').bind('Alice').run()
			expect(result.meta.rows_written).toBe(1)
			expect(result.meta.rows_read).toBe(0)
		})

		test('rows_read reflects rows returned by SELECT', async () => {
			await d1.prepare('INSERT INTO users (name) VALUES (?)').bind('Alice').run()
			await d1.prepare('INSERT INTO users (name) VALUES (?)').bind('Bob').run()
			const result = await d1.prepare('SELECT * FROM users').all()
			expect(result.meta.rows_read).toBe(2)
			expect(result.meta.rows_written).toBe(0)
		})

		test('rows_written reflects changes for UPDATE via all()', async () => {
			await d1.prepare('INSERT INTO users (name) VALUES (?)').bind('Alice').run()
			await d1.prepare('INSERT INTO users (name) VALUES (?)').bind('Bob').run()
			const result = await d1.prepare("UPDATE users SET email = 'test@test.com'").all()
			expect(result.meta.rows_written).toBe(2)
			expect(result.meta.rows_read).toBe(0)
		})

		test('size_after is a positive number', async () => {
			const result = await d1.prepare('INSERT INTO users (name) VALUES (?)').bind('Alice').run()
			expect(result.meta.size_after).toBeGreaterThan(0)
		})

		test('changed_db is true after write', async () => {
			const result = await d1.prepare('INSERT INTO users (name) VALUES (?)').bind('Alice').run()
			expect(result.meta.changed_db).toBe(true)
		})

		test('changed_db is false after read', async () => {
			const result = await d1.prepare('SELECT * FROM users').all()
			expect(result.meta.changed_db).toBe(false)
		})
	})

	describe('persistence', () => {
		test('data persists across LocalD1Database instances sharing same Database', async () => {
			await d1.prepare('INSERT INTO users (name) VALUES (?)').bind('Alice').run()

			// Create a new D1 instance on the same underlying database
			const d1b = new LocalD1Database(db)
			const result = await d1b.prepare('SELECT * FROM users').all<{ name: string }>()
			expect(result.results).toHaveLength(1)
			expect(result.results[0]!.name).toBe('Alice')
		})
	})
})
