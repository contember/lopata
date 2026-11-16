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
	onlyIf?: R2Conditional | Headers
	range?: R2Range | Headers
}

export interface R2PutOptions {
	httpMetadata?: R2HTTPMetadata
	customMetadata?: Record<string, string>
	onlyIf?: R2Conditional | Headers
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
	startAfter?: string
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

	constructor(meta: R2ObjectMeta, filePath: string, range: { offset: number; length: number }) {
		super({ ...meta, range })
		this.filePath = filePath
		this.rangeOffset = range.offset
		this.rangeLength = range.length
	}

	private isFullFile(): boolean {
		return this.rangeOffset === 0 && this.rangeLength === this.size
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

// --- Errors ---

// workerd surfaces R2 errors as a plain Error with "<method>: <message> (<v4 code>)".
function r2Error(method: string, code: number, message: string): Error {
	return new Error(`${method}: ${message} (${code})`)
}

const INVALID_RANGE = [10039, 'The requested range is not satisfiable'] as const
const INVALID_MAX_KEYS = [10022, 'MaxKeys params must be positive integer <= 1000.'] as const

const MAX_LIST_KEYS = 1000

// --- Conditional check ---

type R2Etag = { type: 'strong' | 'weak'; value: string } | { type: 'wildcard' }

interface ParsedConditional {
	etagMatches?: R2Etag[]
	etagDoesNotMatch?: R2Etag[]
	uploadedBefore?: Date
	uploadedAfter?: Date
	secondsGranularity: boolean
}

function parseConditional(onlyIf: R2Conditional | Headers): ParsedConditional {
	if (onlyIf instanceof Headers) {
		const cond: ParsedConditional = { secondsGranularity: true }
		const ifMatch = onlyIf.get('if-match')
		if (ifMatch !== null) {
			cond.etagMatches = parseEtagHeader(ifMatch)
			if (cond.etagMatches.length === 0) throw new Error('Invalid ETag in if-match header')
		}
		const ifNoneMatch = onlyIf.get('if-none-match')
		if (ifNoneMatch !== null) {
			cond.etagDoesNotMatch = parseEtagHeader(ifNoneMatch)
			if (cond.etagDoesNotMatch.length === 0) throw new Error('Invalid ETag in if-none-match header')
		}
		const ifModifiedSince = onlyIf.get('if-modified-since')
		if (ifModifiedSince !== null) cond.uploadedAfter = parseHttpDate(ifModifiedSince)
		const ifUnmodifiedSince = onlyIf.get('if-unmodified-since')
		if (ifUnmodifiedSince !== null) cond.uploadedBefore = parseHttpDate(ifUnmodifiedSince)
		return cond
	}
	return {
		etagMatches: onlyIf.etagMatches === undefined ? undefined : etagList(onlyIf.etagMatches),
		etagDoesNotMatch: onlyIf.etagDoesNotMatch === undefined ? undefined : etagList(onlyIf.etagDoesNotMatch),
		uploadedBefore: onlyIf.uploadedBefore,
		uploadedAfter: onlyIf.uploadedAfter,
		secondsGranularity: false,
	}
}

function etagList(value: string | string[]): R2Etag[] {
	return (Array.isArray(value) ? value : [value]).map((v) => v === '*' ? { type: 'wildcard' } : { type: 'strong', value: v.replace(/^"(.*)"$/, '$1') })
}

const ETAG_HEADER_ITEM = /^\s*(?:(\*)|(W\/)?"([^"]*)")\s*(?:,|$)/

/** Parses an If-Match / If-None-Match list (workerd parseConditionalEtagHeader in api/r2-bucket.c++). */
function parseEtagHeader(header: string): R2Etag[] {
	const etags: R2Etag[] = []
	let rest = header
	while (true) {
		rest = rest.replace(/^[\s,]+/, '')
		if (rest === '') return etags
		const m = ETAG_HEADER_ITEM.exec(rest)
		if (!m) throw new Error('Invalid conditional header')
		if (m[1] !== undefined) return [{ type: 'wildcard' }]
		etags.push({ type: m[2] === undefined ? 'strong' : 'weak', value: m[3] ?? '' })
		rest = rest.slice(m[0].length)
	}
}

function parseHttpDate(value: string): Date {
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid date: ${value}`)
	return date
}

function includesEtag(conditions: R2Etag[], etag: string, comparison: 'strong' | 'weak'): boolean {
	for (const condition of conditions) {
		if (condition.type === 'wildcard') return true
		if (condition.value === etag && (condition.type === 'strong' || comparison === 'weak')) return true
	}
	return false
}

/**
 * RFC 7232 precondition evaluation as R2 does it (Miniflare _testR2Conditional in
 * workers/r2/validator.worker.ts): a passing etag check overrides the date check it pairs with.
 */
function testConditional(cond: ParsedConditional, object: { etag: string; uploaded: Date } | null): boolean {
	if (object === null) return cond.etagMatches === undefined && cond.uploadedAfter === undefined

	const truncate = (ms: number) => cond.secondsGranularity ? Math.floor(ms / 1000) * 1000 : ms
	const lastModified = truncate(object.uploaded.getTime())
	const ifMatch = cond.etagMatches === undefined || includesEtag(cond.etagMatches, object.etag, 'strong')
	const ifNoneMatch = cond.etagDoesNotMatch === undefined || !includesEtag(cond.etagDoesNotMatch, object.etag, 'weak')
	const ifModifiedSince = cond.uploadedAfter === undefined
		|| truncate(cond.uploadedAfter.getTime()) < lastModified
		|| (cond.etagDoesNotMatch !== undefined && ifNoneMatch)
	const ifUnmodifiedSince = cond.uploadedBefore === undefined
		|| lastModified < truncate(cond.uploadedBefore.getTime())
		|| (cond.etagMatches !== undefined && ifMatch)
	return ifMatch && ifNoneMatch && ifModifiedSince && ifUnmodifiedSince
}

// --- Range ---

/** Rejects malformed range objects before any I/O, as workerd does in initGetOptions (api/r2-bucket.c++). */
function checkRangeArgument(range: R2Range): void {
	for (const field of ['offset', 'length', 'suffix'] as const) {
		const v = range[field]
		if (v === undefined) continue
		if (v < 0) throw new RangeError(`Invalid range. ${field} (${v}) must be greater than or equal to 0.`)
		if (!Number.isInteger(v)) throw new RangeError(`Invalid range. ${field} (${v}) must be an integer, not floating point.`)
	}
	if (range.suffix !== undefined && range.offset !== undefined) throw new TypeError('Suffix is incompatible with offset.')
	if (range.suffix !== undefined && range.length !== undefined) throw new TypeError('Suffix is incompatible with length.')
}

/**
 * Resolves a get() range against the object size (Miniflare Validator.range in
 * workers/r2/validator.worker.ts). A Range header that is absent, invalid or names several
 * ranges yields the whole object; an unsatisfiable range object throws.
 */
function resolveRange(range: R2Range | Headers | undefined, size: number): { offset: number; length: number } {
	const whole = { offset: 0, length: size }
	if (range === undefined) return whole
	if (range instanceof Headers) {
		const header = range.get('range')
		return header === null ? whole : (parseRangeHeader(header, size) ?? whole)
	}
	let { offset, length } = range
	if (range.suffix !== undefined) {
		if (range.suffix <= 0) throw r2Error('get', ...INVALID_RANGE)
		length = Math.min(range.suffix, size)
		offset = size - length
	}
	offset ??= 0
	length ??= size - offset
	if (offset > size || length <= 0) throw r2Error('get', ...INVALID_RANGE)
	return { offset, length: Math.min(length, size - offset) }
}

/** Single-range `bytes=` header (Miniflare parseRanges in workers/shared/range.ts); null means "whole object". */
function parseRangeHeader(header: string, size: number): { offset: number; length: number } | null {
	const prefix = /^ *bytes *=/i.exec(header)
	if (!prefix) return null
	const specs = header.slice(prefix[0].length).split(',')
	if (specs.length !== 1) return null
	const m = /^ *(\d+)? *- *(\d+)? *$/.exec(specs[0] ?? '')
	if (!m) return null
	const [, start, end] = m
	if (start !== undefined) {
		const first = Number(start)
		const last = end === undefined ? size - 1 : Math.min(Number(end), size - 1)
		if (first >= size || (end !== undefined && first > Number(end))) return null
		return { offset: first, length: last - first + 1 }
	}
	if (end === undefined) return null
	const suffix = Number(end)
	if (suffix === 0 || suffix >= size) return null
	return { offset: size - suffix, length: suffix }
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
		try {
			this.db.run(`ALTER TABLE r2_objects ADD COLUMN tags TEXT`)
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
			const cond = parseConditional(options.onlyIf)
			const existing = this.getRow(key)
			if (existing && !testConditional(cond, rowToMeta(existing))) {
				return null
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
		const cond = options?.onlyIf === undefined ? undefined : parseConditional(options.onlyIf)
		if (options?.range !== undefined && !(options.range instanceof Headers)) checkRangeArgument(options.range)

		const row = this.getRow(key)
		if (!row) return null
		const meta = rowToMeta(row)

		// A failed precondition yields the metadata without a body
		if (cond && !testConditional(cond, meta)) {
			return new R2Object({ ...meta, range: { offset: 0, length: meta.size } })
		}

		return new R2ObjectBody(meta, this.filePath(key), resolveRange(options?.range, meta.size))
	}

	async head(key: string): Promise<R2Object | null> {
		const row = this.getRow(key)
		if (!row) return null
		const meta = rowToMeta(row)
		return new R2Object({ ...meta, range: { offset: 0, length: meta.size } })
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
		const limit = options?.limit ?? MAX_LIST_KEYS
		if (limit < 1 || limit > MAX_LIST_KEYS) throw r2Error('list', ...INVALID_MAX_KEYS)
		const include = parseListInclude(options?.include)
		const params = {
			$bucket: this.bucket,
			$prefix: options?.prefix ?? '',
			$startAfter: options?.startAfter ?? null,
			// The cursor is the base64 of the last returned key, so keys inserted while paginating are still listed
			$cursorKey: options?.cursor ? Buffer.from(options.cursor, 'base64').toString('utf8') : null,
			// One extra row tells whether the listing is truncated
			$limit: limit + 1,
		}
		const filter = `bucket = $bucket AND substr(key, 1, length($prefix)) = $prefix
			AND ($startAfter IS NULL OR key > $startAfter) AND ($cursorKey IS NULL OR key > $cursorKey)`

		const objects: R2Object[] = []
		const delimitedPrefixes: string[] = []
		let lastKey: string | undefined
		let truncated: boolean
		if (options?.delimiter) {
			// Keys sharing a delimited prefix collapse into one row (counted once towards the limit);
			// its max(key) becomes the cursor so the next page skips the rest of that prefix.
			// Adapted from Miniflare workers/r2/bucket.worker.ts (listMetadata).
			const rows = this.db
				.query<Omit<R2Row, 'key'> & { last_key: string; delimited_prefix: string | null }, Record<string, string | number | null>>(
					`SELECT max(key) AS last_key,
						iif(instr(substr(key, length($prefix) + 1), $delimiter),
							substr(key, 1, length($prefix) + instr(substr(key, length($prefix) + 1), $delimiter) + length($delimiter) - 1),
							NULL) AS delimited_prefix,
						size, etag, version, uploaded, http_metadata, custom_metadata, checksums
					FROM r2_objects WHERE ${filter}
					GROUP BY coalesce('p:' || delimited_prefix, 'k:' || key)
					ORDER BY last_key LIMIT $limit`,
				)
				.all({ ...params, $delimiter: options.delimiter })
			truncated = rows.length > limit
			for (const row of rows.slice(0, limit)) {
				if (row.delimited_prefix === null) objects.push(buildListObject(rowToMeta({ ...row, key: row.last_key }), include))
				else delimitedPrefixes.push(row.delimited_prefix)
				lastKey = row.last_key
			}
		} else {
			const rows = this.db
				.query<R2Row, Record<string, string | number | null>>(
					`SELECT key, size, etag, version, uploaded, http_metadata, custom_metadata, checksums
					FROM r2_objects WHERE ${filter} ORDER BY key LIMIT $limit`,
				)
				.all(params)
			truncated = rows.length > limit
			for (const row of rows.slice(0, limit)) {
				objects.push(buildListObject(rowToMeta(row), include))
				lastKey = row.key
			}
		}

		return {
			objects,
			truncated,
			cursor: truncated && lastKey !== undefined ? Buffer.from(lastKey, 'utf8').toString('base64') : '',
			delimitedPrefixes,
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

	/** Read tags for a key. Returns [] if the object has no tags or doesn't exist. */
	getTags(key: string): Array<{ key: string; value: string }> {
		const row = this.db
			.query<{ tags: string | null }, [string, string]>(
				`SELECT tags FROM r2_objects WHERE bucket = ? AND key = ?`,
			)
			.get(this.bucket, key)
		if (!row?.tags) return []
		return JSON.parse(row.tags) as Array<{ key: string; value: string }>
	}

	/** Replace an object's tag set. No-op if the object does not exist. */
	setTags(key: string, tags: Array<{ key: string; value: string }>): void {
		const serialized = tags.length === 0 ? null : JSON.stringify(tags)
		this.db.run(`UPDATE r2_objects SET tags = ? WHERE bucket = ? AND key = ?`, [
			serialized,
			this.bucket,
			key,
		])
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

type ListInclude = { httpMetadata: boolean; customMetadata: boolean }

function parseListInclude(include: R2ListOptions['include']): ListInclude {
	const result = { httpMetadata: false, customMetadata: false }
	for (const field of include ?? []) {
		if (field !== 'httpMetadata' && field !== 'customMetadata') throw new RangeError(`Unsupported include value ${field}`)
		result[field] = true
	}
	return result
}

/** Metadata is omitted unless requested, as under r2_list_honor_include (default since 2022-08-04). */
function buildListObject(meta: R2ObjectMeta, include: ListInclude): R2Object {
	return new R2Object({
		...meta,
		httpMetadata: include.httpMetadata ? meta.httpMetadata : {},
		customMetadata: include.customMetadata ? meta.customMetadata : {},
	})
}
