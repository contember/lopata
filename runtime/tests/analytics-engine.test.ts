import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { SqliteAnalyticsEngine } from '../bindings/analytics-engine'
import { runMigrations } from '../db'

let db: Database

beforeEach(() => {
	db = new Database(':memory:')
	runMigrations(db)
})

afterEach(() => {
	db.close()
})

describe('SqliteAnalyticsEngine', () => {
	test('writeDataPoint with no arguments records a row with timestamp', () => {
		const engine = new SqliteAnalyticsEngine(db, 'test_dataset')
		engine.writeDataPoint()

		const rows = db.query('SELECT * FROM analytics_engine WHERE dataset = ?').all('test_dataset') as any[]
		expect(rows).toHaveLength(1)
		expect(rows[0].dataset).toBe('test_dataset')
		expect(rows[0].timestamp).toBeGreaterThan(0)
		expect(rows[0]._sample_interval).toBe(1)
		expect(rows[0].index1).toBeNull()
	})

	test('writeDataPoint stores indexes, doubles, and blobs', () => {
		const engine = new SqliteAnalyticsEngine(db, 'metrics')
		engine.writeDataPoint({
			indexes: ['user-123'],
			doubles: [42, 3.14, 0],
			blobs: ['page-view', 'https://example.com'],
		})

		const row = db.query('SELECT * FROM analytics_engine WHERE dataset = ?').get('metrics') as any
		expect(row.index1).toBe('user-123')
		expect(row.double1).toBe(42)
		expect(row.double2).toBe(3.14)
		expect(row.double3).toBe(0)
		expect(row.double4).toBeNull()
		expect(row.blob1).toBe('page-view')
		expect(row.blob2).toBe('https://example.com')
		expect(row.blob3).toBeNull()
	})

	test("dataset isolation — two datasets don't see each other's data", () => {
		const engine1 = new SqliteAnalyticsEngine(db, 'dataset_a')
		const engine2 = new SqliteAnalyticsEngine(db, 'dataset_b')

		engine1.writeDataPoint({ doubles: [1] })
		engine1.writeDataPoint({ doubles: [2] })
		engine2.writeDataPoint({ doubles: [99] })

		const rowsA = db.query('SELECT * FROM analytics_engine WHERE dataset = ?').all('dataset_a') as any[]
		const rowsB = db.query('SELECT * FROM analytics_engine WHERE dataset = ?').all('dataset_b') as any[]
		expect(rowsA).toHaveLength(2)
		expect(rowsB).toHaveLength(1)
		expect(rowsB[0].double1).toBe(99)
	})

	test('ArrayBuffer values in indexes work correctly', () => {
		const engine = new SqliteAnalyticsEngine(db, 'ab_test')
		const buf = new TextEncoder().encode('idx-buf').buffer
		engine.writeDataPoint({ indexes: [buf] })

		const row = db.query('SELECT index1 FROM analytics_engine WHERE dataset = ?').get('ab_test') as any
		expect(row.index1).toBe('idx-buf')
	})

	test('ArrayBuffer values in blobs work correctly', () => {
		const engine = new SqliteAnalyticsEngine(db, 'ab_blob')
		const buf = new TextEncoder().encode('blob-data').buffer
		engine.writeDataPoint({ blobs: [buf] })

		const row = db.query('SELECT blob1 FROM analytics_engine WHERE dataset = ?').get('ab_blob') as any
		expect(row.blob1).toBe('blob-data')
	})

	test('null values in blobs array are preserved', () => {
		const engine = new SqliteAnalyticsEngine(db, 'null_blobs')
		engine.writeDataPoint({ blobs: ['first', null, 'third'] })

		const row = db.query('SELECT blob1, blob2, blob3 FROM analytics_engine WHERE dataset = ?').get('null_blobs') as any
		expect(row.blob1).toBe('first')
		expect(row.blob2).toBeNull()
		expect(row.blob3).toBe('third')
	})

	describe('validation', () => {
		test('rejects more than 1 index', () => {
			const engine = new SqliteAnalyticsEngine(db, 'v')
			expect(() => engine.writeDataPoint({ indexes: ['a', 'b'] })).toThrow(/maximum length of 1/)
		})

		test('rejects index exceeding 96 bytes', () => {
			const engine = new SqliteAnalyticsEngine(db, 'v')
			const longIndex = 'x'.repeat(97)
			expect(() => engine.writeDataPoint({ indexes: [longIndex] })).toThrow(/maximum size of 96 bytes/)
		})

		test('rejects more than 20 doubles', () => {
			const engine = new SqliteAnalyticsEngine(db, 'v')
			const doubles = Array.from({ length: 21 }, (_, i) => i)
			expect(() => engine.writeDataPoint({ doubles })).toThrow(/maximum length of 20/)
		})

		test('rejects more than 20 blobs', () => {
			const engine = new SqliteAnalyticsEngine(db, 'v')
			const blobs = Array.from({ length: 21 }, (_, i) => `b${i}`)
			expect(() => engine.writeDataPoint({ blobs })).toThrow(/maximum length of 20/)
		})

		test('rejects blobs exceeding 16KB total', () => {
			const engine = new SqliteAnalyticsEngine(db, 'v')
			// 2 blobs of ~9KB each = ~18KB > 16KB
			const bigBlob = 'x'.repeat(9000)
			expect(() => engine.writeDataPoint({ blobs: [bigBlob, bigBlob] })).toThrow(/maximum of 16384 bytes/)
		})
	})
})
