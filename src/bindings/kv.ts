import type { Database } from 'bun:sqlite'
import type { Clock } from '../testing/clock'
import { realClock } from '../testing/clock'
import { NativeReadableStream } from './cf-streams'

export interface KVLimits {
	maxKeySize?: number // default 512 (bytes)
	maxValueSize?: number // default 25 * 1024 * 1024 (25 MiB)
	maxMetadataSize?: number // default 1024 (bytes)
	minTtlSeconds?: number // default 60
	maxBulkGetKeys?: number // default 100
}

const KV_DEFAULTS: Required<KVLimits> = {
	maxKeySize: 512,
	maxValueSize: 25 * 1024 * 1024,
	maxMetadataSize: 1024,
	minTtlSeconds: 60,
	maxBulkGetKeys: 100,
}

type KVGetOptions = { type?: string; cacheTtl?: number }

const MIN_CACHE_TTL_SECONDS = 30
const MAX_LIST_KEYS = 1000

// workerd declares cacheTtl, expiration, expirationTtl and list limit as `int`; this is its conversion
function toWorkerdInt(value: number): number {
	const number = Number(value)
	if (!Number.isFinite(number)) return 0
	if (number > 2147483647 || number < -2147483648) {
		throw new TypeError('Value out of range. Must be between -2147483648 and 2147483647 (inclusive).')
	}
	return Math.trunc(number)
}

type KVMethod = 'GET' | 'GET_BULK' | 'PUT' | 'DELETE'

// workerd surfaces a non-2xx response from the KV service as `Error: KV <METHOD> failed: <status> <statusText>`
function kvError(method: KVMethod, status: number, message: string): Error {
	return new Error(`KV ${method} failed: ${status} ${message}`)
}

type KVListKey = { name: string; expiration?: number; metadata?: unknown }
type KVListResult =
	| { keys: KVListKey[]; list_complete: false; cursor: string; cacheStatus: null }
	| { keys: KVListKey[]; list_complete: true; cacheStatus: null }

export class SqliteKVNamespace {
	private db: Database
	private namespace: string
	private limits: Required<KVLimits>
	private clock: Clock

	constructor(db: Database, namespace: string, limits?: KVLimits, clock?: Clock) {
		this.db = db
		this.namespace = namespace
		this.limits = { ...KV_DEFAULTS, ...limits }
		this.clock = clock ?? realClock
	}

	// Single-key operations check the name in workerd itself, before any request is made
	private validateKey(method: KVMethod, key: string): void {
		if (key === '') {
			throw new TypeError('Key name cannot be empty.')
		}
		if (key === '.' || key === '..') {
			throw new TypeError(`"${key}" is not allowed as a key name.`)
		}
		this.validateKeyLength(method, key)
	}

	// Bulk get sends the names unchecked; the KV service rejects them with its own messages
	private validateBulkKey(key: string): void {
		if (key === '') {
			throw kvError('GET_BULK', 400, 'Key names must not be empty')
		}
		if (key === '.' || key === '..') {
			throw kvError('GET_BULK', 400, `Illegal key name "${key}". Please use a different name.`)
		}
		this.validateKeyLength('GET_BULK', key)
	}

	private validateKeyLength(method: KVMethod, key: string): void {
		const length = Buffer.byteLength(key)
		if (length > this.limits.maxKeySize) {
			throw kvError(method, 414, `UTF-8 encoded length of ${length} exceeds key length limit of ${this.limits.maxKeySize}.`)
		}
	}

	private validateCacheTtl(method: KVMethod, options: string | KVGetOptions | undefined): void {
		if (typeof options !== 'object' || options.cacheTtl === undefined) return
		const cacheTtl = toWorkerdInt(options.cacheTtl)
		if (cacheTtl < MIN_CACHE_TTL_SECONDS) {
			throw kvError(method, 400, `Invalid cache_ttl of ${cacheTtl}. Cache TTL must be at least ${MIN_CACHE_TTL_SECONDS}.`)
		}
	}

	private validateBulkGet(keys: string[], options: string | KVGetOptions | undefined): string {
		// workerd sends `type` only when it is non-empty, so '' reads as text.
		const type = (typeof options === 'string' ? options : options?.type) || 'text'
		if (type !== 'text' && type !== 'json') {
			throw kvError('GET_BULK', 400, `"${type}" is not a valid type. Use "json" or "text"`)
		}
		if (keys.length > this.limits.maxBulkGetKeys) {
			throw kvError('GET_BULK', 400, `You can request a maximum of ${this.limits.maxBulkGetKeys} keys`)
		}
		if (keys.length < 1) {
			throw kvError('GET_BULK', 400, 'You must request a minimum of 1 key')
		}
		for (const key of keys) {
			this.validateBulkKey(key)
		}
		this.validateCacheTtl('GET_BULK', options)
		return type
	}

	private validateBulkSize(rows: Iterable<{ value: Buffer }>): void {
		let totalBytes = 0
		for (const row of rows) totalBytes += row.value.byteLength
		const limit = this.limits.maxValueSize
		if (totalBytes > limit) {
			throw kvError('GET_BULK', 413, `Total size of request exceeds the limit of ${limit / 1024 / 1024}MB`)
		}
	}

	private validateValue(blob: Buffer): void {
		if (blob.byteLength > this.limits.maxValueSize) {
			throw kvError('PUT', 413, `Value length of ${blob.byteLength} exceeds limit of ${this.limits.maxValueSize}.`)
		}
	}

	private validateMetadata(metadata: unknown): string | null {
		// A function or symbol has no JSON form; store no metadata, as lopata did before size checks were added.
		const serialized: string | undefined = JSON.stringify(metadata)
		if (serialized === undefined) return null
		const length = Buffer.byteLength(serialized)
		if (length > this.limits.maxMetadataSize) {
			throw kvError('PUT', 413, `Metadata length of ${length} exceeds limit of ${this.limits.maxMetadataSize}.`)
		}
		return serialized
	}

	private resolveExpiration(options: { expirationTtl?: number; expiration?: number } | undefined): number | null {
		const now = Math.floor(this.clock.now() / 1000)
		const minTtl = this.limits.minTtlSeconds
		if (options?.expirationTtl !== undefined) {
			const ttl = toWorkerdInt(options.expirationTtl)
			if (ttl <= 0) {
				throw kvError('PUT', 400, `Invalid expiration_ttl of ${ttl}. Please specify integer greater than 0.`)
			}
			if (ttl < minTtl) {
				throw kvError('PUT', 400, `Invalid expiration_ttl of ${ttl}. Expiration TTL must be at least ${minTtl}.`)
			}
			return now + ttl
		}
		if (options?.expiration !== undefined) {
			const expiration = toWorkerdInt(options.expiration)
			if (expiration <= now) {
				throw kvError(
					'PUT',
					400,
					`Invalid expiration of ${expiration}. Please specify integer greater than the current number of seconds since the UNIX epoch.`,
				)
			}
			if (expiration < now + minTtl) {
				throw kvError('PUT', 400, `Invalid expiration of ${expiration}. Expiration times must be at least ${minTtl} seconds in the future.`)
			}
			return expiration
		}
		return null
	}

	private decodeBulkValue(blob: Buffer, type: string): string | ArrayBuffer | object | ReadableStream {
		try {
			return this.decodeValue(blob, type)
		} catch {
			throw kvError('GET_BULK', 400, `At least one of the requested keys corresponds to a non-${type} value`)
		}
	}

	async get(key: string, options?: string | KVGetOptions): Promise<string | ArrayBuffer | object | ReadableStream | null>
	async get(keys: string[], options?: string | KVGetOptions): Promise<Map<string, string | ArrayBuffer | object | ReadableStream | null>>
	async get(
		keyOrKeys: string | string[],
		options?: string | KVGetOptions,
	): Promise<string | ArrayBuffer | object | ReadableStream | null | Map<string, string | ArrayBuffer | object | ReadableStream | null>> {
		if (Array.isArray(keyOrKeys)) {
			return this.bulkGet(keyOrKeys, options)
		}

		this.validateKey('GET', keyOrKeys)
		this.validateCacheTtl('GET', options)

		const row = this.db.query<{ value: Buffer; metadata: string | null; expiration: number | null }, [string, string]>(
			'SELECT value, metadata, expiration FROM kv WHERE namespace = ? AND key = ?',
		).get(this.namespace, keyOrKeys)

		if (!row) return null

		if (row.expiration && row.expiration <= this.clock.now() / 1000) {
			this.db.run('DELETE FROM kv WHERE namespace = ? AND key = ?', [this.namespace, keyOrKeys])
			return null
		}

		// workerd sends `type` only when it is non-empty, so '' reads as text.
		const type = (typeof options === 'string' ? options : options?.type) || 'text'
		return this.decodeValue(row.value, type)
	}

	private async bulkGet(
		keys: string[],
		options?: string | KVGetOptions,
	): Promise<Map<string, string | ArrayBuffer | object | ReadableStream | null>> {
		const type = this.validateBulkGet(keys, options)

		const result = new Map<string, string | ArrayBuffer | object | ReadableStream | null>()
		const now = this.clock.now() / 1000

		const placeholders = keys.map(() => '?').join(', ')
		const rows = this.db.query<
			{ key: string; value: Buffer; expiration: number | null },
			[string, ...string[]]
		>(
			`SELECT key, value, expiration FROM kv WHERE namespace = ? AND key IN (${placeholders})`,
		).all(this.namespace, ...keys)

		const rowMap = new Map<string, { value: Buffer; expiration: number | null }>()
		for (const row of rows) {
			if (row.expiration && row.expiration <= now) {
				this.db.run('DELETE FROM kv WHERE namespace = ? AND key = ?', [this.namespace, row.key])
			} else {
				rowMap.set(row.key, row)
			}
		}

		this.validateBulkSize(rowMap.values())
		for (const key of keys) {
			const row = rowMap.get(key)
			result.set(key, row ? this.decodeBulkValue(row.value, type) : null)
		}

		return result
	}

	async getWithMetadata(
		key: string,
		options?: string | KVGetOptions,
	): Promise<{ value: string | ArrayBuffer | object | ReadableStream | null; metadata: unknown; cacheStatus: null }>
	async getWithMetadata(
		keys: string[],
		options?: string | KVGetOptions,
	): Promise<Map<string, { value: string | ArrayBuffer | object | ReadableStream; metadata: unknown } | null>>
	async getWithMetadata(
		keyOrKeys: string | string[],
		options?: string | KVGetOptions,
	): Promise<
		| { value: string | ArrayBuffer | object | ReadableStream | null; metadata: unknown; cacheStatus: null }
		| Map<string, { value: string | ArrayBuffer | object | ReadableStream; metadata: unknown } | null>
	> {
		if (Array.isArray(keyOrKeys)) {
			return this.bulkGetWithMetadata(keyOrKeys, options)
		}

		this.validateKey('GET', keyOrKeys)
		this.validateCacheTtl('GET', options)

		const row = this.db.query<{ value: Buffer; metadata: string | null; expiration: number | null }, [string, string]>(
			'SELECT value, metadata, expiration FROM kv WHERE namespace = ? AND key = ?',
		).get(this.namespace, keyOrKeys)

		if (!row) return { value: null, metadata: null, cacheStatus: null }

		if (row.expiration && row.expiration <= this.clock.now() / 1000) {
			this.db.run('DELETE FROM kv WHERE namespace = ? AND key = ?', [this.namespace, keyOrKeys])
			return { value: null, metadata: null, cacheStatus: null }
		}

		// workerd sends `type` only when it is non-empty, so '' reads as text.
		const type = (typeof options === 'string' ? options : options?.type) || 'text'
		const value = this.decodeValue(row.value, type)
		const metadata = row.metadata ? JSON.parse(row.metadata) : null
		return { value, metadata, cacheStatus: null }
	}

	private async bulkGetWithMetadata(
		keys: string[],
		options?: string | KVGetOptions,
	): Promise<Map<string, { value: string | ArrayBuffer | object | ReadableStream; metadata: unknown } | null>> {
		const type = this.validateBulkGet(keys, options)

		const result = new Map<string, { value: string | ArrayBuffer | object | ReadableStream; metadata: unknown } | null>()
		const now = this.clock.now() / 1000

		const placeholders = keys.map(() => '?').join(', ')
		const rows = this.db.query<
			{ key: string; value: Buffer; metadata: string | null; expiration: number | null },
			[string, ...string[]]
		>(
			`SELECT key, value, metadata, expiration FROM kv WHERE namespace = ? AND key IN (${placeholders})`,
		).all(this.namespace, ...keys)

		const rowMap = new Map<string, { value: Buffer; metadata: string | null; expiration: number | null }>()
		for (const row of rows) {
			if (row.expiration && row.expiration <= now) {
				this.db.run('DELETE FROM kv WHERE namespace = ? AND key = ?', [this.namespace, row.key])
			} else {
				rowMap.set(row.key, row)
			}
		}

		this.validateBulkSize(rowMap.values())
		for (const key of keys) {
			const row = rowMap.get(key)
			if (row) {
				result.set(key, {
					value: this.decodeBulkValue(row.value, type),
					metadata: row.metadata ? JSON.parse(row.metadata) : null,
				})
			} else {
				result.set(key, null)
			}
		}

		return result
	}

	async put(
		key: string,
		value: string | ArrayBuffer | ReadableStream,
		options?: { metadata?: unknown; expirationTtl?: number; expiration?: number },
	) {
		this.validateKey('PUT', key)
		const expiration = this.resolveExpiration(options)
		const metadata = options?.metadata === undefined ? null : this.validateMetadata(options.metadata)
		const blob = await this.encodeValue(value)
		this.validateValue(blob)

		this.db.run(
			'INSERT OR REPLACE INTO kv (namespace, key, value, metadata, expiration) VALUES (?, ?, ?, ?, ?)',
			[this.namespace, key, blob, metadata, expiration],
		)
	}

	async delete(key: string) {
		this.validateKey('DELETE', key)
		this.db.run('DELETE FROM kv WHERE namespace = ? AND key = ?', [this.namespace, key])
	}

	async list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<KVListResult> {
		const prefix = options?.prefix ?? ''
		this.validateKeyLength('GET', prefix)
		// workerd sends the limit only when it is positive; the service rejects one above its maximum
		const requestedLimit = options?.limit === undefined ? 0 : toWorkerdInt(options.limit)
		if (requestedLimit > MAX_LIST_KEYS) {
			throw kvError('GET', 400, `Invalid key_count_limit of ${requestedLimit}. Please specify an integer less than ${MAX_LIST_KEYS}.`)
		}
		const limit = requestedLimit > 0 ? requestedLimit : MAX_LIST_KEYS
		const cursor = options?.cursor ?? ''

		const now = this.clock.now() / 1000

		// Lazily delete expired entries for this namespace
		this.db.run(
			'DELETE FROM kv WHERE namespace = ? AND expiration IS NOT NULL AND expiration <= ?',
			[this.namespace, now],
		)

		let rows: { key: string; expiration: number | null; metadata: string | null }[]

		// Use range query instead of LIKE to avoid SQL wildcard injection (% and _ in prefix)
		const prefixEnd = prefix.length > 0
			? prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
			: ''

		if (prefix) {
			if (cursor) {
				rows = this.db.query<
					{ key: string; expiration: number | null; metadata: string | null },
					[string, string, string, string, number]
				>(
					'SELECT key, expiration, metadata FROM kv WHERE namespace = ? AND key >= ? AND key < ? AND key > ? ORDER BY key LIMIT ?',
				).all(this.namespace, prefix, prefixEnd, cursor, limit + 1)
			} else {
				rows = this.db.query<
					{ key: string; expiration: number | null; metadata: string | null },
					[string, string, string, number]
				>(
					'SELECT key, expiration, metadata FROM kv WHERE namespace = ? AND key >= ? AND key < ? ORDER BY key LIMIT ?',
				).all(this.namespace, prefix, prefixEnd, limit + 1)
			}
		} else {
			if (cursor) {
				rows = this.db.query<
					{ key: string; expiration: number | null; metadata: string | null },
					[string, string, number]
				>(
					'SELECT key, expiration, metadata FROM kv WHERE namespace = ? AND key > ? ORDER BY key LIMIT ?',
				).all(this.namespace, cursor, limit + 1)
			} else {
				rows = this.db.query<
					{ key: string; expiration: number | null; metadata: string | null },
					[string, number]
				>(
					'SELECT key, expiration, metadata FROM kv WHERE namespace = ? ORDER BY key LIMIT ?',
				).all(this.namespace, limit + 1)
			}
		}

		const resultRows = rows.slice(0, limit)
		// Absent fields are omitted, as in the JSON workerd parses the list from
		const keys = resultRows.map((row) => {
			const key: KVListKey = { name: row.key }
			if (row.expiration !== null) key.expiration = row.expiration
			if (row.metadata !== null) key.metadata = JSON.parse(row.metadata)
			return key
		})

		const lastRow = resultRows[resultRows.length - 1]
		if (rows.length > limit && lastRow) {
			return { keys, list_complete: false, cursor: lastRow.key, cacheStatus: null }
		}
		return { keys, list_complete: true, cacheStatus: null }
	}

	private decodeValue(blob: Buffer, type: string): string | ArrayBuffer | object | ReadableStream {
		if (type === 'json') {
			return JSON.parse(Buffer.from(blob).toString())
		}
		if (type === 'arrayBuffer') {
			const buf = Buffer.from(blob)
			return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
		}
		if (type === 'stream') {
			const buf = Buffer.from(blob)
			return new NativeReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array(buf))
					controller.close()
				},
			})
		}
		// text
		return Buffer.from(blob).toString()
	}

	private async encodeValue(value: string | ArrayBuffer | ReadableStream): Promise<Buffer> {
		if (typeof value === 'string') {
			return Buffer.from(value)
		}
		if (value instanceof ArrayBuffer) {
			return Buffer.from(value)
		}
		// ReadableStream
		const chunks: Uint8Array[] = []
		const reader = value.getReader()
		while (true) {
			const { done, value: chunk } = await reader.read()
			if (done) break
			chunks.push(chunk)
		}
		return Buffer.concat(chunks)
	}
}
