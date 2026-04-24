import type { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// --- Limits ---

export interface R2Limits {
	maxKeySize?: number // default 1024 bytes
	maxCustomMetadataSize?: number // default 2048 bytes
	maxBatchDeleteKeys?: number // default 1000
	maxMultipartPartSize?: number // default 5 GiB (not enforced, just documented)
	minMultipartPartSize?: number // default 5 MiB (last part exempt)
	maxMultipartParts?: number // default 10000
}

const R2_DEFAULTS: Required<R2Limits> = {
	maxKeySize: 1024,
	maxCustomMetadataSize: 2048,
	maxBatchDeleteKeys: 1000,
	maxMultipartPartSize: 5 * 1024 * 1024 * 1024,
	minMultipartPartSize: 5 * 1024 * 1024,
	maxMultipartParts: 10000,
}

// --- Interfaces ---

export interface R2Conditional {
	etagMatches?: string | string[]
	etagDoesNotMatch?: string | string[]
	uploadedBefore?: Date
	uploadedAfter?: Date
}

export interface R2Range {
	offset?: number
	length?: number
	suffix?: number
}

export interface R2Checksums {
	md5?: ArrayBuffer
	sha1?: ArrayBuffer
	sha256?: ArrayBuffer
	sha384?: ArrayBuffer
	sha512?: ArrayBuffer
}

export interface R2HTTPMetadata {
	contentType?: string
	contentLanguage?: string
	contentDisposition?: string
	contentEncoding?: string
	cacheControl?: string
	cacheExpiry?: Date
}

export interface R2GetOptions {
	onlyIf?: R2Conditional
	range?: R2Range
}

export interface R2PutOptions {
	httpMetadata?: R2HTTPMetadata
	customMetadata?: Record<string, string>
	onlyIf?: R2Conditional
	md5?: ArrayBuffer | string
	sha1?: ArrayBuffer | string
	sha256?: ArrayBuffer | string
	sha384?: ArrayBuffer | string
	sha512?: ArrayBuffer | string
}

export interface R2ListOptions {
	prefix?: string
	limit?: number
	cursor?: string
	delimiter?: string
	include?: ('httpMetadata' | 'customMetadata')[]
}

interface R2ObjectMeta {
	key: string
	size: number
	etag: string
	version: string
	uploaded: Date
	httpMetadata: R2HTTPMetadata
	customMetadata: Record<string, string>
	checksums: R2Checksums
	range?: { offset: number; length: number }
}

// --- R2Object ---

export class R2Object {
	readonly key: string
	readonly size: number
	readonly etag: string
	readonly httpEtag: string
	readonly version: string
	readonly uploaded: Date
	readonly httpMetadata: R2HTTPMetadata
	readonly customMetadata: Record<string, string>
	readonly checksums: R2Checksums
	readonly storageClass: string
	readonly range?: { offset: number; length: number }

	constructor(meta: R2ObjectMeta) {
		this.key = meta.key
		this.size = meta.size
		this.etag = meta.etag
		this.httpEtag = `"${meta.etag}"`
		this.version = meta.version
		this.uploaded = meta.uploaded
		this.httpMetadata = meta.httpMetadata
		this.customMetadata = meta.customMetadata
		this.checksums = meta.checksums
		this.storageClass = 'Standard'
		this.range = meta.range
	}

	writeHttpMetadata(headers: Headers): void {
		for (const [header, field] of HTTP_METADATA_FIELDS) {
			const v = this.httpMetadata[field]
			if (!v) continue
			headers.set(header, v instanceof Date ? v.toUTCString() : v)
		}
	}
}

// --- R2ObjectBody ---

export class R2ObjectBody extends R2Object {
	readonly bodyUsed: boolean = false
	private filePath: string
	private rangeOffset: number
	private rangeLength: number
	private totalSize: number

	constructor(meta: R2ObjectMeta, filePath: string, rangeOffset: number, rangeLength: number, totalSize: number) {
		super(meta)
		this.filePath = filePath
		this.rangeOffset = rangeOffset
		this.rangeLength = rangeLength
		this.totalSize = totalSize
	}

	private isFullFile(): boolean {
		return this.rangeOffset === 0 && this.rangeLength === this.totalSize
	}

	/**
	 * Full-file bodies stream directly from disk (O(chunk) memory). Range bodies
	 * read the slice eagerly — ranges are typically small (< a few MB) so this
	 * doesn't undermine the memory guarantees the streaming write path gives us.
	 */
	get body(): ReadableStream<Uint8Array> {
		if (this.isFullFile()) return Bun.file(this.filePath).stream()
		const slice = Bun.file(this.filePath).slice(this.rangeOffset, this.rangeOffset + this.rangeLength)
		return new ReadableStream({
			async start(controller) {
				const buf = await slice.arrayBuffer()
				controller.enqueue(new Uint8Array(buf))
				controller.close()
			},
		})
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		if (this.isFullFile()) return Bun.file(this.filePath).arrayBuffer()
		return Bun.file(this.filePath).slice(this.rangeOffset, this.rangeOffset + this.rangeLength).arrayBuffer()
	}

	async text(): Promise<string> {
		return new TextDecoder().decode(await this.arrayBuffer())
	}

	async json<T = unknown>(): Promise<T> {
		return JSON.parse(await this.text())
	}

	async blob(): Promise<Blob> {
		return new Blob([await this.arrayBuffer()])
	}
}

// --- DB row ---

interface R2Row {
	key: string
	size: number
	etag: string
	version: string
	uploaded: string
	http_metadata: string | null
	custom_metadata: string | null
	checksums: string | null
}

function rowToMeta(row: R2Row): R2ObjectMeta {
	return {
		key: row.key,
		size: row.size,
		etag: row.etag,
		version: row.version ?? row.etag,
		uploaded: new Date(row.uploaded),
		httpMetadata: deserializeHttpMetadata(row.http_metadata),
		customMetadata: row.custom_metadata ? JSON.parse(row.custom_metadata) : {},
		checksums: row.checksums ? deserializeChecksums(JSON.parse(row.checksums)) : {},
	}
}

/**
 * (httpHeader, R2HTTPMetadata field). Drives serialization, deserialization,
 * and HTTP header round-tripping — keep this list as the single source of truth.
 * cacheExpiry is a Date; all others are strings.
 */
export const HTTP_METADATA_FIELDS: ReadonlyArray<
	readonly [httpHeader: string, field: keyof R2HTTPMetadata]
> = [
	['content-type', 'contentType'],
	['content-language', 'contentLanguage'],
	['content-disposition', 'contentDisposition'],
	['content-encoding', 'contentEncoding'],
	['cache-control', 'cacheControl'],
	['expires', 'cacheExpiry'],
]

function serializeHttpMetadata(m: R2HTTPMetadata | undefined): string | null {
	if (!m) return null
	const obj: Record<string, string> = {}
	for (const [, field] of HTTP_METADATA_FIELDS) {
		const v = m[field]
		if (!v) continue
		obj[field] = v instanceof Date ? v.toISOString() : v
	}
	return Object.keys(obj).length === 0 ? null : JSON.stringify(obj)
}

function deserializeHttpMetadata(s: string | null): R2HTTPMetadata {
	if (!s) return {}
	const obj = JSON.parse(s) as Record<string, string>
	const result: R2HTTPMetadata = {}
	for (const [, field] of HTTP_METADATA_FIELDS) {
		const v = obj[field]
		if (!v) continue
		;(result[field] as string | Date) = field === 'cacheExpiry' ? new Date(v) : v
	}
	return result
}

function serializeChecksums(c: R2Checksums): Record<string, string> {
	const result: Record<string, string> = {}
	for (const [k, v] of Object.entries(c)) {
		if (v instanceof ArrayBuffer) {
			result[k] = Buffer.from(v).toString('hex')
		} else if (typeof v === 'string') {
			result[k] = v
		}
	}
	return result
}

function deserializeChecksums(c: Record<string, string>): R2Checksums {
	const result: R2Checksums = {}
	for (const [k, v] of Object.entries(c)) {
		;(result as Record<string, ArrayBuffer>)[k] = Buffer.from(v, 'hex').buffer as ArrayBuffer
	}
	return result
}

/**
 * Compute the S3-compatible multipart ETag: hex(md5(concat-of-part-md5-bytes)) + "-" + N.
 * Each part's stored etag is hex MD5 of the part body; we concatenate the raw (binary)
 * digests and hash the result.
 */
function computeMultipartEtag(partRows: Array<{ etag: string }>): string {
	const buf = Buffer.concat(partRows.map((r) => Buffer.from(r.etag, 'hex')))
	const hasher = new Bun.CryptoHasher('md5')
	hasher.update(buf)
	return `${hasher.digest('hex')}-${partRows.length}`
}

/**
 * Write `value` to `filePath` while hashing it. No intermediate buffering for
 * streams/Blobs — bytes flow directly from the source to disk. Returns MD5 hex
 * etag and total byte count.
 */
async function writeValueToFile(
	value: string | ArrayBuffer | ArrayBufferView | ReadableStream | Blob | null,
	filePath: string,
): Promise<{ etag: string; size: number }> {
	mkdirSync(dirname(filePath), { recursive: true })
	const hasher = new Bun.CryptoHasher('md5')

	if (value === null) {
		await Bun.write(filePath, '')
		return { etag: hasher.digest('hex'), size: 0 }
	}
	if (typeof value === 'string') {
		const bytes = new TextEncoder().encode(value)
		hasher.update(bytes)
		await Bun.write(filePath, bytes)
		return { etag: hasher.digest('hex'), size: bytes.byteLength }
	}
	if (value instanceof ArrayBuffer) {
		hasher.update(new Uint8Array(value))
		await Bun.write(filePath, value)
		return { etag: hasher.digest('hex'), size: value.byteLength }
	}
	if (ArrayBuffer.isView(value)) {
		const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
		hasher.update(view)
		await Bun.write(filePath, view)
		return { etag: hasher.digest('hex'), size: view.byteLength }
	}
	const stream = value instanceof Blob ? value.stream() : value
	const writer = Bun.file(filePath).writer()
	let size = 0
	const reader = stream.getReader()
	try {
		while (true) {
			const { done, value: chunk } = await reader.read()
			if (done) break
			hasher.update(chunk)
			writer.write(chunk)
			size += chunk.byteLength
		}
	} finally {
		await writer.end()
	}
	return { etag: hasher.digest('hex'), size }
}

// --- Conditional check ---

function evaluateConditional(cond: R2Conditional, etag: string, uploaded: Date): boolean {
	if (cond.etagMatches !== undefined) {
		const tags = Array.isArray(cond.etagMatches) ? cond.etagMatches : [cond.etagMatches]
		if (!tags.some((t) => t === etag || t === `"${etag}"` || t === '*')) return false
	}
	if (cond.etagDoesNotMatch !== undefined) {
		const tags = Array.isArray(cond.etagDoesNotMatch) ? cond.etagDoesNotMatch : [cond.etagDoesNotMatch]
		if (tags.some((t) => t === etag || t === `"${etag}"`)) return false
	}
	if (cond.uploadedBefore !== undefined) {
		if (uploaded >= cond.uploadedBefore) return false
	}
	if (cond.uploadedAfter !== undefined) {
		if (uploaded <= cond.uploadedAfter) return false
	}
	return true
}

// --- Multipart Upload ---

interface MultipartRow {
	upload_id: string
	bucket: string
	key: string
	http_metadata: string | null
	custom_metadata: string | null
	created_at: string
}

interface MultipartPartRow {
	upload_id: string
	part_number: number
	etag: string
	size: number
	file_path: string
}

export class R2MultipartUpload {
	readonly key: string
	readonly uploadId: string
	private db: Database
	private bucket: string
	private baseDir: string
	private limits: Required<R2Limits>

	constructor(
		db: Database,
		bucket: string,
		baseDir: string,
		key: string,
		uploadId: string,
		limits: Required<R2Limits>,
	) {
		this.db = db
		this.bucket = bucket
		this.baseDir = baseDir
		this.key = key
		this.uploadId = uploadId
		this.limits = limits
	}

	async uploadPart(
		partNumber: number,
		data: ArrayBuffer | ArrayBufferView | string | ReadableStream | Blob,
	): Promise<{ partNumber: number; etag: string }> {
		// Verify upload exists and is not aborted/completed
		const upload = this.db
			.query<MultipartRow, [string, string]>(
				`SELECT * FROM r2_multipart_uploads WHERE upload_id = ? AND bucket = ?`,
			)
			.get(this.uploadId, this.bucket)
		if (!upload) throw new Error('Multipart upload not found or already completed/aborted')

		const partDir = join(this.baseDir, '__multipart__', this.uploadId)
		const partPath = join(partDir, `part-${partNumber}`)
		const { etag, size } = await writeValueToFile(data, partPath)

		// Upsert part record
		this.db.run(
			`INSERT OR REPLACE INTO r2_multipart_parts (upload_id, part_number, etag, size, file_path)
       VALUES (?, ?, ?, ?, ?)`,
			[this.uploadId, partNumber, etag, size, partPath],
		)

		return { partNumber, etag }
	}

	async complete(parts: { partNumber: number; etag: string }[]): Promise<R2Object> {
		const upload = this.db
			.query<MultipartRow, [string, string]>(
				`SELECT * FROM r2_multipart_uploads WHERE upload_id = ? AND bucket = ?`,
			)
			.get(this.uploadId, this.bucket)
		if (!upload) throw new Error('Multipart upload not found or already completed/aborted')

		// Load all parts in one query and index by number — avoids N+1 for uploads with many parts.
		const allRows = this.db
			.query<MultipartPartRow, [string]>(`SELECT * FROM r2_multipart_parts WHERE upload_id = ?`)
			.all(this.uploadId)
		const byNumber = new Map(allRows.map((r) => [r.part_number, r]))
		const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber)
		const partRows: MultipartPartRow[] = []
		for (const p of sorted) {
			const row = byNumber.get(p.partNumber)
			if (!row) throw new Error(`Part ${p.partNumber} not found`)
			if (row.etag !== p.etag) throw new Error(`Part ${p.partNumber} etag mismatch`)
			partRows.push(row)
		}

		// Stream each part's bytes through a FileSink — O(1) memory regardless of total size.
		const filePath = join(this.baseDir, this.key)
		mkdirSync(dirname(filePath), { recursive: true })
		const writer = Bun.file(filePath).writer()
		let totalSize = 0
		try {
			for (const row of partRows) {
				const partStream = Bun.file(row.file_path).stream()
				const reader = partStream.getReader()
				while (true) {
					const { done, value } = await reader.read()
					if (done) break
					writer.write(value)
					totalSize += value.byteLength
				}
			}
		} finally {
			await writer.end()
		}

		// S3/CF multipart ETag: hex(md5(concat-of-part-md5-bytes)) + "-" + partCount.
		const etag = computeMultipartEtag(partRows)
		const uploaded = new Date()
		const version = crypto.randomUUID()

		const httpMeta = deserializeHttpMetadata(upload.http_metadata)
		const customMeta = upload.custom_metadata ? JSON.parse(upload.custom_metadata) : {}

		// Atomically: persist the final object and remove multipart DB rows.
		this.db.transaction(() => {
			this.db.run(
				`INSERT OR REPLACE INTO r2_objects (bucket, key, size, etag, version, uploaded, http_metadata, custom_metadata, checksums)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					this.bucket,
					this.key,
					totalSize,
					etag,
					version,
					uploaded.toISOString(),
					upload.http_metadata,
					upload.custom_metadata,
					null,
				],
			)
			this.db.run(`DELETE FROM r2_multipart_parts WHERE upload_id = ?`, [this.uploadId])
			this.db.run(`DELETE FROM r2_multipart_uploads WHERE upload_id = ?`, [this.uploadId])
		})()
		this.removePartFiles()

		return new R2Object({
			key: this.key,
			size: totalSize,
			etag,
			version,
			uploaded,
			httpMetadata: httpMeta,
			customMetadata: customMeta,
			checksums: {},
		})
	}

	async abort(): Promise<void> {
		this.db.transaction(() => {
			this.db.run(`DELETE FROM r2_multipart_parts WHERE upload_id = ?`, [this.uploadId])
			this.db.run(`DELETE FROM r2_multipart_uploads WHERE upload_id = ?`, [this.uploadId])
		})()
		this.removePartFiles()
	}

	/** Inspect parts that have been uploaded so far (used by S3 ListParts). */
	listParts(): Array<{ partNumber: number; etag: string; size: number; lastModified: Date }> {
		const rows = this.db
			.query<MultipartPartRow, [string]>(
				`SELECT * FROM r2_multipart_parts WHERE upload_id = ? ORDER BY part_number`,
			)
			.all(this.uploadId)
		return rows.map((r) => ({
			partNumber: r.part_number,
			etag: r.etag,
			size: r.size,
			lastModified: new Date(),
		}))
	}

	private removePartFiles(): void {
		const partDir = join(this.baseDir, '__multipart__', this.uploadId)
		if (existsSync(partDir)) rmSync(partDir, { recursive: true, force: true })
	}
}

// --- FileR2Bucket ---

export class FileR2Bucket {
	private db: Database
	private bucket: string
	private baseDir: string
	private limits: Required<R2Limits>

	constructor(db: Database, bucket: string, dataDir: string, limits?: R2Limits) {
		this.db = db
		this.bucket = bucket
		this.baseDir = join(dataDir, 'r2', bucket)
		this.limits = { ...R2_DEFAULTS, ...limits }
		mkdirSync(this.baseDir, { recursive: true })

		// Ensure version and checksums columns exist (migration for existing DBs)
		this.ensureColumns()
		this.ensureMultipartTables()
	}

	private ensureColumns(): void {
		try {
			this.db.run(`ALTER TABLE r2_objects ADD COLUMN version TEXT NOT NULL DEFAULT ''`)
		} catch {
			// Column already exists
		}
		try {
			this.db.run(`ALTER TABLE r2_objects ADD COLUMN checksums TEXT`)
		} catch {
			// Column already exists
		}
	}

	private ensureMultipartTables(): void {
		this.db.run(`
      CREATE TABLE IF NOT EXISTS r2_multipart_uploads (
        upload_id TEXT PRIMARY KEY,
        bucket TEXT NOT NULL,
        key TEXT NOT NULL,
        http_metadata TEXT,
        custom_metadata TEXT,
        created_at TEXT NOT NULL
      )
    `)
		this.db.run(`
      CREATE TABLE IF NOT EXISTS r2_multipart_parts (
        upload_id TEXT NOT NULL,
        part_number INTEGER NOT NULL,
        etag TEXT NOT NULL,
        size INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        PRIMARY KEY (upload_id, part_number)
      )
    `)
	}

	private validateKey(key: string): void {
		const keyBytes = new TextEncoder().encode(key)
		if (keyBytes.length > this.limits.maxKeySize) {
			throw new Error(`Key exceeds max size of ${this.limits.maxKeySize} bytes`)
		}
		if (key.includes('..')) {
			throw new Error(`Invalid key: path traversal not allowed`)
		}
	}

	private validateCustomMetadata(metadata: Record<string, string> | undefined): void {
		if (!metadata) return
		const serialized = JSON.stringify(metadata)
		if (new TextEncoder().encode(serialized).length > this.limits.maxCustomMetadataSize) {
			throw new Error(`Custom metadata exceeds max size of ${this.limits.maxCustomMetadataSize} bytes`)
		}
	}

	private filePath(key: string): string {
		return join(this.baseDir, key)
	}

	async put(
		key: string,
		value: string | ArrayBuffer | ArrayBufferView | ReadableStream | Blob | null,
		options?: R2PutOptions,
	): Promise<R2Object | null> {
		this.validateKey(key)
		this.validateCustomMetadata(options?.customMetadata)

		// Check conditional before writing
		if (options?.onlyIf) {
			const existing = this.getRow(key)
			if (existing) {
				const meta = rowToMeta(existing)
				if (!evaluateConditional(options.onlyIf, meta.etag, meta.uploaded)) {
					return null
				}
			}
		}

		const fp = this.filePath(key)
		const { etag, size } = await writeValueToFile(value, fp)
		const uploaded = new Date()
		const version = crypto.randomUUID()

		// Build checksums. md5 is always computed; user-supplied sha* are stored as-is.
		const checksums: R2Checksums = { md5: Buffer.from(etag, 'hex').buffer as ArrayBuffer }
		for (const algo of ['sha1', 'sha256', 'sha384', 'sha512'] as const) {
			const provided = options?.[algo]
			if (provided) {
				;(checksums as Record<string, ArrayBuffer>)[algo] = typeof provided === 'string' ? Buffer.from(provided, 'hex').buffer as ArrayBuffer : provided
			}
		}

		this.db.run(
			`INSERT OR REPLACE INTO r2_objects (bucket, key, size, etag, version, uploaded, http_metadata, custom_metadata, checksums)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				this.bucket,
				key,
				size,
				etag,
				version,
				uploaded.toISOString(),
				serializeHttpMetadata(options?.httpMetadata),
				options?.customMetadata ? JSON.stringify(options.customMetadata) : null,
				JSON.stringify(serializeChecksums(checksums)),
			],
		)

		return new R2Object({
			key,
			size,
			etag,
			version,
			uploaded,
			httpMetadata: options?.httpMetadata ?? {},
			customMetadata: options?.customMetadata ?? {},
			checksums,
		})
	}

	private getRow(key: string): R2Row | null {
		return this.db
			.query<R2Row, [string, string]>(
				`SELECT key, size, etag, version, uploaded, http_metadata, custom_metadata, checksums FROM r2_objects WHERE bucket = ? AND key = ?`,
			)
			.get(this.bucket, key)
	}

	async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | R2Object | null> {
		const row = this.getRow(key)
		if (!row) return null

		const meta = rowToMeta(row)

		// Check conditional
		if (options?.onlyIf) {
			if (!evaluateConditional(options.onlyIf, meta.etag, meta.uploaded)) {
				// Return R2Object (metadata only, no body) when condition fails
				return new R2Object(meta)
			}
		}

		const totalSize = row.size
		let offset = 0
		let length = totalSize
		if (options?.range) {
			const range = options.range
			if (range.suffix !== undefined) {
				offset = Math.max(0, totalSize - range.suffix)
				length = totalSize - offset
			} else {
				offset = range.offset ?? 0
				length = range.length ?? totalSize - offset
				if (offset + length > totalSize) length = totalSize - offset
			}
			meta.range = { offset, length }
		}

		return new R2ObjectBody(meta, this.filePath(key), offset, length, totalSize)
	}

	async head(key: string): Promise<R2Object | null> {
		const row = this.getRow(key)
		if (!row) return null
		return new R2Object(rowToMeta(row))
	}

	async delete(key: string | string[]) {
		const keys = Array.isArray(key) ? key : [key]
		if (keys.length > this.limits.maxBatchDeleteKeys) {
			throw new Error(`Cannot delete more than ${this.limits.maxBatchDeleteKeys} keys at once`)
		}
		for (const k of keys) {
			this.db.run(`DELETE FROM r2_objects WHERE bucket = ? AND key = ?`, [this.bucket, k])
			const fp = this.filePath(k)
			if (existsSync(fp)) {
				rmSync(fp)
			}
		}
	}

	async list(options?: R2ListOptions) {
		const prefix = options?.prefix ?? ''
		const limit = options?.limit ?? 1000
		const delimiter = options?.delimiter
		const include = options?.include
		const cursorOffset = options?.cursor ? parseInt(options.cursor, 10) : 0

		const rows = this.db
			.query<R2Row, [string, string, number, number]>(
				`SELECT key, size, etag, version, uploaded, http_metadata, custom_metadata, checksums
         FROM r2_objects WHERE bucket = ? AND key LIKE ? ORDER BY key LIMIT ? OFFSET ?`,
			)
			.all(this.bucket, prefix + '%', limit + 1, cursorOffset)

		if (delimiter) {
			// With delimiter: group keys by delimiter, return delimitedPrefixes
			const prefixLen = prefix.length
			const delimitedPrefixes = new Set<string>()
			const objects: R2Object[] = []

			for (const row of rows.slice(0, limit)) {
				const rest = row.key.slice(prefixLen)
				const delimIdx = rest.indexOf(delimiter)
				if (delimIdx !== -1) {
					delimitedPrefixes.add(prefix + rest.slice(0, delimIdx + delimiter.length))
				} else {
					const meta = rowToMeta(row)
					objects.push(buildListObject(meta, include))
				}
			}

			const truncated = rows.length > limit
			return {
				objects,
				truncated,
				cursor: truncated ? String(cursorOffset + limit) : '',
				delimitedPrefixes: [...delimitedPrefixes].sort(),
			}
		}

		const truncated = rows.length > limit
		const resultRows = truncated ? rows.slice(0, limit) : rows
		const objects = resultRows.map((row) => {
			const meta = rowToMeta(row)
			return buildListObject(meta, include)
		})

		return {
			objects,
			truncated,
			cursor: truncated ? String(cursorOffset + limit) : '',
			delimitedPrefixes: [] as string[],
		}
	}

	async createMultipartUpload(
		key: string,
		options?: { httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> },
	): Promise<R2MultipartUpload> {
		this.validateKey(key)
		this.validateCustomMetadata(options?.customMetadata)

		const uploadId = crypto.randomUUID()
		this.db.run(
			`INSERT INTO r2_multipart_uploads (upload_id, bucket, key, http_metadata, custom_metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
			[
				uploadId,
				this.bucket,
				key,
				serializeHttpMetadata(options?.httpMetadata),
				options?.customMetadata ? JSON.stringify(options.customMetadata) : null,
				new Date().toISOString(),
			],
		)

		return new R2MultipartUpload(this.db, this.bucket, this.baseDir, key, uploadId, this.limits)
	}

	resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload {
		return new R2MultipartUpload(this.db, this.bucket, this.baseDir, key, uploadId, this.limits)
	}

	/** List in-progress multipart uploads in this bucket (used by S3 ListMultipartUploads). */
	listMultipartUploads(prefix?: string): Array<{ key: string; uploadId: string; initiated: Date }> {
		interface Row {
			upload_id: string
			key: string
			created_at: string
		}
		const rows = prefix
			? this.db
				.query<Row, [string, string]>(
					`SELECT upload_id, key, created_at FROM r2_multipart_uploads WHERE bucket = ? AND key LIKE ? ORDER BY key`,
				)
				.all(this.bucket, prefix + '%')
			: this.db
				.query<Row, [string]>(
					`SELECT upload_id, key, created_at FROM r2_multipart_uploads WHERE bucket = ? ORDER BY key`,
				)
				.all(this.bucket)
		return rows.map((r) => ({ key: r.key, uploadId: r.upload_id, initiated: new Date(r.created_at) }))
	}
}

function buildListObject(meta: R2ObjectMeta, include?: ('httpMetadata' | 'customMetadata')[]): R2Object {
	if (include) {
		// Only include requested metadata
		const filtered: R2ObjectMeta = {
			...meta,
			httpMetadata: include.includes('httpMetadata') ? meta.httpMetadata : {},
			customMetadata: include.includes('customMetadata') ? meta.customMetadata : {},
		}
		return new R2Object(filtered)
	}
	// By default, include both
	return new R2Object(meta)
}
