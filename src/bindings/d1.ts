import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { mayHaveMultipleStatements, splitStatements } from './sql-split'

interface D1Meta {
	duration: number
	changes: number
	last_row_id: number
	served_by: string
	rows_read: number
	rows_written: number
	size_after: number
	changed_db: boolean
}

interface D1Result<T = Record<string, unknown>> {
	results: T[]
	success: boolean
	meta: D1Meta
}

interface D1ExecResult {
	count: number
	duration: number
}

function buildMeta(db: Database, durationMs: number, rowsRead: number, rowsWritten: number): D1Meta {
	const changes = db.query<{ c: number }, []>('SELECT changes() as c').get()!.c
	const { page_count } = db.query<{ page_count: number }, []>('PRAGMA page_count').get()!
	const { page_size } = db.query<{ page_size: number }, []>('PRAGMA page_size').get()!
	return {
		duration: durationMs,
		changes,
		last_row_id: db.query<{ id: number }, []>('SELECT last_insert_rowid() as id').get()!.id,
		served_by: 'lopata-d1',
		rows_read: rowsRead,
		rows_written: rowsWritten,
		size_after: page_count * page_size,
		changed_db: changes > 0,
	}
}

/** Convert bind parameters: boolean→int, undefined→error, ArrayBuffer→Uint8Array */
function convertBindParams(params: unknown[]): SQLQueryBindings[] {
	return params.map((v, idx) => {
		if (v === undefined) {
			throw new Error(`D1_TYPE_ERROR: Cannot bind undefined value at index ${idx}. Use null instead.`)
		}
		if (typeof v === 'boolean') {
			return v ? 1 : 0
		}
		if (v instanceof ArrayBuffer) {
			return new Uint8Array(v)
		}
		return v as SQLQueryBindings
	})
}

/** Check if a SQL statement is a read query (returns rows) */
function isReadStatement(sql: string): boolean {
	const upper = sql.trimStart().toUpperCase()
	return upper.startsWith('SELECT') || upper.startsWith('WITH') || upper.startsWith('PRAGMA')
}

interface QueryOutput {
	columns: string[]
	rows: unknown[][]
}

const MULTI_STATEMENT_PARAMS_ERROR = 'When executing multiple SQL statements in a single call, only the last statement can have parameters.'

/**
 * Runs `sql` the way a D1 query runs: every statement in it, all or nothing, returning the rows of the last
 * one (workerd SqliteDatabase::prepareSql, MULTI mode). bun:sqlite compiles only the first statement and
 * silently drops the rest, so the leading ones run here, each compiled after the previous one ran.
 */
function executeQuery(db: Database, sql: string, params: SQLQueryBindings[]): QueryOutput {
	const statements = mayHaveMultipleStatements(sql) ? splitStatements(sql) : []
	const last = statements.pop() ?? sql
	if (statements.length === 0) return executeStatement(db, last, params)

	db.run('SAVEPOINT lopata_d1_query')
	try {
		for (const leadingSql of statements) {
			const leading = db.prepare(leadingSql)
			try {
				if (leading.paramsCount > 0) throw new Error(MULTI_STATEMENT_PARAMS_ERROR)
				leading.run()
			} finally {
				leading.finalize()
			}
		}
		const output = executeStatement(db, last, params)
		db.run('RELEASE lopata_d1_query')
		return output
	} catch (e) {
		try {
			db.run('ROLLBACK TO lopata_d1_query')
			db.run('RELEASE lopata_d1_query')
		} catch {
			// ON CONFLICT ROLLBACK and similar failures already unwound the whole transaction, savepoint included.
		}
		throw e
	}
}

function executeStatement(db: Database, sql: string, params: SQLQueryBindings[]): QueryOutput {
	const stmt = db.query(sql)
	const rows = stmt.values(...params)
	return { columns: stmt.columnNames, rows }
}

function rowToObject(columns: string[], row: unknown[]): Record<string, unknown> {
	return Object.fromEntries(columns.map((name, i) => [name, row[i]]))
}

// --- statement serialisation ---

/**
 * One in-flight database operation per connection, queued rather than interleaved.
 *
 * `batch()` opens a real transaction and awaits inside it. Two overlapping calls on the same
 * connection therefore had the second issue `BEGIN` while the first was still open, and SQLite
 * refuses: `cannot start a transaction within a transaction`. Real D1 has no such problem — each
 * `batch()` is an independent request — so worker code that fires several concurrently (a
 * `Promise.all` over per-table writers, say) is correct against production and failed only here.
 *
 * Standalone statements take the same lock. Each is synchronous on its own, but a statement that
 * started while a batch held an open transaction would execute inside it and be discarded by that
 * batch's rollback — a lost write that had already reported success. The statements `batch()` runs
 * itself go through the `*Unlocked` variants, so holding the lock across a batch cannot deadlock
 * against its own members.
 *
 * Mirrors `acquireDbTxnLock` in the durable-object binding, which solved the same collision for DO
 * storage transactions.
 */
const dbLocks = new WeakMap<Database, Promise<void>>()

async function acquireDbLock(db: Database): Promise<() => void> {
	let unlock!: () => void
	const next = new Promise<void>((resolve) => {
		unlock = resolve
	})
	const ready = dbLocks.get(db) ?? Promise.resolve()
	dbLocks.set(db, next)
	await ready
	return unlock
}

async function runBatchSerially<T>(db: Database, statements: LocalD1PreparedStatement[]): Promise<D1Result<T>[]> {
	const unlock = await acquireDbLock(db)
	try {
		const results: D1Result<T>[] = []
		db.run('BEGIN')
		try {
			for (const stmt of statements) {
				// Awaits because the tracing proxy makes `allUnlocked` async; safe only because this
				// call holds the db lock, so nothing else can slip into the open transaction.
				results.push(await stmt.allUnlocked<T>())
			}
			db.run('COMMIT')
		} catch (e) {
			try {
				db.run('ROLLBACK')
			} catch {
				// SQLite auto-rolls-back on some failures (ON CONFLICT ROLLBACK, SQLITE_FULL,
				// SQLITE_IOERR, SQLITE_BUSY), leaving nothing to unwind. Swallowing that keeps the
				// original error — the one the developer needs to see — from being replaced by
				// `cannot rollback - no transaction is active`.
			}
			throw e
		}
		return results
	} finally {
		unlock()
	}
}

export class LocalD1Database {
	private db: Database

	constructor(db: Database) {
		this.db = db
	}

	prepare(sql: string): LocalD1PreparedStatement {
		return new LocalD1PreparedStatement(this.db, sql)
	}

	async batch<T = Record<string, unknown>>(statements: LocalD1PreparedStatement[]): Promise<D1Result<T>[]> {
		return await runBatchSerially(this.db, statements)
	}

	async exec(sql: string): Promise<D1ExecResult> {
		const unlock = await acquireDbLock(this.db)
		try {
			const start = performance.now()
			let count = 0
			const statements = splitStatements(sql)
			for (const stmt of statements) {
				try {
					this.db.run(stmt)
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e)
					throw new Error(`D1_EXEC_ERROR: Error in SQL statement [${stmt}]: ${msg}`)
				}
				count++
			}
			return { count, duration: performance.now() - start }
		} finally {
			unlock()
		}
	}

	async dump(): Promise<ArrayBuffer> {
		return this.db.serialize().buffer as ArrayBuffer
	}

	withSession(_bookmark?: string): LocalD1DatabaseSession {
		return new LocalD1DatabaseSession(this.db)
	}
}

export class LocalD1DatabaseSession {
	private db: Database

	constructor(db: Database) {
		this.db = db
	}

	prepare(sql: string): LocalD1PreparedStatement {
		return new LocalD1PreparedStatement(this.db, sql)
	}

	async batch<T = Record<string, unknown>>(statements: LocalD1PreparedStatement[]): Promise<D1Result<T>[]> {
		return await runBatchSerially(this.db, statements)
	}

	getBookmark(): string | null {
		return null
	}
}

export class LocalD1PreparedStatement {
	private db: Database
	private sql: string
	private params: SQLQueryBindings[]

	constructor(db: Database, sql: string) {
		this.db = db
		this.sql = sql
		this.params = []
	}

	bind(...values: unknown[]): LocalD1PreparedStatement {
		const stmt = new LocalD1PreparedStatement(this.db, this.sql)
		stmt.params = convertBindParams(values)
		return stmt
	}

	async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
		const unlock = await acquireDbLock(this.db)
		try {
			const { columns, rows } = executeQuery(this.db, this.sql, this.params)
			const first = rows[0]
			if (!first) return null
			const row = rowToObject(columns, first)
			if (column) {
				if (!(column in row)) {
					throw new Error(`D1_ERROR: Column '${column}' does not exist in the result set.`)
				}
				return (row[column] as T) ?? null
			}
			return row as T
		} finally {
			unlock()
		}
	}

	/** Cloudflare's run() returns the same D1Result as all(), rows included (SELECT, RETURNING). */
	async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		return this.all<T>()
	}

	async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		const unlock = await acquireDbLock(this.db)
		try {
			return this.allUnlocked<T>()
		} finally {
			unlock()
		}
	}

	/** @internal Skips the db lock — only for a caller that already holds it, such as `batch()`. */
	allUnlocked<T = Record<string, unknown>>(): D1Result<T> {
		const start = performance.now()
		const { columns, rows } = executeQuery(this.db, this.sql, this.params)
		const results = rows.map(row => rowToObject(columns, row)) as T[]
		const duration = performance.now() - start
		const isRead = isReadStatement(this.sql)
		const changes = this.db.query<{ c: number }, []>('SELECT changes() as c').get()!.c
		return {
			results,
			success: true,
			meta: buildMeta(this.db, duration, isRead ? results.length : 0, isRead ? 0 : changes),
		}
	}

	async raw<T extends unknown[] = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
		const unlock = await acquireDbLock(this.db)
		try {
			const { columns, rows } = executeQuery(this.db, this.sql, this.params)
			if (options?.columnNames) {
				return [columns as unknown as T, ...(rows as T[])]
			}
			return rows as T[]
		} finally {
			unlock()
		}
	}
}

export function openD1Database(dataDir: string, databaseName: string): LocalD1Database {
	const d1Dir = join(dataDir, 'd1')
	mkdirSync(d1Dir, { recursive: true })
	const dbPath = join(d1Dir, `${databaseName}.sqlite`)
	const db = new Database(dbPath, { create: true })
	db.run('PRAGMA journal_mode=WAL')
	// The in-process lock above only covers one connection. `openD1Database` is called separately
	// from env, worker threads, DO workers and the CLI, so several connections hit the same file;
	// without a timeout the loser of a write race fails instantly with `database is locked`.
	db.run('PRAGMA busy_timeout=5000')
	return new LocalD1Database(db)
}
