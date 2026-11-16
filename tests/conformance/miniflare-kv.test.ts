// Adapted from workers-sdk packages/miniflare/test/plugins/kv/index.spec.ts at 6ee18e1bd (MIT OR Apache-2.0, Cloudflare, Inc.)
// Excluded: "persists in-memory between options reloads" (Miniflare setOptions), "persists on file-system" (kvPersist option),
// "migrates database to new location" (Miniflare storage layout), "sticky blobs never deleted" (Miniflare blob store).

import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect } from 'bun:test'
import assert from 'node:assert'
import { SqliteKVNamespace } from '../../src/bindings/kv'
import { runMigrations } from '../../src/db'
import { TestClock } from '../../src/testing/clock'
import { conformanceTest, loadKnownFailures } from './harness'

const known = loadKnownFailures('miniflare-kv')

function secondsToMillis(seconds: number): number {
	return seconds * 1000
}

// Time in seconds the fake `Date.now()` always returns
const TIME_NOW = 1000
// Expiration value to signal a key that will expire in the future
const TIME_FUTURE = 1500
const MAX_BULK_GET_KEYS = 100
// Miniflare lowers the value size limit to 1 KiB while being tested
const MAX_VALUE_SIZE_TEST_BYTES = 1024

// Every test gets a fresh database, so keys are not namespaced (Miniflare's `ns` is always '').
let kv: SqliteKVNamespace
let clock: TestClock

beforeEach(() => {
	const db = new Database(':memory:')
	runMigrations(db)
	clock = new TestClock(secondsToMillis(TIME_NOW))
	kv = new SqliteKVNamespace(db, 'namespace', { maxValueSize: MAX_VALUE_SIZE_TEST_BYTES }, clock)
})

function messageOf(error: unknown): unknown {
	return error instanceof Error ? error.message : error
}

function createJunkStream(length: number): ReadableStream<Uint8Array> {
	let position = 0
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			const chunkLength = Math.min(1024, length - position)
			if (chunkLength === 0) {
				controller.close()
				return
			}
			controller.enqueue(new Uint8Array(chunkLength).fill(120)) // 'x'
			position += chunkLength
		},
	})
}

async function testValidatesKey(opts: {
	method: string
	f: (kv: SqliteKVNamespace, key: string) => Promise<void>
}) {
	await expect(opts.f(kv, '')).rejects.toThrow(
		new TypeError('Key name cannot be empty.'),
	)
	await expect(opts.f(kv, '.')).rejects.toThrow(
		new TypeError('"." is not allowed as a key name.'),
	)
	await expect(opts.f(kv, '..')).rejects.toThrow(
		new TypeError('".." is not allowed as a key name.'),
	)
	await expect(opts.f(kv, ''.padStart(513, 'x'))).rejects.toThrow(
		new Error(
			`KV ${opts.method.toUpperCase()} failed: 414 UTF-8 encoded length of 513 exceeds key length limit of 512.`,
		),
	)
}

type ListedKey = { name: string; expiration?: number; metadata?: unknown }

async function testList(opts: {
	values: Record<string, { value: string; expiration?: number; metadata?: unknown }>
	options?: { prefix?: string; limit?: number; cursor?: string }
	pages: ListedKey[][]
}) {
	for (const [key, value] of Object.entries(opts.values)) {
		await kv.put(key, value.value, {
			expiration: value.expiration,
			metadata: value.metadata,
		})
	}

	const options = opts.options ?? {}
	let lastCursor = ''
	for (const [i, expectedPage] of opts.pages.entries()) {
		const result = await kv.list({
			prefix: options.prefix ?? '',
			limit: options.limit,
			cursor: options.cursor ?? lastCursor,
		})
		expect<unknown>(result.keys).toEqual(expectedPage)
		if (i === opts.pages.length - 1) {
			// Last Page
			assert(result.list_complete && !('cursor' in result))
			lastCursor = ''
		} else {
			assert(!result.list_complete && typeof result.cursor === 'string')
			lastCursor = result.cursor
		}
	}
}

describe('kv', () => {
	conformanceTest(known, 'get: validates key', async () => {
		await testValidatesKey({
			method: 'get',
			f: async (kv, key) => {
				await kv.get(key)
			},
		})
	})
	conformanceTest(known, 'get: returns value', async () => {
		await kv.put('key', 'value')
		const result = await kv.get('key')
		expect(result).toBe('value')
	})

	conformanceTest(known, 'bulk get: returns value', async () => {
		await kv.put('key1', 'value1')
		const result = await kv.get(['key1', 'key2'])
		const expectedResult = new Map([
			['key1', 'value1'],
			['key2', null],
		])

		expect(result).toEqual(expectedResult)
	})

	conformanceTest(known, 'bulk get: check max keys', async () => {
		await kv.put('key1', 'value1')
		const keyArray = []
		for (let i = 0; i <= MAX_BULK_GET_KEYS; i++) {
			keyArray.push(`key${i}`)
		}
		try {
			await kv.get(keyArray)
		} catch (error) {
			expect(messageOf(error)).toBe(
				'KV GET_BULK failed: 400 You can request a maximum of 100 keys',
			)
		}
	})

	conformanceTest(known, 'bulk get: check minimum keys', async () => {
		await expect(kv.get([])).rejects.toThrow(
			new Error('KV GET_BULK failed: 400 You must request a minimum of 1 key'),
		)
	})

	conformanceTest(known, 'bulk get: invalid type', async () => {
		await expect(kv.get(['key'], { type: 'invalid' })).rejects.toThrow(
			new Error('KV GET_BULK failed: 400 "invalid" is not a valid type. Use "json" or "text"'),
		)
	})

	conformanceTest(known, 'bulk get: request json type', async () => {
		await kv.put('key1', '{"example": "ex"}')
		await kv.put('key2', 'example')
		let result: unknown = await kv.get(['key1'])
		let expectedResult: unknown = new Map([['key1', '{"example": "ex"}']])
		expectedResult = new Map([['key1', '{"example": "ex"}']])
		expect(result).toEqual(expectedResult)

		result = await kv.get(['key1'], 'json')
		expectedResult = new Map([['key1', { example: 'ex' }]])
		expect(result).toEqual(expectedResult)

		try {
			await kv.get(['key1', 'key2'], 'json')
		} catch (error) {
			expect(messageOf(error)).toBe(
				'KV GET_BULK failed: 400 At least one of the requested keys corresponds to a non-json value',
			)
		}
	})

	conformanceTest(known, 'bulk get: check metadata', async () => {
		await kv.put('key1', 'value1', {
			expiration: TIME_FUTURE,
			metadata: { testing: true },
		})

		await kv.put('key2', 'value2')
		const result = await kv.getWithMetadata(['key1', 'key2'])
		const expectedResult = new Map([
			['key1', { value: 'value1', metadata: { testing: true } }],
			['key2', { value: 'value2', metadata: null }],
		])
		expect(result).toEqual(expectedResult)
	})

	conformanceTest(known, 'bulk get: check metadata with int', async () => {
		await kv.put('key1', 'value1', {
			expiration: TIME_FUTURE,
			metadata: 123,
		})

		const result = await kv.getWithMetadata(['key1'])
		const expectedResult = new Map([
			['key1', { value: 'value1', metadata: 123 }],
		])
		expect(result).toEqual(expectedResult)
	})

	conformanceTest(known, 'bulk get: check metadata as string', async () => {
		await kv.put('key1', 'value1', {
			expiration: TIME_FUTURE,
			metadata: 'example',
		})
		const result = await kv.getWithMetadata(['key1'])
		const expectedResult = new Map([
			['key1', { value: 'value1', metadata: 'example' }],
		])
		expect(result).toEqual(expectedResult)
	})

	conformanceTest(known, 'bulk get: get with metadata for 404', async () => {
		const result = await kv.getWithMetadata(['key1'])
		const expectedResult = new Map([['key1', null]])
		expect<unknown>(result).toEqual(expectedResult)
	})

	conformanceTest(known, 'bulk get: get over size limit', async () => {
		const bigValue = new Array(1024).fill('x').join('')
		await kv.put('key1', bigValue)
		await kv.put('key2', bigValue)
		await expect(kv.getWithMetadata(['key1', 'key2'])).rejects.toThrow(
			new Error('KV GET_BULK failed: 413 Total size of request exceeds the limit of 0.0009765625MB'), // 1024 Bytes for testing
		)
	})

	conformanceTest(known, 'get: returns null for non-existent keys', async () => {
		expect(await kv.get('key')).toBe(null)
	})
	conformanceTest(known, 'get: returns null for expired keys', async () => {
		await kv.put('key', 'value', { expirationTtl: 60 })
		expect(await kv.get('key')).not.toBe(null)
		clock.advance(60_000)
		expect(await kv.get('key')).toBe(null)
	})
	conformanceTest(known, 'get: validates but ignores cache ttl', async () => {
		await kv.put('key', 'value')
		await expect(
			// @ts-expect-error invalid argument on purpose
			kv.get('key', { cacheTtl: 'not a number' }),
		).rejects.toThrow(
			new Error(
				'KV GET failed: 400 Invalid cache_ttl of 0. Cache TTL must be at least 30.',
			),
		)
		await expect(kv.get('key', { cacheTtl: 10 })).rejects.toThrow(
			new Error(
				'KV GET failed: 400 Invalid cache_ttl of 10. Cache TTL must be at least 30.',
			),
		)
		expect(await kv.get('key', { cacheTtl: 30 })).toBeDefined()
		expect(await kv.get('key', { cacheTtl: 60 })).toBeDefined()
	})

	conformanceTest(known, 'put: validates key', async () => {
		await testValidatesKey({
			method: 'put',
			f: async (kv, key) => {
				await kv.put(key, 'value')
			},
		})
	})
	conformanceTest(known, 'put: puts value', async () => {
		await kv.put('key', 'value', {
			expiration: TIME_FUTURE,
			metadata: { testing: true },
		})
		const result = await kv.getWithMetadata('key')
		expect(result.value).toBe('value')
		expect(result.metadata).toEqual({ testing: true })
		// Check expiration set too
		const results = await kv.list({ prefix: '' })
		expect(results.keys[0]?.expiration).toBe(TIME_FUTURE)
	})
	conformanceTest(known, 'put: puts empty value', async () => {
		// https://github.com/cloudflare/miniflare/issues/703
		await kv.put('key', '')
		const value = await kv.get('key')
		expect(value).toBe('')
	})
	// The original also checks that Miniflare's blob store dropped the old blob; only the observable part is kept.
	conformanceTest(known, 'put: overrides existing keys', async () => {
		await kv.put('key', 'value1')
		await kv.put('key', 'value2', {
			expiration: TIME_FUTURE,
			metadata: { testing: true },
		})
		const result = await kv.getWithMetadata('key')
		expect(result.value).toBe('value2')
		expect(result.metadata).toEqual({ testing: true })
	})
	conformanceTest(known, 'put: keys are case-sensitive', async () => {
		await kv.put('key', 'lower')
		await kv.put('KEY', 'upper')
		let result = await kv.get('key')
		expect(result).toBe('lower')
		result = await kv.get('KEY')
		expect(result).toBe('upper')
	})
	conformanceTest(known, 'put: validates expiration ttl', async () => {
		await expect(
			// @ts-expect-error invalid argument on purpose
			kv.put('key', 'value', { expirationTtl: 'nan' }),
		).rejects.toThrow(
			new Error(
				'KV PUT failed: 400 Invalid expiration_ttl of 0. Please specify integer greater than 0.',
			),
		)
		await expect(kv.put('key', 'value', { expirationTtl: 0 })).rejects.toThrow(
			new Error(
				'KV PUT failed: 400 Invalid expiration_ttl of 0. Please specify integer greater than 0.',
			),
		)
		await expect(kv.put('key', 'value', { expirationTtl: 30 })).rejects.toThrow(
			new Error(
				'KV PUT failed: 400 Invalid expiration_ttl of 30. Expiration TTL must be at least 60.',
			),
		)
	})
	conformanceTest(known, 'put: validates expiration', async () => {
		await expect(
			// @ts-expect-error invalid argument on purpose
			kv.put('key', 'value', { expiration: 'nan' }),
		).rejects.toThrow(
			new Error(
				'KV PUT failed: 400 Invalid expiration of 0. Please specify integer greater than the current number of seconds since the UNIX epoch.',
			),
		)
		await expect(
			kv.put('key', 'value', { expiration: TIME_NOW }),
		).rejects.toThrow(
			new Error(
				`KV PUT failed: 400 Invalid expiration of ${TIME_NOW}. Please specify integer greater than the current number of seconds since the UNIX epoch.`,
			),
		)
		await expect(
			kv.put('key', 'value', { expiration: TIME_NOW + 30 }),
		).rejects.toThrow(
			new Error(
				`KV PUT failed: 400 Invalid expiration of ${TIME_NOW + 30}. Expiration times must be at least 60 seconds in the future.`,
			),
		)
	})
	conformanceTest(known, 'put: validates value size', async () => {
		const maxValueSize = 1024
		const byteLength = maxValueSize + 1
		// Check with and without `valueLengthHint`
		await expect(kv.put('key', createJunkStream(byteLength))).rejects.toThrow(
			new Error(
				`KV PUT failed: 413 Value length of ${byteLength} exceeds limit of ${maxValueSize}.`,
			),
		)
		// Check 1 less byte is accepted
		await kv.put('key', createJunkStream(byteLength - 1))
	})
	conformanceTest(known, 'put: validates metadata size', async () => {
		const maxMetadataSize = 1024
		await expect(
			kv.put('key', new Blob(['value']).stream(), {
				metadata: {
					key: ''.padStart(maxMetadataSize - `{"key":""}`.length + 1, 'x'),
				},
			}),
		).rejects.toThrow(
			new Error(
				`KV PUT failed: 413 Metadata length of ${maxMetadataSize + 1} exceeds limit of ${maxMetadataSize}.`,
			),
		)
	})

	conformanceTest(known, 'delete: validates key', async () => {
		await testValidatesKey({
			method: 'delete',
			f: async (kv, key) => {
				await kv.delete(key)
			},
		})
	})
	conformanceTest(known, 'delete: deletes existing keys', async () => {
		await kv.put('key', 'value')
		expect(await kv.get('key')).not.toBe(null)
		await kv.delete('key')
		expect(await kv.get('key')).toBe(null)
	})
	conformanceTest(known, 'delete: does nothing for non-existent keys', async () => {
		await kv.delete('key')
	})

	conformanceTest(known, 'list: lists keys in sorted order', async () => {
		await testList({
			values: {
				key3: { value: 'value3' },
				key1: { value: 'value1' },
				key2: { value: 'value2' },
			},
			pages: [[{ name: 'key1' }, { name: 'key2' }, { name: 'key3' }]],
		})
	})
	conformanceTest(known, 'list: lists keys matching prefix', async () => {
		await testList({
			values: {
				section1key1: { value: 'value11' },
				section1key2: { value: 'value12' },
				section2key1: { value: 'value21' },
			},
			options: { prefix: 'section1' },
			pages: [[{ name: 'section1key1' }, { name: 'section1key2' }]],
		})
	})
	conformanceTest(known, 'list: prefix is case-sensitive', async () => {
		await testList({
			values: {
				key1: { value: 'lower1' },
				key2: { value: 'lower2 ' },
				KEY1: { value: 'upper1' },
				KEY2: { value: 'upper2' },
			},
			options: { prefix: 'KEY' },
			pages: [[{ name: 'KEY1' }, { name: 'KEY2' }]],
		})
	})
	conformanceTest(known, 'list: prefix permits special characters', async () => {
		await testList({
			values: {
				'key\\_%1': { value: 'value1' },
				'key\\a': { value: 'bad1' },
				'key\\_%2': { value: 'value2' },
				'key\\bbb': { value: 'bad2' },
				'key\\_%3': { value: 'value3' },
			},
			options: { prefix: 'key\\_%' },
			pages: [[{ name: 'key\\_%1' }, { name: 'key\\_%2' }, { name: 'key\\_%3' }]],
		})
	})
	conformanceTest(known, 'list: lists keys with expiration', async () => {
		await testList({
			values: {
				key1: { value: 'value1', expiration: TIME_FUTURE },
				key2: { value: 'value2', expiration: TIME_FUTURE + 100 },
				key3: { value: 'value3', expiration: TIME_FUTURE + 200 },
			},
			pages: [
				[
					{ name: 'key1', expiration: TIME_FUTURE },
					{ name: 'key2', expiration: TIME_FUTURE + 100 },
					{ name: 'key3', expiration: TIME_FUTURE + 200 },
				],
			],
		})
	})
	conformanceTest(known, 'list: lists keys with metadata', async () => {
		await testList({
			values: {
				key1: { value: 'value1', metadata: { testing: 1 } },
				key2: { value: 'value2', metadata: { testing: 2 } },
				key3: { value: 'value3', metadata: { testing: 3 } },
			},
			pages: [
				[
					{ name: 'key1', metadata: { testing: 1 } },
					{ name: 'key2', metadata: { testing: 2 } },
					{ name: 'key3', metadata: { testing: 3 } },
				],
			],
		})
	})
	conformanceTest(known, 'list: lists keys with expiration and metadata', async () => {
		await testList({
			values: {
				key1: {
					value: 'value1',
					expiration: TIME_FUTURE,
					metadata: { testing: 1 },
				},
				key2: {
					value: 'value2',
					expiration: TIME_FUTURE + 100,
					metadata: { testing: 2 },
				},
				key3: {
					value: 'value3',
					expiration: TIME_FUTURE + 200,
					metadata: { testing: 3 },
				},
			},
			pages: [
				[
					{
						name: 'key1',
						expiration: TIME_FUTURE,
						metadata: { testing: 1 },
					},
					{
						name: 'key2',
						expiration: TIME_FUTURE + 100,
						metadata: { testing: 2 },
					},
					{
						name: 'key3',
						expiration: TIME_FUTURE + 200,
						metadata: { testing: 3 },
					},
				],
			],
		})
	})
	conformanceTest(known, 'list: returns an empty list with no keys', async () => {
		await testList({
			values: {},
			pages: [[]],
		})
	})
	conformanceTest(known, 'list: returns an empty list with no matching keys', async () => {
		await testList({
			values: {
				key1: { value: 'value1' },
				key2: { value: 'value2' },
				key3: { value: 'value3' },
			},
			options: { prefix: 'none' },
			pages: [[]],
		})
	})
	conformanceTest(known, 'list: paginates keys', async () => {
		await testList({
			values: {
				key1: { value: 'value1' },
				key2: { value: 'value2' },
				key3: { value: 'value3' },
			},
			options: { limit: 2 },
			pages: [[{ name: 'key1' }, { name: 'key2' }], [{ name: 'key3' }]],
		})
	})
	conformanceTest(known, 'list: paginates keys matching prefix', async () => {
		await testList({
			values: {
				section1key1: { value: 'value11' },
				section1key2: { value: 'value12' },
				section1key3: { value: 'value13' },
				section2key1: { value: 'value21' },
			},
			options: { prefix: 'section1', limit: 2 },
			pages: [
				[{ name: 'section1key1' }, { name: 'section1key2' }],
				[{ name: 'section1key3' }],
			],
		})
	})
	conformanceTest(known, 'list: accepts long prefix', async () => {
		// Max key length (no namespace padding: keys are not namespaced here)
		const longKey = 'x'.repeat(512)
		await kv.put(longKey, 'value')
		const page = await kv.list({ prefix: longKey })
		expect<unknown>(page.keys).toEqual([{ name: longKey }])
	})
	conformanceTest(known, 'list: paginates with variable limit', async () => {
		await kv.put('key1', 'value1')
		await kv.put('key2', 'value2')
		await kv.put('key3', 'value3')

		// Get first page
		let page = await kv.list({ prefix: '', limit: 1 })
		expect<unknown>(page.keys).toEqual([{ name: 'key1' }])
		assert(!page.list_complete)
		expect(page.cursor).toBeDefined()

		// Get second page with different limit
		page = await kv.list({ prefix: '', limit: 2, cursor: page.cursor })
		expect<unknown>(page.keys).toEqual([{ name: 'key2' }, { name: 'key3' }])
		assert(page.list_complete)
	})
	conformanceTest(known, 'list: returns keys inserted whilst paginating', async () => {
		await kv.put('key1', 'value1')
		await kv.put('key3', 'value3')
		await kv.put('key5', 'value5')

		// Get first page
		let page = await kv.list({ prefix: '', limit: 2 })
		expect<unknown>(page.keys).toEqual([{ name: 'key1' }, { name: 'key3' }])
		assert(!page.list_complete)
		expect(page.cursor).toBeDefined()

		// Insert key2 and key4
		await kv.put('key2', 'value2')
		await kv.put('key4', 'value4')

		// Get second page, expecting to see key4 but not key2
		page = await kv.list({ prefix: '', limit: 2, cursor: page.cursor })
		expect<unknown>(page.keys).toEqual([{ name: 'key4' }, { name: 'key5' }])
		assert(page.list_complete)
	})
	conformanceTest(known, 'list: ignores expired keys', async () => {
		for (let i = 1; i <= 3; i++) {
			await kv.put(`key${i}`, `value${i}`, { expiration: TIME_NOW + i * 60 })
		}
		clock.advance(130_000 /* 2m10s */)
		expect<unknown>(await kv.list({ prefix: '' })).toEqual({
			keys: [{ name: 'key3', expiration: TIME_NOW + 3 * 60 }],
			list_complete: true,
			cacheStatus: null,
		})
	})
	conformanceTest(known, 'list: sorts lexicographically', async () => {
		await kv.put(', ', 'value')
		await kv.put('!', 'value')
		expect<unknown>(await kv.list({ prefix: '' })).toEqual({
			keys: [{ name: '!' }, { name: ', ' }],
			list_complete: true,
			cacheStatus: null,
		})
	})
	conformanceTest(known, 'list: validates limit', async () => {
		// The runtime will only send the limit if it's > 0
		await expect(kv.list({ limit: 1001 })).rejects.toThrow(
			new Error(
				'KV GET failed: 400 Invalid key_count_limit of 1001. Please specify an integer less than 1000.',
			),
		)
	})
})
