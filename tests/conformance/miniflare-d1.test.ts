// Adapted from workers-sdk packages/miniflare/test/plugins/d1/suite.ts and index.spec.ts at 6ee18e1bd
// (MIT OR Apache-2.0, Cloudflare, Inc.)

// Excluded:
// - 'operations persist D1 data': Miniflare `d1Persist` option and its `miniflare-D1DatabaseObject` storage layout
// - 'dumpSql exports and imports complete database structure and content correctly': Miniflare-internal `PRAGMA miniflare_d1_export`
// - 'migrates database to new location' (index.spec.ts): Miniflare legacy persistence-path migration
// index.with-wrangler-shim.spec.ts re-runs this suite through the legacy wrangler D1 shim and is not ported.

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect } from 'bun:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalD1Database, openD1Database } from '../../src/bindings/d1'
import { conformanceTest, loadKnownFailures } from './harness'

const known = loadKnownFailures('miniflare-d1')

const SCHEMA = (
	tableColours: string,
	tableKitchenSink: string,
	tablePalettes: string,
) => `
CREATE TABLE ${tableColours} (id INTEGER PRIMARY KEY, name TEXT NOT NULL, rgb INTEGER NOT NULL);
CREATE TABLE ${tableKitchenSink} (id INTEGER PRIMARY KEY, int INTEGER, real REAL, text TEXT, blob BLOB);
CREATE TABLE ${tablePalettes} (id INTEGER PRIMARY KEY, name TEXT NOT NULL, colour_id INTEGER NOT NULL, FOREIGN KEY (colour_id) REFERENCES ${tableColours}(id));
INSERT INTO ${tableColours} (id, name, rgb) VALUES (1, 'red', 0xff0000);
INSERT INTO ${tableColours} (id, name, rgb) VALUES (2, 'green', 0x00ff00);
INSERT INTO ${tableColours} (id, name, rgb) VALUES (3, 'blue', 0x0000ff);
INSERT INTO ${tablePalettes} (id, name, colour_id) VALUES (1, 'Night', 3);
`

// The original's literal 3.141; written as a quotient (same double) because Biome flags it as an approximation of PI.
const REAL = 3141 / 1000

interface ColourRow {
	id: number
	name: string
	rgb: number
}

interface KitchenSinkRow {
	id: number
	int: number | null
	real: number | null
	text: string | null
	blob: number[] | null
}

interface Context {
	db: LocalD1Database
	tableColours: string
	tableKitchenSink: string
	tablePalettes: string
}

let ctx: Context
let tmpDirs: string[] = []

function useTmp(): string {
	const dir = mkdtempSync(join(tmpdir(), 'lopata-conformance-d1-'))
	tmpDirs.push(dir)
	return dir
}

function utf8Encode(value: string): Uint8Array {
	return new TextEncoder().encode(value)
}

beforeEach(async () => {
	// Fixed suffix (the original randomises it): each test gets a fresh in-memory database, and stable names keep known-failure reasons stable.
	const ns = 'ns'
	const tableColours = `colours_${ns}`
	const tableKitchenSink = `kitchen_sink_${ns}`
	const tablePalettes = `palettes_${ns}`

	// A D1 database is a plain user SQLite file, so no lopata migrations run on it.
	const db = new LocalD1Database(new Database(':memory:'))

	await db.exec(SCHEMA(tableColours, tableKitchenSink, tablePalettes))

	ctx = { db, tableColours, tableKitchenSink, tablePalettes }
})

afterEach(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
	tmpDirs = []
})

// Kept as upstream: workerd's message is `D1_ERROR: <reason>`, so the strictEqual fails and the AssertionError text
// (which quotes the actual message) is what satisfies the callers' `toThrow` regex — in workerd and here alike.
function throwCause<T>(promise: Promise<T>): Promise<T> {
	return promise.catch((error: unknown) => {
		assert(error instanceof Error)
		assert.strictEqual(error.message, 'D1_ERROR')
		assert.notStrictEqual(error.cause, undefined)
		throw error.cause
	})
}

describe('d1', () => {
	conformanceTest(known, 'D1Database: batch', async () => {
		const { db, tableColours } = ctx

		const insert = db.prepare(
			`INSERT INTO ${tableColours} (id, name, rgb) VALUES (?, ?, ?)`,
		)
		const batchResults = await db.batch<Pick<ColourRow, 'name'>>([
			insert.bind(4, 'yellow', 0xffff00),
			db.prepare(`SELECT name FROM ${tableColours}`),
		])
		expect(batchResults.length).toBe(2)
		expect(batchResults[0]!.success).toBe(true)
		expect(batchResults[0]!.results).toEqual([])
		expect(batchResults[1]!.success).toBe(true)
		const expectedResults = [
			{ name: 'red' },
			{ name: 'green' },
			{ name: 'blue' },
			{ name: 'yellow' },
		]
		expect(batchResults[1]!.results).toEqual(expectedResults)

		// Check error mid-batch rolls-back entire batch
		const badInsert = db.prepare(
			`PUT IN ${tableColours} (id, name, rgb) VALUES (?, ?, ?)`,
		)
		await expect(
			throwCause(
				db.batch([
					insert.bind(5, 'purple', 0xff00ff),
					badInsert.bind(6, 'blurple', 0x5865f2),
					insert.bind(7, 'cyan', 0x00ffff),
				]),
			),
		).rejects.toThrow(/syntax error/)
		const result = await db
			.prepare(`SELECT name FROM ${tableColours}`)
			.all<Pick<ColourRow, 'name'>>()
		expect(result.results).toEqual(expectedResults)
	})

	conformanceTest(known, 'D1Database: exec', async () => {
		const { db, tableColours } = ctx

		// Check with single statement
		let execResult = await db.exec(
			`UPDATE ${tableColours} SET name = 'Red' WHERE name = 'red'`,
		)
		expect(execResult.count).toBe(1)
		expect(execResult.duration >= 0).toBe(true)
		let result = await db
			.prepare(`SELECT name FROM ${tableColours} WHERE name = 'Red'`)
			.all<Pick<ColourRow, 'name'>>()
		expect(result.results).toEqual([{ name: 'Red' }])

		// Check with multiple statements
		const statements = [
			`UPDATE ${tableColours} SET name = 'Green' WHERE name = 'green'`,
			`UPDATE ${tableColours} SET name = 'Blue' WHERE name = 'blue'`,
		].join('\n')
		execResult = await db.exec(statements)
		expect(execResult.count).toBe(2)
		expect(execResult.duration >= 0).toBe(true)
		result = await db.prepare(`SELECT name FROM ${tableColours}`).all()
		expect(result.results).toEqual([
			{ name: 'Red' },
			{ name: 'Green' },
			{ name: 'Blue' },
		])
	})

	conformanceTest(known, 'D1PreparedStatement: bind', async () => {
		const { db, tableColours, tableKitchenSink } = ctx

		// Check with all parameter types
		const blob = utf8Encode('Walshy')
		const blobArray = Array.from(blob)
		await db
			.prepare(
				`INSERT INTO ${tableKitchenSink} (id, int, real, text, blob) VALUES (?, ?, ?, ?, ?)`,
			)
			// Preserve `Uint8Array` type through JSON serialisation
			.bind(1, 42, REAL, '🙈', blobArray)
			.run()
		let result = await db
			.prepare(`SELECT * FROM ${tableKitchenSink}`)
			.all<KitchenSinkRow>()
		expect(result.results).toEqual([
			{ id: 1, int: 42, real: REAL, text: '🙈', blob: blobArray },
		])

		// Check with null values
		await db.prepare(`UPDATE ${tableKitchenSink} SET blob = ?`).bind(null).run()
		result = await db.prepare(`SELECT * FROM ${tableKitchenSink}`).all()
		expect(result.results).toEqual([
			{ id: 1, int: 42, real: REAL, text: '🙈', blob: null },
		])

		// Check with multiple statements
		const colourResultsPromise = db
			.prepare(
				`SELECT * FROM ${tableColours} WHERE name = ?; SELECT * FROM ${tableColours} WHERE id = ?;`,
			)
			.bind('green')
			.all<ColourRow>()

		// workerd changed the error message here. Miniflare's tests should pass with either version of workerd
		await expect(colourResultsPromise).rejects.toThrow(
			/A prepared SQL statement must contain only one statement|When executing multiple SQL statements in a single call, only the last statement can have parameters./,
		)

		// Check with numbered parameters (execute and query)
		// https://github.com/cloudflare/miniflare/issues/504
		await db
			.prepare(`INSERT INTO ${tableColours} (id, name, rgb) VALUES (?3, ?1, ?2)`)
			.bind('yellow', 0xffff00, 4)
			.run()
		const colourResult = await db
			.prepare(`SELECT * FROM ${tableColours} WHERE id = ?1`)
			.bind(4)
			.first<ColourRow>()
		expect(colourResult).toEqual({ id: 4, name: 'yellow', rgb: 0xffff00 })
	})

	// Lots of strange edge cases here...

	conformanceTest(known, 'D1PreparedStatement: first', async () => {
		const { db, tableColours } = ctx

		// Check with read statement
		const select = await db.prepare(`SELECT * FROM ${tableColours}`)
		let result: ColourRow | null = await select.first<ColourRow>()
		expect(result).toEqual({ id: 1, name: 'red', rgb: 0xff0000 })
		let id: number | null = await select.first<number>('id')
		expect(id).toBe(1)

		// Check with multiple statements
		const resultPromise = db
			.prepare(
				`SELECT * FROM ${tableColours} WHERE name = 'none'; SELECT * FROM ${tableColours} WHERE id = 1;`,
			)
			.first()

		// workerd changed its behaviour from throwing to returning the last result. Miniflare's tests should pass with either version of workerd
		try {
			const d1Result = await resultPromise
			expect(d1Result).toEqual({
				id: 1,
				name: 'red',
				rgb: 16711680,
			})
		} catch (e) {
			expect(e).toBeInstanceOf(Error)
			expect(
				/A prepared SQL statement must contain only one statement/.test(
					e instanceof Error ? e.message : String(e),
				),
			).toBeTruthy()
		}

		// Check with write statement (should actually execute statement)
		result = await db
			.prepare(`INSERT INTO ${tableColours} (id, name, rgb) VALUES (?, ?, ?)`)
			.bind(4, 'yellow', 0xffff00)
			.first()
		expect(result).toBe(null)
		id = await db
			.prepare(`SELECT id FROM ${tableColours} WHERE name = ?`)
			.bind('yellow')
			.first('id')
		expect(id).toBe(4)
	})

	conformanceTest(known, 'D1PreparedStatement: run', async () => {
		const { db, tableColours, tableKitchenSink } = ctx

		// Check with read statement
		let result = await db.prepare(`SELECT * FROM ${tableColours}`).run()
		expect(result.meta.duration >= 0).toBe(true)
		expect(result).toEqual({
			success: true,
			results: [
				{ id: 1, name: 'red', rgb: 16711680 },
				{ id: 2, name: 'green', rgb: 65280 },
				{ id: 3, name: 'blue', rgb: 255 },
			],
			meta: {
				changed_db: false,
				changes: 0,
				// Don't know duration, so just match on returned value asserted > 0
				duration: result.meta.duration,
				// Not an `INSERT`, so `last_row_id` non-deterministic
				last_row_id: result.meta.last_row_id,
				// Upstream expects Miniflare's backend name 'miniflare.db'; Cloudflare does not promise a value
				served_by: result.meta.served_by,
				size_after: result.meta.size_after,
				rows_read: 3,
				rows_written: 0,
			},
		})

		// Check with read/write statement
		result = await db
			.prepare(
				`INSERT INTO ${tableColours} (id, name, rgb) VALUES (?, ?, ?) RETURNING *`,
			)
			.bind(4, 'yellow', 0xffff00)
			.run()
		expect(result.meta.duration >= 0).toBe(true)
		expect(result).toEqual({
			results: [{ id: 4, name: 'yellow', rgb: 16776960 }],
			success: true,
			meta: {
				changed_db: true,
				changes: 1,
				// Don't know duration, so just match on returned value asserted > 0
				duration: result.meta.duration,
				last_row_id: 4,
				// Upstream expects Miniflare's backend name 'miniflare.db'; Cloudflare does not promise a value
				served_by: result.meta.served_by,
				size_after: result.meta.size_after,
				rows_read: 2,
				rows_written: 1,
			},
		})

		// Check with multiple statements
		const resultPromise = db
			.prepare(
				`INSERT INTO ${tableKitchenSink} (id) VALUES (1); INSERT INTO ${tableKitchenSink} (id) VALUES (2);`,
			)
			.run()

		// workerd changed its behaviour from throwing to returning the last result. Miniflare's tests should pass with either version of workerd
		try {
			result = await resultPromise
			expect(result).toEqual({
				meta: {
					changed_db: true,
					changes: 2,
					// Don't know duration, so just match on returned value asserted > 0
					duration: result.meta.duration,
					last_row_id: result.meta.last_row_id,
					rows_read: 1,
					rows_written: 1,
					// Upstream expects Miniflare's backend name 'miniflare.db'; Cloudflare does not promise a value
					served_by: result.meta.served_by,
					size_after: result.meta.size_after,
				},
				results: [],
				success: true,
			})
		} catch (e) {
			expect(e).toBeInstanceOf(Error)
			expect(
				/A prepared SQL statement must contain only one statement/.test(
					e instanceof Error ? e.message : String(e),
				),
			).toBeTruthy()
		}

		// Check with write statement
		result = await db
			.prepare(`INSERT INTO ${tableColours} (id, name, rgb) VALUES (?, ?, ?)`)
			.bind(5, 'orange', 0xff8000)
			.run()
		expect(result.meta.duration >= 0).toBe(true)
		expect(result).toEqual({
			results: [],
			success: true,
			meta: {
				changed_db: true,
				changes: 1,
				// Don't know duration, so just match on returned value asserted > 0
				duration: result.meta.duration,
				last_row_id: 5,
				// Upstream expects Miniflare's backend name 'miniflare.db'; Cloudflare does not promise a value
				served_by: result.meta.served_by,
				size_after: result.meta.size_after,
				rows_read: 1,
				rows_written: 1,
			},
		})
	})

	conformanceTest(known, 'D1PreparedStatement: all', async () => {
		const { db, tableColours } = ctx

		// Check with read statement
		let result = await db
			.prepare(`SELECT * FROM ${tableColours}`)
			.all<ColourRow>()
		expect(result.meta.duration >= 0).toBe(true)
		expect(result).toEqual({
			results: [
				{ id: 1, name: 'red', rgb: 0xff0000 },
				{ id: 2, name: 'green', rgb: 0x00ff00 },
				{ id: 3, name: 'blue', rgb: 0x0000ff },
			],
			success: true,
			meta: {
				changed_db: false,
				changes: 0,
				// Don't know duration, so just match on returned value asserted > 0
				duration: result.meta.duration,
				// Not an `INSERT`, so `last_row_id` non-deterministic
				last_row_id: result.meta.last_row_id,
				// Upstream expects Miniflare's backend name 'miniflare.db'; Cloudflare does not promise a value
				served_by: result.meta.served_by,
				size_after: result.meta.size_after,
				rows_read: 3,
				rows_written: 0,
			},
		})

		// Check with multiple statements
		const resultPromise = db
			.prepare(
				`SELECT * FROM ${tableColours} WHERE id = 1; SELECT * FROM ${tableColours} WHERE id = 3;`,
			)
			.all<ColourRow>()

		// workerd changed its behaviour from throwing to returning the last result. Miniflare's tests should pass with either version of workerd
		try {
			result = await resultPromise
			expect(result).toEqual({
				meta: {
					changed_db: false,
					changes: 0,
					// Don't know duration, so just match on returned value asserted > 0
					duration: result.meta.duration,
					last_row_id: result.meta.last_row_id,
					rows_read: 1,
					rows_written: 0,
					// Upstream expects Miniflare's backend name 'miniflare.db'; Cloudflare does not promise a value
					served_by: result.meta.served_by,
					size_after: result.meta.size_after,
				},
				results: [
					{
						id: 3,
						name: 'blue',
						rgb: 255,
					},
				],
				success: true,
			})
		} catch (e) {
			expect(e).toBeInstanceOf(Error)
			expect(
				/A prepared SQL statement must contain only one statement/.test(
					e instanceof Error ? e.message : String(e),
				),
			).toBeTruthy()
		}

		// Check with write statement (should actually execute, but return nothing)
		result = await db
			.prepare(`INSERT INTO ${tableColours} (id, name, rgb) VALUES (?, ?, ?)`)
			.bind(4, 'yellow', 0xffff00)
			.all()
		expect(result.results).toEqual([])
		expect(result.meta.last_row_id).toBe(4)
		expect(result.meta.changes).toBe(1)
		const id = await db
			.prepare(`SELECT id FROM ${tableColours} WHERE name = ?`)
			.bind('yellow')
			.first<number>('id')
		expect(id).toBe(4)

		// Check with write statement that returns data
		result = await db
			.prepare(
				`INSERT INTO ${tableColours} (id, name, rgb) VALUES (?, ?, ?) RETURNING id`,
			)
			.bind(5, 'orange', 0xff8000)
			.all()
		expect(result.results).toEqual<Pick<ColourRow, 'id'>[]>([{ id: 5 }])
		expect(result.meta.last_row_id).toBe(5)
		expect(result.meta.changes).toBe(1)
	})

	conformanceTest(known, 'D1PreparedStatement: raw', async () => {
		const { db, tableColours } = ctx

		// Check with read statement
		type RawColourRow = [/* id */ number, /* name */ string, /* rgb*/ number]
		let results = await db
			.prepare(`SELECT * FROM ${tableColours}`)
			.raw<RawColourRow>()
		expect(results).toEqual([
			[1, 'red', 0xff0000],
			[2, 'green', 0x00ff00],
			[3, 'blue', 0x0000ff],
		])

		// Check with multiple statements (should only return first statement results)
		const resultPromise = db
			.prepare(
				`SELECT * FROM ${tableColours} WHERE id = 1; SELECT * FROM ${tableColours} WHERE id = 3;`,
			)
			.raw<RawColourRow>()

		// workerd changed its behaviour from throwing to returning the last result. Miniflare's tests should pass with either version of workerd
		try {
			const result = await resultPromise
			expect(result).toEqual([[3, 'blue', 0x0000ff]])
		} catch (e) {
			expect(e).toBeInstanceOf(Error)
			expect(
				/A prepared SQL statement must contain only one statement/.test(
					e instanceof Error ? e.message : String(e),
				),
			).toBeTruthy()
		}

		// Check with write statement (should actually execute, but return nothing)
		results = await db
			.prepare(`INSERT INTO ${tableColours} (id, name, rgb) VALUES (?, ?, ?)`)
			.bind(4, 'yellow', 0xffff00)
			.raw()
		expect(results).toEqual([])
		const id = await db
			.prepare(`SELECT id FROM ${tableColours} WHERE name = ?`)
			.bind('yellow')
			.first<number>('id')
		expect(id).toBe(4)

		// Check whether workerd raw test case passes here too
		// (the original skips this under the legacy `__D1_BETA__` binding, which is not ported)
		await db.prepare(`CREATE TABLE abc (a INT, b INT, c INT);`).run()
		await db.prepare(`CREATE TABLE cde (c INT, d INT, e INT);`).run()
		await db.prepare(`INSERT INTO abc VALUES (1,2,3),(4,5,6);`).run()
		await db.prepare(`INSERT INTO cde VALUES (7,8,9),(1,2,3);`).run()
		const rawPromise = await db
			.prepare(`SELECT * FROM abc, cde;`)
			.raw({ columnNames: true })
		expect(rawPromise).toEqual([
			['a', 'b', 'c', 'c', 'd', 'e'],
			[1, 2, 3, 7, 8, 9],
			[1, 2, 3, 1, 2, 3],
			[4, 5, 6, 7, 8, 9],
			[4, 5, 6, 1, 2, 3],
		])
	})

	conformanceTest(known, 'operations permit strange database names', async () => {
		const { tableColours, tableKitchenSink, tablePalettes } = ctx

		// Miniflare sets the database id via `setOptions`; lopata takes the name from wrangler's `database_name`.
		const id = 'my/ Database'
		const db = openD1Database(useTmp(), id)

		// Check basic operations work

		await db.exec(SCHEMA(tableColours, tableKitchenSink, tablePalettes))

		await db
			.prepare(
				`INSERT INTO ${tableColours} (id, name, rgb) VALUES (4, 'pink', 0xff00ff);`,
			)
			.run()
		const result = await db
			.prepare(`SELECT name FROM ${tableColours} WHERE id = 4`)
			.first<Pick<ColourRow, 'name'>>()
		expect(result).toEqual({ name: 'pink' })
	})

	conformanceTest(known, 'it properly handles ROWS_AND_COLUMNS results format', async () => {
		const { db, tableColours, tablePalettes } = ctx

		const results = await db
			.prepare(
				`SELECT ${tableColours}.name, ${tablePalettes}.name FROM ${tableColours} JOIN ${tablePalettes} ON ${tableColours}.id = ${tablePalettes}.colour_id`,
			)
			.raw()

		// The original expects `[['Night']]` under the legacy `__D1_BETA__` binding, which is not ported
		const expectedResults = [['blue', 'Night']]
		expect(results).toEqual(expectedResults)
	})
})
