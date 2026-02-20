import type { Database } from 'bun:sqlite'

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

export class SqliteKVNamespace {
	private db: Database
	private namespace: string
	private limits: Required<KVLimits>

	constructor(db: Database, namespace: string, limits?: KVLimits) {
		this.db = db
		this.namespace = namespace
		this.limits = { ...KV_DEFAULTS, ...limits }
	}

	private validateKey(key: string): void {
		if (key === '' || key === '.' || key === '..') {
			throw new Error(`KV key "${key}" is not allowed`)
		}
		if (new TextEncoder().encode(key).byteLength > this.limits.maxKeySize) {
			throw new Error(`KV key exceeds max size of ${this.limits.maxKeySize} bytes`)
		}
	}

	private validateValue(blob: Buffer): void {
		if (blob.byteLength > this.limits.maxValueSize) {
			throw new Error(`KV value exceeds max size of ${this.limits.maxValueSize} bytes`)
		}
	}

	private validateMetadata(metadata: unknown): string {
		const serialized = JSON.stringify(metadata)
		if (new TextEncoder().encode(serialized).byteLength > this.limits.maxMetadataSize) {
			throw new Error(`KV metadata exceeds max size of ${this.limits.maxMetadataSize} bytes`)
		}
		return serialized
	}

	private validateTtl(ttl: number): void {
		if (ttl < this.limits.minTtlSeconds) {
			throw new Error(`KV expirationTtl must be at least ${this.limits.minTtlSeconds} seconds`)
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

		this.validateKey(keyOrKeys)

		const row = this.db.query<{ value: Buffer; metadata: string | null; expiration: number | null }, [string, string]>(
			'SELECT value, metadata, expiration FROM kv WHERE namespace = ? AND key = ?',
		).get(this.namespace, keyOrKeys)

		if (!row) return null

		if (row.expiration && row.expiration < Date.now() / 1000) {
			this.db.run('DELETE FROM kv WHERE namespace = ? AND key = ?', [this.namespace, keyOrKeys])
			return null
		}

		const type = typeof options === 'string' ? options : options?.type ?? 'text'
		return this.decodeValue(row.value, type)
	}

	private async bulkGet(
		keys: string[],
		options?: string | KVGetOptions,
	): Promise<Map<string, string | ArrayBuffer | object | ReadableStream | null>> {
		if (keys.length > this.limits.maxBulkGetKeys) {
			throw new Error(`KV bulk get exceeds max of ${this.limits.maxBulkGetKeys} keys`)
		}
		for (const key of keys) {
			this.validateKey(key)
		}

		const result = new Map<string, string | ArrayBuffer | object | ReadableStream | null>()
		const type = typeof options === 'string' ? options : options?.type ?? 'text'
		if (type === 'arrayBuffer' || type === 'stream') {
			throw new Error(`KV bulk get does not support type "${type}"`)
		}
		const now = Date.now() / 1000

		if (keys.length === 0) return result

		const placeholders = keys.map(() => '?').join(', ')
		const rows = this.db.query<
			{ key: string; value: Buffer; expiration: number | null },
			[string, ...string[]]
		>(
			`SELECT key, value, expiration FROM kv WHERE namespace = ? AND key IN (${placeholders})`,
		).all(this.namespace, ...keys)

		const rowMap = new Map<string, { value: Buffer; expiration: number | null }>()
		for (const row of rows) {
			if (row.expiration && row.expiration < now) {
				this.db.run('DELETE FROM kv WHERE namespace = ? AND key = ?', [this.namespace, row.key])
			} else {
				rowMap.set(row.key, row)
			}
		}

		for (const key of keys) {
			const row = rowMap.get(key)
			result.set(key, row ? this.decodeValue(row.value, type) : null)
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
	): Promise<Map<string, { value: string | ArrayBuffer | object | ReadableStream | null; metadata: unknown }>>
	async getWithMetadata(
		keyOrKeys: string | string[],
		options?: string | KVGetOptions,
	): Promise<
		| { value: string | ArrayBuffer | object | ReadableStream | null; metadata: unknown; cacheStatus: null }
		| Map<string, { value: string | ArrayBuffer | object | ReadableStream | null; metadata: unknown }>
	> {
		if (Array.isArray(keyOrKeys)) {
			return this.bulkGetWithMetadata(keyOrKeys, options)
		}

		this.validateKey(keyOrKeys)

		const row = this.db.query<{ value: Buffer; metadata: string | null; expiration: number | null }, [string, string]>(
			'SELECT value, metadata, expiration FROM kv WHERE namespace = ? AND key = ?',
		).get(this.namespace, keyOrKeys)

		if (!row) return { value: null, metadata: null, cacheStatus: null }

		if (row.expiration && row.expiration < Date.now() / 1000) {
			this.db.run('DELETE FROM kv WHERE namespace = ? AND key = ?', [this.namespace, keyOrKeys])
			return { value: null, metadata: null, cacheStatus: null }
		}

		const type = typeof options === 'string' ? options : options?.type ?? 'text'
		const value = this.decodeValue(row.value, type)
		const metadata = row.metadata ? JSON.parse(row.metadata) : null
		return { value, metadata, cacheStatus: null }
	}

	private async bulkGetWithMetadata(
		keys: string[],
		options?: string | KVGetOptions,
	): Promise<Map<string, { value: string | ArrayBuffer | object | ReadableStream | null; metadata: unknown }>> {
		if (keys.length > this.limits.maxBulkGetKeys) {
			throw new Error(`KV bulk get exceeds max of ${this.limits.maxBulkGetKeys} keys`)
		}
		for (const key of keys) {
			this.validateKey(key)
		}

		const result = new Map<string, { value: string | ArrayBuffer | object | ReadableStream | null; metadata: unknown }>()
		const type = typeof options === 'string' ? options : options?.type ?? 'text'
		if (type === 'arrayBuffer' || type === 'stream') {
			throw new Error(`KV bulk get does not support type "${type}"`)
		}
		const now = Date.now() / 1000

		if (keys.length === 0) return result

		const placeholders = keys.map(() => '?').join(', ')
		const rows = this.db.query<
			{ key: string; value: Buffer; metadata: string | null; expiration: number | null },
			[string, ...string[]]
		>(
			`SELECT key, value, metadata, expiration FROM kv WHERE namespace = ? AND key IN (${placeholders})`,
		).all(this.namespace, ...keys)

		const rowMap = new Map<string, { value: Buffer; metadata: string | null; expiration: number | null }>()
		for (const row of rows) {
			if (row.expiration && row.expiration < now) {
				this.db.run('DELETE FROM kv WHERE namespace = ? AND key = ?', [this.namespace, row.key])
			} else {
				rowMap.set(row.key, row)
			}
		}

		for (const key of keys) {
			const row = rowMap.get(key)
			if (row) {
				result.set(key, {
					value: this.decodeValue(row.value, type),
					metadata: row.metadata ? JSON.parse(row.metadata) : null,
				})
			} else {
				result.set(key, { value: null, metadata: null })
			}
		}

		return result
	}

	async put(
		key: string,
		value: string | ArrayBuffer | ReadableStream,
		options?: { metadata?: unknown; expirationTtl?: number; expiration?: number },
	) {
		this.validateKey(key)
		const blob = await this.encodeValue(value)
		this.validateValue(blob)

		if (options?.expirationTtl !== undefined) {
			this.validateTtl(options.expirationTtl)
		}
		if (options?.expiration !== undefined) {
			const minExpiration = Date.now() / 1000 + this.limits.minTtlSeconds
			if (options.expiration < minExpiration) {
				throw new Error(`KV expiration must be at least ${this.limits.minTtlSeconds} seconds in the future`)
			}
		}

		let expiration: number | null = null
		if (options?.expiration) expiration = options.expiration
		else if (options?.expirationTtl) expiration = Date.now() / 1000 + options.expirationTtl

		let metadata: string | null = null
		if (options?.metadata !== undefined) {
			metadata = this.validateMetadata(options.metadata)
		}

		this.db.run(
			'INSERT OR REPLACE INTO kv (namespace, key, value, metadata, expiration) VALUES (?, ?, ?, ?, ?)',
			[this.namespace, key, blob, metadata, expiration],
		)
	}

	async delete(key: string) {
		this.db.run('DELETE FROM kv WHERE namespace = ? AND key = ?', [this.namespace, key])
	}

	async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
		const prefix = options?.prefix ?? ''
		const limit = Math.min(options?.limit ?? 1000, 1000)
		const cursor = options?.cursor ?? ''

		const now = Date.now() / 1000

		// Lazily delete expired entries for this namespace
		this.db.run(
			'DELETE FROM kv WHERE namespace = ? AND expiration IS NOT NULL AND expiration < ?',
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

		const listComplete = rows.length <= limit
		const resultRows = rows.slice(0, limit)

		const keys = resultRows.map((row) => ({
			name: row.key,
			expiration: row.expiration ?? undefined,
			metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
		}))

		const lastRow = resultRows[resultRows.length - 1]
		const newCursor = listComplete || !lastRow ? '' : lastRow.key

		return { keys, list_complete: listComplete, cursor: newCursor }
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
			return new ReadableStream({
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
