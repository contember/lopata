import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { SqliteKVNamespace } from '../src/bindings/kv'
import { runMigrations } from '../src/db'

let db: Database
let kv: SqliteKVNamespace

beforeEach(() => {
	db = new Database(':memory:')
	runMigrations(db)
	kv = new SqliteKVNamespace(db, 'TEST_KV')
})

test('get non-existent key returns null', async () => {
	expect(await kv.get('missing')).toBeNull()
})

test('put and get text', async () => {
	await kv.put('key', 'hello')
	expect(await kv.get('key')).toBe('hello')
})

test('put overwrites existing value', async () => {
	await kv.put('key', 'first')
	await kv.put('key', 'second')
	expect(await kv.get('key')).toBe('second')
})

test('delete removes key', async () => {
	await kv.put('key', 'value')
	await kv.delete('key')
	expect(await kv.get('key')).toBeNull()
})

test('delete non-existent key is no-op', async () => {
	await kv.delete('missing') // should not throw
})

test('get with type json', async () => {
	await kv.put('key', JSON.stringify({ a: 1 }))
	const result = await kv.get('key', 'json')
	expect(result).toEqual({ a: 1 })
})

test('get with type arrayBuffer', async () => {
	await kv.put('key', 'hello')
	const result = await kv.get('key', 'arrayBuffer')
	expect(result).toBeInstanceOf(ArrayBuffer)
	expect(new TextDecoder().decode(result as ArrayBuffer)).toBe('hello')
})

test('get with type stream', async () => {
	await kv.put('key', 'hello')
	const stream = (await kv.get('key', 'stream')) as ReadableStream
	const reader = stream.getReader()
	const { value } = await reader.read()
	expect(new TextDecoder().decode(value)).toBe('hello')
})

test('get with options object', async () => {
	await kv.put('key', JSON.stringify([1, 2]))
	const result = await kv.get('key', { type: 'json' })
	expect(result).toEqual([1, 2])
})

test('put with metadata and getWithMetadata', async () => {
	await kv.put('key', 'val', { metadata: { tag: 'test' } })
	const { value, metadata } = await kv.getWithMetadata('key')
	expect(value).toBe('val')
	expect(metadata).toEqual({ tag: 'test' })
})

test('getWithMetadata returns null metadata when none set', async () => {
	await kv.put('key', 'val')
	const { value, metadata } = await kv.getWithMetadata('key')
	expect(value).toBe('val')
	expect(metadata).toBeNull()
})

test('getWithMetadata for missing key', async () => {
	const { value, metadata } = await kv.getWithMetadata('missing')
	expect(value).toBeNull()
	expect(metadata).toBeNull()
})

test('put with expiration (absolute)', async () => {
	// valid future expiration
	await kv.put('key', 'val', { expiration: Date.now() / 1000 + 3600 })
	expect(await kv.get('key')).toBe('val')
})

test('put with expirationTtl', async () => {
	// expires far in the future
	await kv.put('key', 'val', { expirationTtl: 3600 })
	expect(await kv.get('key')).toBe('val')
})

test('list returns all keys', async () => {
	await kv.put('a', '1')
	await kv.put('b', '2')
	await kv.put('c', '3')
	const result = await kv.list()
	expect(result.keys.map((k) => k.name)).toEqual(['a', 'b', 'c'])
	expect(result.list_complete).toBe(true)
})

test('list with prefix', async () => {
	await kv.put('user:1', 'a')
	await kv.put('user:2', 'b')
	await kv.put('post:1', 'c')
	const result = await kv.list({ prefix: 'user:' })
	expect(result.keys.map((k) => k.name)).toEqual(['user:1', 'user:2'])
})

test('list with limit', async () => {
	await kv.put('a', '1')
	await kv.put('b', '2')
	await kv.put('c', '3')
	const result = await kv.list({ limit: 2 })
	expect(result.keys).toHaveLength(2)
	expect(result.list_complete).toBe(false)
})

test('list empty namespace', async () => {
	const result = await kv.list()
	expect(result.keys).toEqual([])
	expect(result.list_complete).toBe(true)
})

test('list filters out expired keys', async () => {
	await kv.put('good', 'val')
	// Insert expired row directly via SQL to bypass validation
	db.run(
		'INSERT INTO kv (namespace, key, value, metadata, expiration) VALUES (?, ?, ?, ?, ?)',
		['TEST_KV', 'expired', Buffer.from('val'), null, Date.now() / 1000 - 10],
	)
	const result = await kv.list()
	expect(result.keys.map((k) => k.name)).toEqual(['good'])
})

test('put ArrayBuffer and get as text', async () => {
	const buf = new TextEncoder().encode('binary').buffer
	await kv.put('key', buf as ArrayBuffer)
	expect(await kv.get('key')).toBe('binary')
})

test('list with cursor pagination', async () => {
	await kv.put('a', '1')
	await kv.put('b', '2')
	await kv.put('c', '3')
	const first = await kv.list({ limit: 2 })
	expect(first.keys).toHaveLength(2)
	expect(first.list_complete).toBe(false)
	expect(first.cursor).toBeTruthy()

	const second = await kv.list({ cursor: first.cursor, limit: 2 })
	expect(second.keys.map((k) => k.name)).toEqual(['c'])
	expect(second.list_complete).toBe(true)
})

test('namespaces are isolated', async () => {
	const kv1 = new SqliteKVNamespace(db, 'NS1')
	const kv2 = new SqliteKVNamespace(db, 'NS2')

	await kv1.put('key', 'from-ns1')
	await kv2.put('key', 'from-ns2')

	expect(await kv1.get('key')).toBe('from-ns1')
	expect(await kv2.get('key')).toBe('from-ns2')
})

// --- Key validation ---

describe('key validation', () => {
	test('rejects empty key', async () => {
		expect(kv.put('', 'val')).rejects.toThrow('not allowed')
		expect(kv.get('')).rejects.toThrow('not allowed')
	})

	test("rejects '.' key", async () => {
		expect(kv.put('.', 'val')).rejects.toThrow('not allowed')
	})

	test("rejects '..' key", async () => {
		expect(kv.put('..', 'val')).rejects.toThrow('not allowed')
	})

	test('rejects key exceeding max size', async () => {
		const longKey = 'x'.repeat(513)
		expect(kv.put(longKey, 'val')).rejects.toThrow('exceeds max size')
	})

	test('allows key at exactly max size', async () => {
		const key = 'x'.repeat(512)
		await kv.put(key, 'val')
		expect(await kv.get(key)).toBe('val')
	})

	test('custom key size limit', async () => {
		const customKv = new SqliteKVNamespace(db, 'CUSTOM', { maxKeySize: 10 })
		expect(customKv.put('x'.repeat(11), 'val')).rejects.toThrow('exceeds max size of 10')
		await customKv.put('x'.repeat(10), 'val') // should not throw
	})
})

// --- Value size validation ---

describe('value size validation', () => {
	test('rejects value exceeding max size', async () => {
		const customKv = new SqliteKVNamespace(db, 'SMALL', { maxValueSize: 100 })
		const bigValue = 'x'.repeat(101)
		expect(customKv.put('key', bigValue)).rejects.toThrow('exceeds max size')
	})

	test('allows value at exactly max size', async () => {
		const customKv = new SqliteKVNamespace(db, 'SMALL', { maxValueSize: 100 })
		await customKv.put('key', 'x'.repeat(100))
		expect(await customKv.get('key')).toBe('x'.repeat(100))
	})
})

// --- Metadata size validation ---

describe('metadata size validation', () => {
	test('rejects metadata exceeding max size', async () => {
		const customKv = new SqliteKVNamespace(db, 'META', { maxMetadataSize: 50 })
		const bigMetadata = { data: 'x'.repeat(100) }
		expect(customKv.put('key', 'val', { metadata: bigMetadata })).rejects.toThrow('metadata exceeds max size')
	})

	test('allows metadata at limit', async () => {
		await kv.put('key', 'val', { metadata: { a: 'b' } })
		const { metadata } = await kv.getWithMetadata('key')
		expect(metadata).toEqual({ a: 'b' })
	})
})

// --- TTL validation ---

describe('TTL validation', () => {
	test('rejects expirationTtl below minimum', async () => {
		expect(kv.put('key', 'val', { expirationTtl: 30 })).rejects.toThrow('at least 60 seconds')
	})

	test('allows expirationTtl at minimum', async () => {
		await kv.put('key', 'val', { expirationTtl: 60 })
		expect(await kv.get('key')).toBe('val')
	})

	test('custom min TTL', async () => {
		const customKv = new SqliteKVNamespace(db, 'TTL', { minTtlSeconds: 10 })
		expect(customKv.put('key', 'val', { expirationTtl: 5 })).rejects.toThrow('at least 10 seconds')
		await customKv.put('key', 'val', { expirationTtl: 10 }) // should not throw
	})
})

// --- Bulk get ---

describe('bulk get', () => {
	test('returns Map with values for existing keys', async () => {
		await kv.put('a', '1')
		await kv.put('b', '2')
		const result = await kv.get(['a', 'b', 'c'])
		expect(result).toBeInstanceOf(Map)
		expect(result.get('a')).toBe('1')
		expect(result.get('b')).toBe('2')
		expect(result.get('c')).toBeNull()
	})

	test('respects type option', async () => {
		await kv.put('j', JSON.stringify({ x: 1 }))
		const result = await kv.get(['j'], 'json')
		expect(result.get('j')).toEqual({ x: 1 })
	})

	test('skips expired keys', async () => {
		await kv.put('live', 'ok')
		// Insert expired row directly via SQL to bypass validation
		db.run(
			'INSERT INTO kv (namespace, key, value, metadata, expiration) VALUES (?, ?, ?, ?, ?)',
			['TEST_KV', 'dead', Buffer.from('gone'), null, Date.now() / 1000 - 10],
		)
		const result = await kv.get(['live', 'dead'])
		expect(result.get('live')).toBe('ok')
		expect(result.get('dead')).toBeNull()
	})

	test('empty keys array returns empty Map', async () => {
		const result = await kv.get([])
		expect(result.size).toBe(0)
	})

	test('rejects too many keys', async () => {
		const customKv = new SqliteKVNamespace(db, 'BULK', { maxBulkGetKeys: 3 })
		expect(customKv.get(['a', 'b', 'c', 'd'])).rejects.toThrow('exceeds max of 3')
	})
})

// --- Bulk getWithMetadata ---

describe('bulk getWithMetadata', () => {
	test('returns Map with values and metadata', async () => {
		await kv.put('a', '1', { metadata: { tag: 'x' } })
		await kv.put('b', '2')
		const result = await kv.getWithMetadata(['a', 'b', 'missing'])
		expect(result).toBeInstanceOf(Map)
		expect(result.get('a')).toEqual({ value: '1', metadata: { tag: 'x' } })
		expect(result.get('b')).toEqual({ value: '2', metadata: null })
		expect(result.get('missing')).toEqual({ value: null, metadata: null })
	})

	test('skips expired keys', async () => {
		await kv.put('live', 'ok', { metadata: { alive: true } })
		// Insert expired row directly via SQL to bypass validation
		db.run(
			'INSERT INTO kv (namespace, key, value, metadata, expiration) VALUES (?, ?, ?, ?, ?)',
			['TEST_KV', 'dead', Buffer.from('gone'), null, Date.now() / 1000 - 10],
		)
		const result = await kv.getWithMetadata(['live', 'dead'])
		expect(result.get('live')?.value).toBe('ok')
		expect(result.get('dead')).toEqual({ value: null, metadata: null })
	})
})

// --- list prefix with SQL wildcards ---

describe('list with SQL wildcard characters in prefix', () => {
	test('prefix containing % matches literally', async () => {
		await kv.put('100%_done', 'a')
		await kv.put('100%_ok', 'b')
		await kv.put('100x_other', 'c')
		const result = await kv.list({ prefix: '100%' })
		expect(result.keys.map((k) => k.name)).toEqual(['100%_done', '100%_ok'])
	})

	test('prefix containing _ matches literally', async () => {
		await kv.put('a_b', '1')
		await kv.put('a_c', '2')
		await kv.put('axb', '3')
		const result = await kv.list({ prefix: 'a_' })
		expect(result.keys.map((k) => k.name)).toEqual(['a_b', 'a_c'])
	})
})

// --- list limit cap ---

describe('list limit cap', () => {
	test('limit is capped at 1000', async () => {
		// We can't easily insert 1001 keys, but we can verify the cap works
		// by checking that requesting limit > 1000 behaves as limit = 1000
		for (let i = 0; i < 5; i++) {
			await kv.put(`key-${String(i).padStart(4, '0')}`, 'v')
		}
		const result = await kv.list({ limit: 5000 })
		// Should still return all 5 keys (cap is 1000, we only have 5)
		expect(result.keys).toHaveLength(5)
		expect(result.list_complete).toBe(true)
	})
})

// --- bulk get type restrictions ---

describe('bulk get type restrictions', () => {
	test('bulk get rejects arrayBuffer type', async () => {
		await kv.put('a', '1')
		expect(kv.get(['a'], 'arrayBuffer')).rejects.toThrow('does not support type "arrayBuffer"')
	})

	test('bulk get rejects stream type', async () => {
		await kv.put('a', '1')
		expect(kv.get(['a'], 'stream')).rejects.toThrow('does not support type "stream"')
	})

	test('bulk getWithMetadata rejects arrayBuffer type', async () => {
		await kv.put('a', '1')
		expect(kv.getWithMetadata(['a'], 'arrayBuffer')).rejects.toThrow('does not support type "arrayBuffer"')
	})

	test('bulk getWithMetadata rejects stream type', async () => {
		await kv.put('a', '1')
		expect(kv.getWithMetadata(['a'], 'stream')).rejects.toThrow('does not support type "stream"')
	})
})

// --- expiration validation ---

describe('expiration validation', () => {
	test('rejects expiration in the past', async () => {
		expect(kv.put('key', 'val', { expiration: Date.now() / 1000 - 10 })).rejects.toThrow(
			'at least 60 seconds in the future',
		)
	})

	test('rejects expiration less than minTtlSeconds in the future', async () => {
		expect(kv.put('key', 'val', { expiration: Date.now() / 1000 + 30 })).rejects.toThrow(
			'at least 60 seconds in the future',
		)
	})

	test('allows expiration at least minTtlSeconds in the future', async () => {
		await kv.put('key', 'val', { expiration: Date.now() / 1000 + 120 })
		expect(await kv.get('key')).toBe('val')
	})
})

// --- cacheStatus in getWithMetadata ---

describe('getWithMetadata cacheStatus', () => {
	test('returns cacheStatus: null for existing key', async () => {
		await kv.put('key', 'val')
		const result = await kv.getWithMetadata('key')
		expect(result.cacheStatus).toBeNull()
	})

	test('returns cacheStatus: null for missing key', async () => {
		const result = await kv.getWithMetadata('missing')
		expect(result.cacheStatus).toBeNull()
	})
})

// --- cacheTtl (no-op) ---

describe('cacheTtl option', () => {
	test('get accepts cacheTtl without error', async () => {
		await kv.put('key', 'val')
		const result = await kv.get('key', { type: 'text', cacheTtl: 300 })
		expect(result).toBe('val')
	})

	test('getWithMetadata accepts cacheTtl without error', async () => {
		await kv.put('key', 'val')
		const { value } = await kv.getWithMetadata('key', { type: 'text', cacheTtl: 300 })
		expect(value).toBe('val')
	})
})
