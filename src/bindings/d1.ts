import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { inSavepoint, runStatements, splitStatements } from './sql-split'

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

/** A bound value as D1 carries it: a BLOB is an array of byte values. */
type D1Value = string | number | null | number[]

function isByte(value: unknown): value is number {
	return typeof value === 'number' && value >= 0 && value < 256
}

/** Validates and normalises a bind() argument like workerd's D1PreparedStatement.bind(). */
function toD1Value(value: unknown): D1Value {
	if (typeof value === 'number' || typeof value === 'string' || value === null) return value
	if (typeof value === 'boolean') return value ? 1 : 0
	if (Array.isArray(value) && value.every(isByte)) return value
	if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value))
	if (ArrayBuffer.isView(value)) return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
	const reason = `Type '${typeof value}' not supported for value '${String(value)}'`
	throw new Error(`D1_TYPE_ERROR: ${reason}`, { cause: new Error(reason) })
}

function toSqliteBinding(value: D1Value): SQLQueryBindings {
	return Array.isArray(value) ? new Uint8Array(value) : value
}

/** D1 returns a BLOB as an array of byte values, not as bytes. */
function fromSqliteValue(value: unknown): unknown {
	return value instanceof Uint8Array ? Array.from(value) : value
}

interface QueryOutput {
	columns: string[]
	rows: unknown[][]
	meta: D1Meta
}

interface ConnectionState {
	totalChanges: number
	lastRowId: number
	size: number
}

function connectionState(db: Database): ConnectionState {
	return db
		.query<ConnectionState, []>(
			'SELECT total_changes() AS totalChanges, last_insert_rowid() AS lastRowId, page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()',
		)
		.get()!
}

/** Runs `sql` the way a D1 query runs (workerd SqliteDatabase::prepareSql, MULTI mode), returning the rows of the last statement. */
function executeQuery(db: Database, sql: string, params: D1Value[]): QueryOutput {
	const start = performance.now()
	const before = connectionState(db)
	const { columns, rows, beforeLast } = runStatements(db, sql, (lastSql, ranLeading) => {
		const beforeLast = ranLeading ? connectionState(db) : before
		const stmt = db.query(lastSql)
		const rows = stmt.values(...params.map(toSqliteBinding)).map(row => row.map(fromSqliteValue))
		return { columns: stmt.columnNames, rows, beforeLast }
	})

	// Counted with total_changes(): changes() keeps the last write's count through later reads.
	const after = connectionState(db)
	const changes = after.totalChanges - before.totalChanges
	const lastChanges = after.totalChanges - beforeLast.totalChanges
	return {
		columns,
		rows,
		meta: {
			duration: performance.now() - start,
			changes,
			last_row_id: after.lastRowId,
			served_by: 'lopata-d1',
			// D1 reports libSQL's rows-scanned/written counters of the last statement, which bun:sqlite does not
			// expose. Approximated by counting each returned and each changed row once.
			rows_read: rows.length + lastChanges,
			rows_written: lastChanges,
			size_after: after.size,
			changed_db: changes !== 0 || after.lastRowId !== before.lastRowId || after.size !== before.size,
		},
	}
}

/** workerd's error for a failed query: `D1_ERROR: <reason>`, with the bare reason as `cause`. */
function d1Error(e: unknown): Error {
	const reason = e instanceof Error ? e.message : String(e)
	return new Error(`D1_ERROR: ${reason}`, { cause: new Error(reason) })
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
			try {
				db.run('COMMIT')
			} catch (e) {
				throw d1Error(e)
			}
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
			// Cloudflare sends each line as its own query, all in one request that runs as one transaction
			// (workerd d1-api.ts exec(), Miniflare's transactionSync), so a statement cannot span lines.
			const lines = sql.trim().split('\n')
			return inSavepoint(this.db, () => {
				let count = 0
				let duration = 0
				for (const [index, line] of lines.entries()) {
					// Blank and comment-only lines are skipped, as Miniflare does.
					if (splitStatements(line).length === 0) continue
					try {
						duration += executeQuery(this.db, line, []).meta.duration
					} catch (e) {
						const reason = `Error in line ${index + 1}: ${line}: ${e instanceof Error ? e.message : String(e)}`
						throw new Error(`D1_EXEC_ERROR: ${reason}`, { cause: new Error(reason) })
					}
					count++
				}
				return { count, duration }
			})
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
	private params: D1Value[]

	constructor(db: Database, sql: string) {
		this.db = db
		this.sql = sql
		this.params = []
	}

	bind(...values: unknown[]): LocalD1PreparedStatement {
		const stmt = new LocalD1PreparedStatement(this.db, this.sql)
		stmt.params = values.map(toD1Value)
		return stmt
	}

	async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
		const unlock = await acquireDbLock(this.db)
		try {
			const { columns, rows } = this.execute()
			const first = rows[0]
			if (!first) return null
			const row = rowToObject(columns, first)
			if (column !== undefined) {
				if (row[column] === undefined) {
					throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`, { cause: new Error('Column not found') })
				}
				return row[column] as T
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
		const { columns, rows, meta } = this.execute()
		return {
			results: rows.map(row => rowToObject(columns, row)) as T[],
			success: true,
			meta,
		}
	}

	async raw<T extends unknown[] = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
		const unlock = await acquireDbLock(this.db)
		try {
			const { columns, rows } = this.execute()
			if (options?.columnNames) {
				return [columns as unknown as T, ...(rows as T[])]
			}
			return rows as T[]
		} finally {
			unlock()
		}
	}

	private execute(): QueryOutput {
		try {
			return executeQuery(this.db, this.sql, this.params)
		} catch (e) {
			throw d1Error(e)
		}
	}
}

const D1_FILE_SUFFIX = '.sqlite'
const ENCODED_NAME_CHARS = /[%/\\]/g
const ENCODED_NAME_ESCAPES = /%(25|2F|5C)/g

/**
 * The SQLite file of a D1 database. Names may contain `/` (Cloudflare treats them as opaque), so `%`, `/` and
 * `\` are percent-encoded: every name maps to one file directly inside `d1/` and the dashboard can read it back.
 */
export function d1DatabasePath(dataDir: string, databaseName: string): string {
	const fileName = databaseName.replace(ENCODED_NAME_CHARS, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
	return join(dataDir, 'd1', `${fileName}${D1_FILE_SUFFIX}`)
}

/** The database name a file in `d1/` belongs to, or null for files that are not databases (WAL, SHM). */
export function d1DatabaseNameFromFile(fileName: string): string | null {
	if (!fileName.endsWith(D1_FILE_SUFFIX)) return null
	return fileName.slice(0, -D1_FILE_SUFFIX.length).replace(ENCODED_NAME_ESCAPES, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
}

export function openD1Database(dataDir: string, databaseName: string): LocalD1Database {
	mkdirSync(join(dataDir, 'd1'), { recursive: true })
	const db = new Database(d1DatabasePath(dataDir, databaseName), { create: true })
	db.run('PRAGMA journal_mode=WAL')
	// The in-process lock above only covers one connection. `openD1Database` is called separately
	// from env, worker threads, DO workers and the CLI, so several connections hit the same file;
	// without a timeout the loser of a write race fails instantly with `database is locked`.
	db.run('PRAGMA busy_timeout=5000')
	return new LocalD1Database(db)
}
