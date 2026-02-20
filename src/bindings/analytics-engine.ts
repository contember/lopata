import { randomUUIDv7 } from 'bun'
import type { Database } from 'bun:sqlite'

export interface AnalyticsEngineDataPoint {
	indexes?: ((ArrayBuffer | string) | null)[]
	doubles?: number[]
	blobs?: ((ArrayBuffer | string) | null)[]
}

const MAX_INDEXES = 1
const MAX_INDEX_BYTES = 96
const MAX_DOUBLES = 20
const MAX_BLOBS = 20
const MAX_BLOBS_TOTAL_BYTES = 16 * 1024 // 16 KB

function toText(value: ArrayBuffer | string | null | undefined): string | null {
	if (value == null) return null
	if (typeof value === 'string') return value
	return new TextDecoder().decode(value)
}

function byteLength(value: ArrayBuffer | string | null | undefined): number {
	if (value == null) return 0
	if (typeof value === 'string') return new TextEncoder().encode(value).byteLength
	return value.byteLength
}

/**
 * SqliteAnalyticsEngine — local implementation of the Cloudflare Analytics Engine
 * `writeDataPoint()` binding. Stores data points in SQLite.
 */
export class SqliteAnalyticsEngine {
	private db: Database
	private dataset: string
	private insertStmt: ReturnType<Database['query']>

	constructor(db: Database, dataset: string) {
		this.db = db
		this.dataset = dataset

		const blobCols = Array.from({ length: MAX_BLOBS }, (_, i) => `blob${i + 1}`)
		const doubleCols = Array.from({ length: MAX_DOUBLES }, (_, i) => `double${i + 1}`)
		const allCols = ['id', 'dataset', 'timestamp', '_sample_interval', 'index1', ...blobCols, ...doubleCols]
		const placeholders = allCols.map(() => '?').join(', ')
		this.insertStmt = db.query(`INSERT INTO analytics_engine (${allCols.join(', ')}) VALUES (${placeholders})`)
	}

	writeDataPoint(event?: AnalyticsEngineDataPoint): void {
		const indexes = event?.indexes ?? []
		const doubles = event?.doubles ?? []
		const blobs = event?.blobs ?? []

		// Validate indexes
		if (indexes.length > MAX_INDEXES) {
			throw new Error(`Analytics Engine: indexes array exceeds maximum length of ${MAX_INDEXES}`)
		}
		for (const idx of indexes) {
			if (idx != null && byteLength(idx) > MAX_INDEX_BYTES) {
				throw new Error(`Analytics Engine: index value exceeds maximum size of ${MAX_INDEX_BYTES} bytes`)
			}
		}

		// Validate doubles
		if (doubles.length > MAX_DOUBLES) {
			throw new Error(`Analytics Engine: doubles array exceeds maximum length of ${MAX_DOUBLES}`)
		}

		// Validate blobs
		if (blobs.length > MAX_BLOBS) {
			throw new Error(`Analytics Engine: blobs array exceeds maximum length of ${MAX_BLOBS}`)
		}
		let totalBlobBytes = 0
		for (const blob of blobs) {
			totalBlobBytes += byteLength(blob)
		}
		if (totalBlobBytes > MAX_BLOBS_TOTAL_BYTES) {
			throw new Error(`Analytics Engine: total blob size exceeds maximum of ${MAX_BLOBS_TOTAL_BYTES} bytes`)
		}

		const id = randomUUIDv7()
		const timestamp = Date.now()
		const index1 = toText(indexes[0])

		const blobValues: (string | null)[] = []
		for (let i = 0; i < MAX_BLOBS; i++) {
			blobValues.push(i < blobs.length ? toText(blobs[i]) : null)
		}

		const doubleValues: (number | null)[] = []
		for (let i = 0; i < MAX_DOUBLES; i++) {
			doubleValues.push(i < doubles.length ? doubles[i]! : null)
		}

		this.insertStmt.run(id, this.dataset, timestamp, 1, index1, ...blobValues, ...doubleValues)
	}
}
