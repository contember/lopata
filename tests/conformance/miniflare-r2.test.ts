// Adapted from workers-sdk packages/miniflare/test/plugins/r2/index.spec.ts at 6ee18e1bd (MIT OR Apache-2.0, Cloudflare, Inc.)
// Excluded: "operations persist stored data" (r2Persist option, Miniflare persistence layout); "migrates database to new location"
// (Miniflare legacy persistence migration). Assertions on Miniflare's internal SQLite rows and blobs are omitted inline.

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect } from 'bun:test'
import assert from 'node:assert'
import crypto from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileR2Bucket, R2ObjectBody } from '../../src/bindings/r2'
import type { R2Conditional, R2ListOptions, R2Object } from '../../src/bindings/r2'
import { runMigrations } from '../../src/db'
import { conformanceTest, loadKnownFailures } from './harness'

const known = loadKnownFailures('miniflare-r2')

const WITHIN_EPSILON = 10_000

// Miniflare namespaces keys to share one bucket between tests; every test here gets a fresh bucket.
const ns = ''

function hash(value: string, algorithm = 'md5') {
	return crypto.createHash(algorithm).update(value).digest('hex')
}

// workers-types' R2Checksums has toJSON(); lopata's type does not, so call it dynamically.
function checksumsJSON(object: R2Object | null | undefined): unknown {
	if (!object) return undefined
	const { checksums } = object
	if (!('toJSON' in checksums) || typeof checksums.toJSON !== 'function') throw new TypeError('checksums.toJSON is not a function')
	return checksums.toJSON()
}

// workers-types types get() without onlyIf as R2ObjectBody | null; lopata returns R2Object | R2ObjectBody | null.
function bodyOf(object: R2Object | null): R2ObjectBody | null {
	if (object === null) return null
	if (!(object instanceof R2ObjectBody)) throw new TypeError('expected an R2ObjectBody')
	return object
}

function getWithRangeHeader(r2: FileR2Bucket, key: string, range: Headers) {
	return r2.get(key, { range })
}

type ListOptions = R2ListOptions & { startAfter?: string }

let db: Database
let tmpDir: string
let r2: FileR2Bucket

describe('r2', () => {
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'lopata-conformance-r2-'))
		db = new Database(':memory:')
		runMigrations(db)
		r2 = new FileR2Bucket(db, 'bucket', tmpDir)
	})

	afterEach(() => {
		db.close()
		rmSync(tmpDir, { recursive: true, force: true })
	})

	async function testValidatesKey(opts: { method: string; f: (r2: FileR2Bucket, key: string) => Promise<unknown> }) {
		await expect(opts.f(r2, 'x'.repeat(1025 - ns.length))).rejects.toThrow(
			new Error(`${opts.method}: The specified object name is not valid. (10020)`),
		)
	}

	conformanceTest(known, 'head: returns null for non-existent keys', async () => {
		expect(await r2.head('key')).toBe(null)
	})
	conformanceTest(known, 'head: returns metadata for existing keys', async () => {
		const start = Date.now()
		await r2.put('key', 'value', {
			httpMetadata: {
				contentType: 'text/plain',
				contentLanguage: 'en-GB',
				contentDisposition: 'attachment; filename="value.txt"',
				contentEncoding: 'gzip',
				cacheControl: 'max-age=3600',
				cacheExpiry: new Date('Fri, 24 Feb 2023 00:00:00 GMT'),
			},
			customMetadata: { key: 'value' },
		})
		const object = await r2.head('key')
		assert(object !== null)
		expect(object.key).toBe(`${ns}key`)
		expect(object.version).toMatch(/^[0-9a-f]{32}$/)
		expect(object.size).toBe('value'.length)
		expect(object.etag).toBe('2063c1608d6e0baf80249c42e2be5804')
		expect(object.httpEtag).toBe(`"2063c1608d6e0baf80249c42e2be5804"`)
		expect(checksumsJSON(object)).toEqual({
			md5: '2063c1608d6e0baf80249c42e2be5804',
		})
		expect(object.httpMetadata).toEqual({
			contentType: 'text/plain',
			contentLanguage: 'en-GB',
			contentDisposition: 'attachment; filename="value.txt"',
			contentEncoding: 'gzip',
			cacheControl: 'max-age=3600',
			cacheExpiry: new Date('Fri, 24 Feb 2023 00:00:00 GMT'),
		})
		expect(object.customMetadata).toEqual({ key: 'value' })
		expect(object.range).toEqual({ offset: 0, length: 5 })
		expect(object.uploaded.getTime()).toBeGreaterThanOrEqual(start)
		expect(object.uploaded.getTime()).toBeLessThanOrEqual(start + WITHIN_EPSILON)

		// Test proxying of `writeHttpMetadata()`
		const headers = new Headers({ 'X-Key': 'value' })
		expect(object.writeHttpMetadata(headers)).toBeUndefined()
		expect(headers.get('Content-Type')).toBe('text/plain')
		expect(headers.get('X-Key')).toBe('value')
	})
	conformanceTest(known, 'head: validates key', async () => {
		await testValidatesKey({ method: 'head', f: (r2, key) => r2.head(key) })
	})

	conformanceTest(known, 'get: returns null for non-existent keys', async () => {
		expect(await r2.get('key')).toBe(null)
	})
	conformanceTest(known, 'get: returns metadata and body for existing keys', async () => {
		const start = Date.now()
		await r2.put('key', 'value', {
			httpMetadata: {
				contentType: 'text/plain',
				contentLanguage: 'en-GB',
				contentDisposition: 'attachment; filename="value.txt"',
				contentEncoding: 'gzip',
				cacheControl: 'max-age=3600',
				cacheExpiry: new Date('Fri, 24 Feb 2023 00:00:00 GMT'),
			},
			customMetadata: { key: 'value' },
		})
		const body = bodyOf(await r2.get('key'))
		assert(body !== null)
		expect(body.key).toBe(`${ns}key`)
		expect(body.version).toMatch(/^[0-9a-f]{32}$/)
		expect(body.size).toBe('value'.length)
		expect(body.etag).toBe('2063c1608d6e0baf80249c42e2be5804')
		expect(body.httpEtag).toBe(`"2063c1608d6e0baf80249c42e2be5804"`)
		expect(checksumsJSON(body)).toEqual({
			md5: '2063c1608d6e0baf80249c42e2be5804',
		})
		expect(body.httpMetadata).toEqual({
			contentType: 'text/plain',
			contentLanguage: 'en-GB',
			contentDisposition: 'attachment; filename="value.txt"',
			contentEncoding: 'gzip',
			cacheControl: 'max-age=3600',
			cacheExpiry: new Date('Fri, 24 Feb 2023 00:00:00 GMT'),
		})
		expect(body.customMetadata).toEqual({ key: 'value' })
		expect(body.range).toEqual({ offset: 0, length: 5 })
		expect(body.uploaded.getTime()).toBeGreaterThanOrEqual(start)
		expect(body.uploaded.getTime()).toBeLessThanOrEqual(start + WITHIN_EPSILON)

		// Test proxying of `writeHttpMetadata()`
		const headers = new Headers({ 'X-Key': 'value' })
		expect(body.writeHttpMetadata(headers)).toBeUndefined()
		expect(headers.get('Content-Type')).toBe('text/plain')
		expect(headers.get('X-Key')).toBe('value')
	})
	conformanceTest(known, 'get: validates key', async () => {
		await testValidatesKey({ method: 'get', f: (r2, key) => r2.get(key) })
	})
	conformanceTest(known, 'get: range using object', async () => {
		await r2.put('key', 'value')

		// Check with offset
		let body = bodyOf(await r2.get('key', { range: { offset: 3 } }))
		assert(body !== null)
		expect(body.range).toEqual({ offset: 3, length: 2 })
		expect(await body.text()).toBe('ue')

		// Check with length
		body = bodyOf(await r2.get('key', { range: { length: 3 } }))
		assert(body !== null)
		expect(body.range).toEqual({ offset: 0, length: 3 })
		expect(await body.text()).toBe('val')
		// Check with overflowing length
		body = bodyOf(await r2.get('key', { range: { length: 42 } }))
		assert(body !== null)
		expect(body.range).toEqual({ offset: 0, length: 5 })
		expect(await body.text()).toBe('value')

		// Check with offset and length
		body = bodyOf(await r2.get('key', { range: { offset: 1, length: 3 } }))
		assert(body !== null)
		expect(body.range).toEqual({ offset: 1, length: 3 })
		expect(await body.text()).toBe('alu')

		// Check with suffix
		body = bodyOf(await r2.get('key', { range: { suffix: 3 } }))
		assert(body !== null)
		expect(body.range).toEqual({ offset: 2, length: 3 })
		expect(await body.text()).toBe('lue')
		// Check with underflowing suffix
		body = bodyOf(await r2.get('key', { range: { suffix: 42 } }))
		assert(body !== null)
		expect(body.range).toEqual({ offset: 0, length: 5 })
		expect(await body.text()).toBe('value')

		// Check unsatisfiable ranges
		await expect(r2.get('key', { range: { offset: 42 } })).rejects.toThrow(
			new Error('get: The requested range is not satisfiable (10039)'),
		)
		await expect(r2.get('key', { range: { length: 0 } })).rejects.toThrow(
			new Error('get: The requested range is not satisfiable (10039)'),
		)
		await expect(r2.get('key', { range: { suffix: 0 } })).rejects.toThrow(
			new Error('get: The requested range is not satisfiable (10039)'),
		)
	})
	conformanceTest(known, 'get: range using "Range" header', async () => {
		const value = 'abcdefghijklmnopqrstuvwxyz'
		await r2.put('key', value)
		const range = new Headers()

		// Check missing "Range" header returns full response
		let body = bodyOf(await getWithRangeHeader(r2, 'key', range))
		assert(body !== null)
		expect(await body.text()).toBe(value)
		expect(body.range).toEqual({ offset: 0, length: 26 })

		// Check "Range" with start and end returns partial response
		range.set('Range', 'bytes=3-6')
		body = bodyOf(await getWithRangeHeader(r2, 'key', range))
		assert(body !== null)
		expect(await body.text()).toBe('defg')
		expect(body.range).toEqual({ offset: 3, length: 4 })

		// Check "Range" with just start returns partial response
		range.set('Range', 'bytes=10-')
		body = bodyOf(await getWithRangeHeader(r2, 'key', range))
		assert(body !== null)
		expect(await body.text()).toBe('klmnopqrstuvwxyz')
		expect(body.range).toEqual({ offset: 10, length: 16 })

		// Check "Range" with just end returns partial response
		range.set('Range', 'bytes=-5')
		body = bodyOf(await getWithRangeHeader(r2, 'key', range))
		assert(body !== null)
		expect(await body.text()).toBe('vwxyz')
		expect(body.range).toEqual({ offset: 21, length: 5 })

		// Check "Range" with multiple ranges returns full response
		range.set('Range', 'bytes=5-6,10-11')
		body = bodyOf(await getWithRangeHeader(r2, 'key', range))
		assert(body !== null)
		expect(await body.text()).toBe(value)
		expect(body.range).toEqual({ offset: 0, length: 26 })
	})
	conformanceTest(known, 'get: returns body only if passes onlyIf', async () => {
		const pastDate = new Date(Date.now() - 60_000)
		await r2.put('key', 'value')
		const futureDate = new Date(Date.now() + 60_000)
		const etag = hash('value')
		const badEtag = hash('👻')

		const pass = async (cond: R2Conditional) => {
			const object = await r2.get('key', { onlyIf: cond })
			// R2ObjectBody
			expect(object !== null && 'body' in object && object?.body !== undefined).toBe(true)
		}
		const fail = async (cond: R2Conditional) => {
			const object = await r2.get('key', { onlyIf: cond })
			expect(object).not.toBe(null)
			// R2Object
			expect(object !== null && !('body' in object)).toBe(true)
		}

		await pass({ etagMatches: etag })
		await fail({ etagMatches: badEtag })

		await fail({ etagDoesNotMatch: etag })
		await pass({ etagDoesNotMatch: badEtag })

		await pass({ uploadedBefore: futureDate })
		await fail({ uploadedBefore: pastDate })

		await fail({ uploadedAfter: futureDate })
		await pass({ uploadedAfter: pastDate })
	})

	conformanceTest(known, 'put: returns metadata for created object', async () => {
		const start = Date.now()
		const object = await r2.put('key', 'value', {
			httpMetadata: {
				contentType: 'text/plain',
				contentLanguage: 'en-GB',
				contentDisposition: 'attachment; filename="value.txt"',
				contentEncoding: 'gzip',
				cacheControl: 'max-age=3600',
				cacheExpiry: new Date('Fri, 24 Feb 2023 00:00:00 GMT'),
			},
			customMetadata: { key: 'value' },
		})
		assert(object !== null)
		expect(object.key).toBe(`${ns}key`)
		expect(object.version).toMatch(/^[0-9a-f]{32}$/)
		expect(object.size).toBe('value'.length)
		expect(object.etag).toBe('2063c1608d6e0baf80249c42e2be5804')
		expect(object.httpEtag).toBe(`"2063c1608d6e0baf80249c42e2be5804"`)
		expect(checksumsJSON(object)).toEqual({
			md5: '2063c1608d6e0baf80249c42e2be5804',
		})
		expect(object.httpMetadata).toEqual({
			contentType: 'text/plain',
			contentLanguage: 'en-GB',
			contentDisposition: 'attachment; filename="value.txt"',
			contentEncoding: 'gzip',
			cacheControl: 'max-age=3600',
			cacheExpiry: new Date('Fri, 24 Feb 2023 00:00:00 GMT'),
		})
		expect(object.customMetadata).toEqual({ key: 'value' })
		expect(object.range).toBeUndefined()
		expect(object.uploaded.getTime()).toBeGreaterThanOrEqual(start)
		expect(object.uploaded.getTime()).toBeLessThanOrEqual(start + WITHIN_EPSILON)
	})
	conformanceTest(known, 'put: puts empty value', async () => {
		const object = await r2.put('key', '')
		assert(object !== null)
		expect(object.size).toBe(0)
		const objectBody = bodyOf(await r2.get('key'))
		expect(await objectBody?.text()).toBe('')
	})
	conformanceTest(known, 'put: overrides existing keys', async () => {
		await r2.put('key', 'value1')
		// omitted: Miniflare blob_id lookup

		await r2.put('key', 'value2')
		const body = bodyOf(await r2.get('key'))
		assert(body !== null)
		expect(await body.text()).toBe('value2')

		// omitted: old Miniflare blob deleted
	})
	conformanceTest(known, 'put: validates key', async () => {
		await testValidatesKey({
			method: 'put',
			f: (r2, key) => r2.put(key, 'v'),
		})
	})
	conformanceTest(known, 'put: validates checksums', async () => {
		const checksumError = (name: string, provided: string, expected: string) =>
			new Error(
				[
					`put: The ${name} checksum you specified did not match what we received.`,
					`You provided a ${name} checksum with value: ${provided}`,
					`Actual ${name} was: ${expected} (10037)`,
				].join('\n'),
			)

		// Check only stores is computed hash matches
		const md5 = hash('value', 'md5')
		await r2.put('key', 'value', { md5 })
		const badMd5 = md5.replace('0', '1')
		await expect(r2.put('key', 'value', { md5: badMd5 })).rejects.toThrow(checksumError('MD5', badMd5, md5))
		let checksums = checksumsJSON(await r2.head('key'))
		expect(checksums).toEqual({ md5 })

		const sha1 = hash('value', 'sha1')
		await r2.put('key', 'value', { sha1 })
		const badSha1 = sha1.replace('0', '1')
		await expect(r2.put('key', 'value', { sha1: badSha1 })).rejects.toThrow(checksumError('SHA-1', badSha1, sha1))
		// Check `get()` returns checksums
		checksums = checksumsJSON(await r2.get('key'))
		expect(checksums).toEqual({ md5, sha1 })

		const sha256 = hash('value', 'sha256')
		// Check always stores lowercase hash
		await r2.put('key', 'value', { sha256: sha256.toUpperCase() })
		const badSha256 = sha256.replace('0', '1')
		await expect(r2.put('key', 'value', { sha256: badSha256 })).rejects.toThrow(checksumError('SHA-256', badSha256, sha256))
		checksums = checksumsJSON(await r2.head('key'))
		expect(checksums).toEqual({ md5, sha256 })

		const sha384 = hash('value', 'sha384')
		await r2.put('key', 'value', { sha384 })
		const badSha384 = sha384.replace('0', '1')
		await expect(r2.put('key', 'value', { sha384: badSha384 })).rejects.toThrow(checksumError('SHA-384', badSha384, sha384))
		checksums = checksumsJSON(await r2.head('key'))
		expect(checksums).toEqual({ md5, sha384 })

		const sha512 = hash('value', 'sha512')
		await r2.put('key', 'value', { sha512 })
		const badSha512 = sha512.replace('0', '1')
		await expect(r2.put('key', 'value', { sha512: badSha512 })).rejects.toThrow(checksumError('SHA-512', badSha512, sha512))
		checksums = checksumsJSON(await r2.head('key'))
		expect(checksums).toEqual({ md5, sha512 })
	})
	conformanceTest(known, 'put: stores only if passes onlyIf', async () => {
		const pastDate = new Date(Date.now() - 60_000)
		const futureDate = new Date(Date.now() + 300_000)
		const etag = hash('1')
		const badEtag = hash('👻')

		const reset = () => r2.put('key', '1')
		await reset()

		const pass = async (cond: R2Conditional) => {
			const object = await r2.put('key', '2', { onlyIf: cond })
			expect(object).not.toBe(null)
			expect(await bodyOf(await r2.get('key'))?.text()).toBe('2')
			await reset()
		}
		const fail = async (cond: R2Conditional) => {
			const object = await r2.put('key', '2', { onlyIf: cond })
			expect(object).toBe(null)
			expect(await bodyOf(await r2.get('key'))?.text()).toBe('1')
			// No `reset()` as we've just checked we didn't update anything
		}

		await pass({ etagMatches: etag })
		await fail({ etagMatches: badEtag })

		await fail({ etagDoesNotMatch: etag })
		await pass({ etagDoesNotMatch: badEtag })

		await pass({ uploadedBefore: futureDate })
		await fail({ uploadedBefore: pastDate })

		await fail({ uploadedAfter: futureDate })
		await pass({ uploadedAfter: pastDate })

		// Check non-existent key with failed condition
		const object = await r2.put('no-key', '2', { onlyIf: { etagMatches: etag } })
		expect(object).toBe(null)
	})
	conformanceTest(known, 'put: validates metadata size', async () => {
		const metadataError = new Error('put: Your metadata headers exceed the maximum allowed metadata size. (10012)')

		// Check with ASCII characters
		await r2.put('key', 'value', { customMetadata: { key: 'x'.repeat(2045) } })
		await expect(r2.put('key', 'value', { customMetadata: { key: 'x'.repeat(2046) } })).rejects.toThrow(metadataError)
		await r2.put('key', 'value', { customMetadata: { hi: 'x'.repeat(2046) } })

		// Check with extended characters: note "🙂" is 2 UTF-16 code units, so
		// `"🙂".length === 2`, and it requires 4 bytes to store
		await r2.put('key', 'value', { customMetadata: { key: '🙂'.repeat(511) } }) // 3 + 4*511 = 2047
		await r2.put('key', 'value', { customMetadata: { key1: '🙂'.repeat(511) } }) // 4 + 4*511 = 2048
		await expect(r2.put('key', 'value', { customMetadata: { key12: '🙂'.repeat(511) } })).rejects.toThrow(metadataError)
		await expect(r2.put('key', 'value', { customMetadata: { key: '🙂'.repeat(512) } })).rejects.toThrow(metadataError)
	})
	conformanceTest(known, 'put: can copy values', async () => {
		// The original runs this sequence in a worker script; here it calls the bucket directly.
		await r2.put('key', '0123456789')

		let object = bodyOf(await r2.get('key'))
		assert(object !== null)
		await r2.put('key-copy', object.body)
		const copy = await bodyOf(await r2.get('key-copy'))?.text()

		object = bodyOf(await r2.get('key', { range: { offset: 1, length: 4 } }))
		assert(object !== null)
		await r2.put('key-copy-range-1', object.body)
		const copyRange1 = await bodyOf(await r2.get('key-copy-range-1'))?.text()

		object = bodyOf(await r2.get('key', { range: { length: 3 } }))
		assert(object !== null)
		await r2.put('key-copy-range-2', object.body)
		const copyRange2 = await bodyOf(await r2.get('key-copy-range-2'))?.text()

		object = bodyOf(await r2.get('key', { range: { suffix: 5 } }))
		assert(object !== null)
		await r2.put('key-copy-range-3', object.body)
		const copyRange3 = await bodyOf(await r2.get('key-copy-range-3'))?.text()

		const range = new Headers()
		range.set('Range', 'bytes=0-5')
		object = bodyOf(await getWithRangeHeader(r2, 'key', range))
		assert(object !== null)
		await r2.put('key-copy-range-4', object.body)
		const copyRange4 = await bodyOf(await r2.get('key-copy-range-4'))?.text()

		expect({ copy, copyRange1, copyRange2, copyRange3, copyRange4 }).toEqual({
			copy: '0123456789',
			copyRange1: '1234',
			copyRange2: '012',
			copyRange3: '56789',
			copyRange4: '012345',
		})
	})

	conformanceTest(known, 'delete: deletes existing keys', async () => {
		// Check does nothing with non-existent key
		await r2.delete('key')

		// Check deletes single key
		await r2.put('key', 'value')
		// omitted: Miniflare blob_id lookup
		expect(await r2.head('key')).not.toBe(null)
		await r2.delete('key')
		expect(await r2.head('key')).toBe(null)
		// omitted: old Miniflare blob deleted

		// Check deletes multiple keys, skipping non-existent keys
		await r2.put('key1', 'value1')
		await r2.put('key2', 'value2')
		await r2.put('key3', 'value3')
		await r2.delete(['key1', 'key200', 'key3'])
		expect(await r2.head('key1')).toBe(null)
		expect(await r2.head('key2')).not.toBe(null)
		expect(await r2.head('key3')).toBe(null)
	})
	conformanceTest(known, 'delete: validates key', async () => {
		await testValidatesKey({
			method: 'delete',
			f: (r2, key) => r2.delete(key),
		})
	})
	conformanceTest(known, 'delete: validates keys', async () => {
		await testValidatesKey({
			method: 'delete',
			f: (r2, key) => r2.delete(['valid key', key]),
		})
	})

	async function testList(opts: { keys: string[]; options?: ListOptions; pages: string[][] }) {
		// Seed bucket
		for (const [i, key] of opts.keys.entries()) await r2.put(key, `value${i}`)

		let lastCursor: string | undefined
		for (const [pageIndex, expectedKeys] of opts.pages.entries()) {
			const listOptions: ListOptions = {
				...opts.options,
				prefix: ns + (opts.options?.prefix ?? ''),
				cursor: opts.options?.cursor ?? lastCursor,
				startAfter: opts.options?.startAfter ? ns + opts.options.startAfter : undefined,
			}
			const result = await r2.list(listOptions)
			const { objects, truncated } = result
			const cursor = truncated ? result.cursor : undefined

			// Check objects in page match
			const objectKeys = objects.map(({ key }) => key.substring(ns.length))
			expect(objectKeys).toEqual(expectedKeys)

			// Check other return values and advance cursor to next page
			if (pageIndex === opts.pages.length - 1) {
				// Last Page
				expect(truncated).toBe(false)
				expect(cursor).toBeUndefined()
			} else {
				expect(truncated).toBe(true)
				expect(cursor).toBeDefined()
			}
			lastCursor = cursor
		}
	}
	conformanceTest(known, 'list: lists keys in sorted order', async () => {
		await testList({
			keys: ['key3', 'key1', 'key2', ', ', '!'],
			pages: [['!', ', ', 'key1', 'key2', 'key3']],
		})
	})
	conformanceTest(known, 'list: lists keys matching prefix', async () => {
		await testList({
			keys: ['section1key1', 'section1key2', 'section2key1'],
			options: { prefix: 'section1' },
			pages: [['section1key1', 'section1key2']],
		})
	})
	conformanceTest(known, 'list: returns an empty list with no keys', async () => {
		await testList({
			keys: [],
			pages: [[]],
		})
	})
	conformanceTest(known, 'list: returns an empty list with no matching keys', async () => {
		await testList({
			keys: ['key1', 'key2', 'key3'],
			options: { prefix: 'none' },
			pages: [[]],
		})
	})
	conformanceTest(known, 'list: returns an empty list with an invalid cursor', async () => {
		await testList({
			keys: ['key1', 'key2', 'key3'],
			options: { cursor: 'bad' },
			pages: [[]],
		})
	})
	conformanceTest(known, 'list: paginates keys', async () => {
		await testList({
			keys: ['key1', 'key2', 'key3'],
			options: { limit: 2 },
			pages: [['key1', 'key2'], ['key3']],
		})
	})
	conformanceTest(known, 'list: paginates keys matching prefix', async () => {
		await testList({
			keys: ['section1key1', 'section1key2', 'section1key3', 'section2key1'],
			options: { prefix: 'section1', limit: 2 },
			pages: [['section1key1', 'section1key2'], ['section1key3']],
		})
	})
	conformanceTest(known, 'list: lists keys starting from startAfter exclusive', async () => {
		await testList({
			keys: ['key1', 'key2', 'key3', 'key4'],
			options: { startAfter: 'key2' },
			pages: [['key3', 'key4']],
		})
	})
	conformanceTest(known, 'list: lists keys with startAfter and limit (where startAfter matches key)', async () => {
		await testList({
			keys: ['key1', 'key2', 'key3', 'key4'],
			options: { startAfter: 'key1', limit: 2 },
			pages: [['key2', 'key3'], ['key4']],
		})
	})
	conformanceTest(known, "list: lists keys with startAfter and limit (where startAfter doesn't match key)", async () => {
		await testList({
			keys: ['key1', 'key2', 'key3', 'key4'],
			options: { startAfter: 'key', limit: 2 },
			pages: [
				['key1', 'key2'],
				['key3', 'key4'],
			],
		})
	})
	conformanceTest(known, 'list: accepts long prefix', async () => {
		// Max key length, minus padding for `context.ns`
		const longKey = 'x'.repeat(1024 - ns.length)
		await r2.put(longKey, 'value')
		const { objects } = await r2.list({ prefix: ns + longKey })
		expect(objects.length).toBe(1)
		expect(objects[0]?.key).toBe(ns + longKey)
	})
	conformanceTest(known, 'list: returns metadata with objects', async () => {
		const start = Date.now()
		await r2.put('key', 'value')
		const { objects } = await r2.list({ prefix: ns })
		expect(objects.length).toBe(1)
		const object = objects[0]
		assert(object !== undefined)
		expect(object.key).toBe(`${ns}key`)
		expect(object.version).toMatch(/^[0-9a-f]{32}$/)
		expect(object.size).toBe('value'.length)
		expect(object.etag).toBe('2063c1608d6e0baf80249c42e2be5804')
		expect(object.httpEtag).toBe(`"2063c1608d6e0baf80249c42e2be5804"`)
		expect(checksumsJSON(object)).toEqual({
			md5: '2063c1608d6e0baf80249c42e2be5804',
		})
		expect(object.httpMetadata).toEqual({})
		expect(object.customMetadata).toEqual({})
		expect(object.range).toBeUndefined()
		expect(object.uploaded.getTime()).toBeGreaterThanOrEqual(start)
		expect(object.uploaded.getTime()).toBeLessThanOrEqual(start + WITHIN_EPSILON)
	})
	conformanceTest(known, 'list: paginates with variable limit', async () => {
		await r2.put('key1', 'value1')
		await r2.put('key2', 'value2')
		await r2.put('key3', 'value3')

		// Get first page
		let result = await r2.list({ prefix: ns, limit: 1 })
		expect(result.objects.length).toBe(1)
		expect(result.objects[0]?.key).toBe(`${ns}key1`)
		assert(result.truncated && result.cursor !== undefined)

		// Get second page with different limit
		result = await r2.list({ prefix: ns, limit: 2, cursor: result.cursor })
		expect(result.objects.length).toBe(2)
		expect(result.objects[0]?.key).toBe(`${ns}key2`)
		expect(result.objects[1]?.key).toBe(`${ns}key3`)
		expect(result.truncated && result.cursor === undefined).toBe(false)
	})
	conformanceTest(known, 'list: returns keys inserted whilst paginating', async () => {
		await r2.put('key1', 'value1')
		await r2.put('key3', 'value3')
		await r2.put('key5', 'value5')

		// Get first page
		let result = await r2.list({ prefix: ns, limit: 2 })
		expect(result.objects.length).toBe(2)
		expect(result.objects[0]?.key).toBe(`${ns}key1`)
		expect(result.objects[1]?.key).toBe(`${ns}key3`)
		assert(result.truncated && result.cursor !== undefined)

		// Insert key2 and key4
		await r2.put('key2', 'value2')
		await r2.put('key4', 'value4')

		// Get second page, expecting to see key4 but not key2
		result = await r2.list({ prefix: ns, limit: 2, cursor: result.cursor })
		expect(result.objects.length).toBe(2)
		expect(result.objects[0]?.key).toBe(`${ns}key4`)
		expect(result.objects[1]?.key).toBe(`${ns}key5`)
		expect(result.truncated && result.cursor === undefined).toBe(false)
	})
	conformanceTest(known, 'list: validates limit', async () => {
		// R2 actually accepts 0 and -1 as valid limits, but this is probably a bug
		await expect(r2.list({ limit: 0 })).rejects.toThrow(new Error('list: MaxKeys params must be positive integer <= 1000. (10022)'))
		await expect(r2.list({ limit: 1_001 })).rejects.toThrow(new Error('list: MaxKeys params must be positive integer <= 1000. (10022)'))
	})
	conformanceTest(known, 'list: includes httpMetadata and customMetadata if specified', async () => {
		await r2.put('key1', 'value1', {
			httpMetadata: { contentEncoding: 'gzip' },
			customMetadata: { foo: 'bar' },
		})
		await r2.put('key2', 'value2', {
			httpMetadata: { contentType: 'dinosaur' },
			customMetadata: { bar: 'fiz' },
		})
		await r2.put('key3', 'value3', {
			httpMetadata: { contentLanguage: 'en' },
			customMetadata: { fiz: 'bang' },
		})

		// Check no metadata included by default
		let result = await r2.list({ prefix: ns })
		expect(result.objects.length).toEqual(3)
		expect(result.objects[0]?.httpMetadata).toEqual({})
		expect(result.objects[0]?.customMetadata).toEqual({})
		expect(result.objects[1]?.httpMetadata).toEqual({})
		expect(result.objects[1]?.customMetadata).toEqual({})
		expect(result.objects[2]?.httpMetadata).toEqual({})
		expect(result.objects[2]?.customMetadata).toEqual({})

		// Check httpMetadata included if specified
		result = await r2.list({ prefix: ns, include: ['httpMetadata'] })
		expect(result.objects.length).toEqual(3)
		expect(result.objects[0]?.httpMetadata).toEqual({ contentEncoding: 'gzip' })
		expect(result.objects[0]?.customMetadata).toEqual({})
		expect(result.objects[1]?.httpMetadata).toEqual({ contentType: 'dinosaur' })
		expect(result.objects[1]?.customMetadata).toEqual({})
		expect(result.objects[2]?.httpMetadata).toEqual({ contentLanguage: 'en' })
		expect(result.objects[2]?.customMetadata).toEqual({})

		// Check customMetadata included if specified
		result = await r2.list({ prefix: ns, include: ['customMetadata'] })
		expect(result.objects.length).toEqual(3)
		expect(result.objects[0]?.httpMetadata).toEqual({})
		expect(result.objects[0]?.customMetadata).toEqual({ foo: 'bar' })
		expect(result.objects[1]?.httpMetadata).toEqual({})
		expect(result.objects[1]?.customMetadata).toEqual({ bar: 'fiz' })
		expect(result.objects[2]?.httpMetadata).toEqual({})
		expect(result.objects[2]?.customMetadata).toEqual({ fiz: 'bang' })

		// Check both included if specified
		result = await r2.list({
			prefix: ns,
			include: ['httpMetadata', 'customMetadata'],
		})
		expect(result.objects.length).toEqual(3)
		expect(result.objects[0]?.httpMetadata).toEqual({ contentEncoding: 'gzip' })
		expect(result.objects[0]?.customMetadata).toEqual({ foo: 'bar' })
		expect(result.objects[1]?.httpMetadata).toEqual({ contentType: 'dinosaur' })
		expect(result.objects[1]?.customMetadata).toEqual({ bar: 'fiz' })
		expect(result.objects[2]?.httpMetadata).toEqual({ contentLanguage: 'en' })
		expect(result.objects[2]?.customMetadata).toEqual({ fiz: 'bang' })
	})
	conformanceTest(known, 'list: returns correct delimitedPrefixes for delimiter and prefix', async () => {
		const values: Record<string, string> = {
			// In lexicographic key order, so `allKeys` is sorted
			'dir0/file0': 'value0',
			'dir0/file1': 'value1',
			'dir0/sub0/file2': 'value2',
			'dir0/sub0/file3': 'value3',
			'dir0/sub1/file4': 'value4',
			'dir0/sub1/file5': 'value5',
			'dir1/file6': 'value6',
			'dir1/file7': 'value7',
			file8: 'value8',
			file9: 'value9',
		}
		const allKeys = Object.keys(values)
		for (const [key, value] of Object.entries(values)) await r2.put(key, value)

		type ListResult = Awaited<ReturnType<FileR2Bucket['list']>>
		const keys = (result: ListResult) => result.objects.map(({ key }) => key.substring(ns.length))
		const delimitedPrefixes = (result: ListResult) => result.delimitedPrefixes.map((prefix) => prefix.substring(ns.length))
		const allKeysWithout = (...exclude: string[]) => allKeys.filter((value) => !exclude.includes(value))

		// Check no/empty delimiter
		let result = await r2.list({ prefix: ns })
		expect(result.truncated).toBe(false)
		expect(keys(result)).toEqual(allKeys)
		expect(delimitedPrefixes(result)).toEqual([])
		result = await r2.list({ prefix: ns, delimiter: '' })
		expect(result.truncated).toBe(false)
		expect(keys(result)).toEqual(allKeys)
		expect(delimitedPrefixes(result)).toEqual([])

		// Check with file delimiter
		result = await r2.list({ prefix: ns, delimiter: 'file8' })
		expect(result.truncated).toBe(false)
		expect(keys(result)).toEqual(allKeysWithout('file8'))
		expect(delimitedPrefixes(result)).toEqual(['file8'])
		// ...and prefix
		result = await r2.list({ prefix: `${ns}dir1/`, delimiter: 'file6' })
		expect(result.truncated).toBe(false)
		expect(keys(result)).toEqual(['dir1/file7'])
		expect(delimitedPrefixes(result)).toEqual(['dir1/file6'])

		// Check with "/" delimiter
		result = await r2.list({ prefix: ns, delimiter: '/' })
		expect(result.truncated).toBe(false)
		expect(keys(result)).toEqual(['file8', 'file9'])
		expect(delimitedPrefixes(result)).toEqual(['dir0/', 'dir1/'])
		// ...and prefix
		result = await r2.list({ prefix: `${ns}dir0/`, delimiter: '/' })
		expect(result.truncated).toBe(false)
		expect(keys(result)).toEqual(['dir0/file0', 'dir0/file1'])
		expect(delimitedPrefixes(result)).toEqual(['dir0/sub0/', 'dir0/sub1/'])
		result = await r2.list({ prefix: `${ns}dir0`, delimiter: '/' })
		expect(result.truncated).toBe(false)
		expect(keys(result)).toEqual([])
		expect(delimitedPrefixes(result)).toEqual(['dir0/'])

		// Check with limit (limit includes returned objects and delimitedPrefixes)
		const opt: R2ListOptions = { prefix: `${ns}dir0/`, delimiter: '/', limit: 2 }
		result = await r2.list(opt)
		assert(result.truncated)
		expect(keys(result)).toEqual(['dir0/file0', 'dir0/file1'])
		expect(delimitedPrefixes(result)).toEqual([])
		result = await r2.list({ ...opt, cursor: result.cursor })
		expect(result.truncated).toBe(false)
		expect(keys(result)).toEqual([])
		expect(delimitedPrefixes(result)).toEqual(['dir0/sub0/', 'dir0/sub1/'])
	})

	conformanceTest(known, 'operations permit empty key', async () => {
		await r2.put('', 'empty')
		const object = await r2.head('')
		expect(object?.key).toBe('')

		const objectBody = bodyOf(await r2.get(''))
		expect(await objectBody?.text()).toBe('empty')

		const { objects } = await r2.list()
		// Filter by empty key since other tests may have objects in the shared bucket
		const emptyKeyObjects = objects.filter((o) => o.key === '')
		expect(emptyKeyObjects.length).toBe(1)
		expect(emptyKeyObjects[0]?.key).toBe('')

		await r2.delete('')
		expect(await r2.head('')).toBe(null)
	})

	conformanceTest(known, 'operations permit strange bucket names', async () => {
		// The original reconfigures Miniflare's bucket id; here the binding is constructed with it.
		const id = 'my/ Bucket'
		const r2 = new FileR2Bucket(db, id, tmpDir)

		// Check basic operations work
		await r2.put('key', 'value')
		const object = bodyOf(await r2.get('key'))
		expect(await object?.text()).toBe('value')
	})

	// Multipart tests
	const PART_SIZE = 50

	conformanceTest(known, 'createMultipartUpload', async () => {
		// Check creates upload
		const upload1 = await r2.createMultipartUpload('key', {
			customMetadata: { key: 'value' },
			httpMetadata: { contentType: 'text/plain' },
		})
		expect(upload1.key).toBe(`${ns}key`)
		expect(upload1.uploadId).not.toBe('')

		// Check creates multiple distinct uploads with different uploadIds for key
		const upload2 = await r2.createMultipartUpload('key')
		expect(upload2.key).toBe(`${ns}key`)
		expect(upload2.uploadId).not.toBe('')
		expect(upload2.uploadId).not.toBe(upload1.uploadId)

		// Check validates key
		await expect(r2.createMultipartUpload('x'.repeat(1025))).rejects.toThrow(
			new Error(`createMultipartUpload: The specified object name is not valid. (10020)`),
		)
	})
	conformanceTest(known, 'uploadPart', async () => {
		// Check uploads parts
		const upload = await r2.createMultipartUpload('key')
		const part1 = await upload.uploadPart(1, 'value1')
		expect(part1.partNumber).toBe(1)
		expect(part1.etag).not.toBe('')
		const part2 = await upload.uploadPart(2, 'value two')
		expect(part2.partNumber).toBe(2)
		expect(part2.etag).not.toBe('')
		expect(part2.etag).not.toBe(part1.etag)
		// omitted: Miniflare part rows and blob contents

		// Check upload part with same part number and same value
		const part1b = await upload.uploadPart(1, 'value1')
		expect(part1b.partNumber).toBe(1)
		expect(part1b.etag).not.toBe(part1.etag)

		// Check upload part with different part number but same value
		const part100 = await upload.uploadPart(100, 'value1')
		expect(part100.partNumber).toBe(100)
		expect(part100.etag).not.toBe(part1.etag)

		// Check validates key and uploadId
		let nonExistentUpload = r2.resumeMultipartUpload('key', 'bad')
		await expect(nonExistentUpload.uploadPart(1, 'value')).rejects.toThrow(
			new Error(`uploadPart: The specified multipart upload does not exist. (10024)`),
		)
		nonExistentUpload = r2.resumeMultipartUpload('badkey', upload.uploadId)
		await expect(nonExistentUpload.uploadPart(1, 'value')).rejects.toThrow(
			new Error(`uploadPart: The specified multipart upload does not exist. (10024)`),
		)
		nonExistentUpload = r2.resumeMultipartUpload('x'.repeat(1025), 'bad')
		await expect(nonExistentUpload.uploadPart(1, 'value')).rejects.toThrow(
			new Error(`uploadPart: The specified object name is not valid. (10020)`),
		)
	})
	conformanceTest(known, 'abortMultipartUpload', async () => {
		// Check deletes upload and all parts for corresponding upload
		const upload1 = await r2.createMultipartUpload('key')
		const upload2 = await r2.createMultipartUpload('key')
		await upload1.uploadPart(1, 'value1')
		await upload1.uploadPart(2, 'value2')
		await upload1.uploadPart(3, 'value3')
		// omitted: Miniflare part rows before abort
		await upload1.abort()
		// omitted: Miniflare part rows and blobs deleted after abort

		// Check cannot upload after abort
		await expect(upload1.uploadPart(4, 'value4')).rejects.toThrow(
			new Error(`uploadPart: The specified multipart upload does not exist. (10024)`),
		)

		// Check can abort already aborted upload
		await upload1.abort()

		// Check can abort already completed upload
		const part1 = await upload2.uploadPart(1, 'value1')
		await upload2.complete([part1])
		await upload2.abort()
		expect(await bodyOf(await r2.get('key'))?.text()).toBe('value1')

		// Check validates key and uploadId
		const upload3 = await r2.createMultipartUpload('key')
		// Note this is internalErrorExpectations, not doesNotExistExpectations
		let nonExistentUpload = r2.resumeMultipartUpload('key', 'bad')
		await expect(nonExistentUpload.abort()).rejects.toThrow(
			new Error(`abortMultipartUpload: We encountered an internal error. Please try again. (10001)`),
		)
		nonExistentUpload = r2.resumeMultipartUpload('bad', upload3.uploadId)
		await expect(nonExistentUpload.abort()).rejects.toThrow(
			new Error('abortMultipartUpload: We encountered an internal error. Please try again. (10001)'),
		)
		nonExistentUpload = r2.resumeMultipartUpload('x'.repeat(1025), 'bad')
		await expect(nonExistentUpload.abort()).rejects.toThrow(
			new Error('abortMultipartUpload: The specified object name is not valid. (10020)'),
		)
	})
	conformanceTest(known, 'completeMultipartUpload', async () => {
		// Check creates regular key with correct metadata, and returns object
		const upload1 = await r2.createMultipartUpload('key', {
			customMetadata: { key: 'value' },
			httpMetadata: { contentType: 'text/plain' },
		})
		const upload2 = await r2.createMultipartUpload('key')
		let part1 = await upload1.uploadPart(1, '1'.repeat(PART_SIZE))
		let part2 = await upload1.uploadPart(2, '2'.repeat(PART_SIZE))
		let part3 = await upload1.uploadPart(3, '3')
		let object = await upload1.complete([part1, part2, part3])
		expect(object.key).toBe(`${ns}key`)
		expect(object.version).not.toBe('')
		expect(object.size).toBe(2 * PART_SIZE + 1)
		expect(object.etag).toBe('3b676245e58d988dc75f80c0c27a9645-3')
		expect(object.httpEtag).toBe('"3b676245e58d988dc75f80c0c27a9645-3"')
		expect(object.range).toBeUndefined()
		expect(checksumsJSON(object)).toEqual({})
		expect(object.customMetadata).toEqual({ key: 'value' })
		expect(object.httpMetadata).toEqual({ contentType: 'text/plain' })
		let objectBody = bodyOf(await r2.get('key'))
		expect(await objectBody?.text()).toBe(`${'1'.repeat(PART_SIZE)}${'2'.repeat(PART_SIZE)}3`)

		// omitted: Miniflare part rows of the completed upload

		// Check requires all but last part to be greater than 5MB
		part1 = await upload2.uploadPart(1, '1')
		part2 = await upload2.uploadPart(2, '2')
		part3 = await upload2.uploadPart(3, '3')
		const sizeError = new Error(
			'completeMultipartUpload: Your proposed upload is smaller than the minimum allowed object size. (10011)',
		)
		await expect(upload2.complete([part1, part2, part3])).rejects.toThrow(sizeError)
		await expect(upload2.complete([part1, part2])).rejects.toThrow(sizeError)
		object = await upload2.complete([part1])
		expect(object.size).toBe(1)
		expect(object.etag).toBe('46d1741e8075da4ac72c71d8130fcb71-1')
		// omitted: previous Miniflare multipart blobs and part rows deleted
		objectBody = bodyOf(await r2.get('key'))
		expect(await objectBody?.text()).toBe('1')

		// Check completing with overridden part
		const upload3 = await r2.createMultipartUpload('key')
		let part1a = await upload3.uploadPart(1, 'value')
		let part1b = await upload3.uploadPart(1, 'value')
		expect(part1a.partNumber).toBe(part1b.partNumber)
		expect(part1a.etag).not.toBe(part1b.etag)
		const notFoundError = new Error('completeMultipartUpload: One or more of the specified parts could not be found. (10025)')
		await expect(upload3.complete([part1a])).rejects.toThrow(notFoundError)
		object = await upload3.complete([part1b])
		expect(object.size).toBe(5)

		// Check completing with multiple parts of same part number
		const upload4 = await r2.createMultipartUpload('key')
		part1a = await upload4.uploadPart(1, '1'.repeat(PART_SIZE))
		part1b = await upload4.uploadPart(1, '2'.repeat(PART_SIZE))
		const part1c = await upload4.uploadPart(1, '3'.repeat(PART_SIZE))
		await expect(upload4.complete([part1a, part1b, part1c])).rejects.toThrow(
			new Error('completeMultipartUpload: We encountered an internal error. Please try again. (10001)'),
		)

		// Check completing with out-of-order parts
		const upload5a = await r2.createMultipartUpload('key')
		part1 = await upload5a.uploadPart(1, '1'.repeat(PART_SIZE))
		part2 = await upload5a.uploadPart(2, '2'.repeat(PART_SIZE))
		part3 = await upload5a.uploadPart(3, '3'.repeat(PART_SIZE))
		object = await upload5a.complete([part2, part3, part1])
		expect(object.size).toBe(3 * PART_SIZE)
		expect(object.etag).toBe('f1115cc5564e7e0b25bbd87d95c72c86-3')
		objectBody = bodyOf(await r2.get('key'))
		expect(await objectBody?.text()).toBe(`${'1'.repeat(PART_SIZE)}${'2'.repeat(PART_SIZE)}${'3'.repeat(PART_SIZE)}`)
		const upload5b = await r2.createMultipartUpload('key')
		part1 = await upload5b.uploadPart(1, '1')
		part2 = await upload5b.uploadPart(2, '2'.repeat(PART_SIZE))
		part3 = await upload5b.uploadPart(3, '3'.repeat(PART_SIZE))
		// Check part size checking happens in argument order (part1's size isn't
		// checked until too late, as it's the last argument so ignored...)
		await expect(upload5b.complete([part2, part3, part1])).rejects.toThrow(
			new Error('completeMultipartUpload: There was a problem with the multipart upload. (10048)'),
		)
		const upload5c = await r2.createMultipartUpload('key')
		part1 = await upload5c.uploadPart(1, '1'.repeat(PART_SIZE))
		part2 = await upload5c.uploadPart(2, '2'.repeat(PART_SIZE))
		part3 = await upload5c.uploadPart(3, '3')
		// (...but here, part3 isn't the last argument, so get a regular size error)
		await expect(upload5c.complete([part2, part3, part1])).rejects.toThrow(sizeError)

		// Check completing with missing parts
		const upload6 = await r2.createMultipartUpload('key')
		part2 = await upload6.uploadPart(2, '2'.repeat(PART_SIZE))
		const part5 = await upload6.uploadPart(5, '5'.repeat(PART_SIZE))
		const part9 = await upload6.uploadPart(9, '9'.repeat(PART_SIZE))
		object = await upload6.complete([part2, part5, part9])
		expect(object.size).toBe(3 * PART_SIZE)
		expect(object.etag).toBe('471d773597286301a10c61cd8c84e659-3')
		objectBody = bodyOf(await r2.get('key'))
		expect(await objectBody?.text()).toBe(`${'2'.repeat(PART_SIZE)}${'5'.repeat(PART_SIZE)}${'9'.repeat(PART_SIZE)}`)

		// Check completing with no parts
		const upload7 = await r2.createMultipartUpload('key')
		object = await upload7.complete([])
		expect(object.size).toBe(0)
		expect(object.etag).toBe('d41d8cd98f00b204e9800998ecf8427e-0')
		objectBody = bodyOf(await r2.get('key'))
		expect(await objectBody?.text()).toBe('')

		// Check cannot complete with parts from another upload
		const upload8a = await r2.createMultipartUpload('key')
		const upload8b = await r2.createMultipartUpload('key')
		part1 = await upload8b.uploadPart(1, 'value')
		await expect(upload8a.complete([part1])).rejects.toThrow(notFoundError)

		const doesNotExistError = new Error('completeMultipartUpload: The specified multipart upload does not exist. (10024)')
		// Check cannot complete already completed upload
		const upload9 = await r2.createMultipartUpload('key')
		part1 = await upload9.uploadPart(1, 'value')
		await upload9.complete([part1])
		await expect(upload9.complete([part1])).rejects.toThrow(doesNotExistError)

		// Check cannot complete aborted upload
		const upload10 = await r2.createMultipartUpload('key')
		part1 = await upload10.uploadPart(1, 'value')
		await upload10.abort()
		await expect(upload10.complete([part1])).rejects.toThrow(doesNotExistError)

		// Check validates key and uploadId
		const upload11 = await r2.createMultipartUpload('key')
		// Note this is internalErrorExpectations, not doesNotExistExpectations
		let nonExistentUpload = r2.resumeMultipartUpload('key', 'bad')
		await expect(nonExistentUpload.complete([])).rejects.toThrow(
			new Error(`completeMultipartUpload: We encountered an internal error. Please try again. (10001)`),
		)
		nonExistentUpload = r2.resumeMultipartUpload('badkey', upload11.uploadId)
		await expect(nonExistentUpload.complete([])).rejects.toThrow(
			new Error(`completeMultipartUpload: We encountered an internal error. Please try again. (10001)`),
		)
		nonExistentUpload = r2.resumeMultipartUpload('x'.repeat(1025), 'bad')
		await expect(nonExistentUpload.complete([])).rejects.toThrow(
			new Error(`completeMultipartUpload: The specified object name is not valid. (10020)`),
		)

		// Check requires all but last part to have same size
		const upload13 = await r2.createMultipartUpload('key')
		part1 = await upload13.uploadPart(1, '1'.repeat(PART_SIZE))
		part2 = await upload13.uploadPart(2, '2'.repeat(PART_SIZE + 1))
		part3 = await upload13.uploadPart(3, '3'.repeat(PART_SIZE))
		const multipartError = new Error('completeMultipartUpload: There was a problem with the multipart upload. (10048)')
		await expect(upload13.complete([part1, part2, part3])).rejects.toThrow(multipartError)
		part2 = await upload13.uploadPart(2, '2'.repeat(PART_SIZE))
		// Check allows last part to have different size, only if <= others
		part3 = await upload13.uploadPart(3, '3'.repeat(PART_SIZE + 1))
		await expect(upload13.complete([part1, part2, part3])).rejects.toThrow(multipartError)
		part3 = await upload13.uploadPart(3, '3'.repeat(PART_SIZE - 1))
		object = await upload13.complete([part1, part2, part3])
		expect(object.size).toBe(3 * PART_SIZE - 1)

		// Check with non-existent and non-matching parts
		const upload14 = await r2.createMultipartUpload('key')
		part1 = await upload14.uploadPart(1, '1'.repeat(PART_SIZE))
		part2 = await upload14.uploadPart(2, '2')
		await expect(upload14.complete([part1, { partNumber: 3, etag: part2.etag }])).rejects.toThrow(notFoundError)
		await expect(upload14.complete([part1, { partNumber: 2, etag: 'bad' }])).rejects.toThrow(notFoundError)
		await expect(upload14.complete([part1, { partNumber: 4, etag: 'very bad' }])).rejects.toThrow(notFoundError)
	})
	// Check regular operations on buckets with existing multipart keys
	conformanceTest(known, 'head: is multipart aware', async () => {
		// Check returns nothing for in-progress multipart upload
		const upload = await r2.createMultipartUpload('key', {
			customMetadata: { key: 'value' },
			httpMetadata: { contentType: 'text/plain' },
		})
		const part1 = await upload.uploadPart(1, '1'.repeat(PART_SIZE))
		const part2 = await upload.uploadPart(2, '2'.repeat(PART_SIZE))
		const part3 = await upload.uploadPart(3, '3'.repeat(PART_SIZE))
		expect(await r2.head('key')).toBe(null)

		// Check returns metadata for completed upload
		const completed = await upload.complete([part1, part2, part3])
		const object = await r2.head('key')
		expect(object?.key).toBe(`${ns}key`)
		expect(object?.version).toBe(completed.version)
		expect(object?.size).toBe(3 * PART_SIZE)
		expect(object?.etag).toBe('f1115cc5564e7e0b25bbd87d95c72c86-3')
		expect(object?.httpEtag).toBe('"f1115cc5564e7e0b25bbd87d95c72c86-3"')
		expect(object?.range).toEqual({ offset: 0, length: 150 })
		expect(checksumsJSON(object)).toEqual({})
		expect(object?.customMetadata).toEqual({ key: 'value' })
		expect(object?.httpMetadata).toEqual({ contentType: 'text/plain' })
	})
	conformanceTest(known, 'get: is multipart aware', async () => {
		// Check returns nothing for in-progress multipart upload
		const upload = await r2.createMultipartUpload('key', {
			customMetadata: { key: 'value' },
			httpMetadata: { contentType: 'text/plain' },
		})
		const part1 = await upload.uploadPart(1, 'a'.repeat(PART_SIZE))
		const part2 = await upload.uploadPart(2, 'b'.repeat(PART_SIZE))
		const part3 = await upload.uploadPart(3, 'c'.repeat(PART_SIZE))
		expect(await r2.get('key')).toBe(null)

		// Check returns metadata and value for completed upload
		const completed = await upload.complete([part1, part2, part3])
		let object = bodyOf(await r2.get('key'))
		expect(object?.key).toBe(`${ns}key`)
		expect(object?.version).toBe(completed.version)
		expect(object?.size).toBe(3 * PART_SIZE)
		expect(object?.etag).toBe('d63a28fd44cfddc0215c8da47e582eb7-3')
		expect(object?.httpEtag).toBe('"d63a28fd44cfddc0215c8da47e582eb7-3"')
		expect(object?.range).toEqual({ offset: 0, length: 3 * PART_SIZE })
		expect(checksumsJSON(object)).toEqual({})
		expect(object?.customMetadata).toEqual({ key: 'value' })
		expect(object?.httpMetadata).toEqual({ contentType: 'text/plain' })
		expect(await object?.text()).toBe(`${'a'.repeat(PART_SIZE)}${'b'.repeat(PART_SIZE)}${'c'.repeat(PART_SIZE)}`)

		// Check ranged get accessing single part
		const halfPartSize = Math.floor(PART_SIZE / 2)
		const quarterPartSize = Math.floor(PART_SIZE / 4)
		object = bodyOf(
			await r2.get('key', {
				range: { offset: halfPartSize, length: quarterPartSize },
			}),
		)
		expect(await object?.text()).toBe('a'.repeat(quarterPartSize))

		// Check ranged get accessing multiple parts
		object = bodyOf(
			await r2.get('key', {
				range: {
					offset: halfPartSize,
					length: halfPartSize + PART_SIZE + quarterPartSize,
				},
			}),
		)
		expect(await object?.text()).toBe(`${'a'.repeat(halfPartSize)}${'b'.repeat(PART_SIZE)}${'c'.repeat(quarterPartSize)}`)

		// Check ranged get of suffix
		object = bodyOf(
			await r2.get('key', {
				range: { suffix: quarterPartSize + PART_SIZE },
			}),
		)
		expect(await object?.text()).toBe(`${'b'.repeat(quarterPartSize)}${'c'.repeat(PART_SIZE)}`)
	})
	conformanceTest(known, 'put: is multipart aware', async () => {
		// Check doesn't overwrite parts for in-progress multipart upload
		const upload = await r2.createMultipartUpload('key')
		const part1 = await upload.uploadPart(1, '1'.repeat(PART_SIZE))
		const part2 = await upload.uploadPart(2, '2'.repeat(PART_SIZE))
		const part3 = await upload.uploadPart(3, '3'.repeat(PART_SIZE))
		await r2.put('key', 'value')

		// omitted: Miniflare part rows survive the put

		const object = await upload.complete([part1, part2, part3])
		expect(object.size).toBe(3 * PART_SIZE)
		// omitted: Miniflare part rows of the completed upload

		// Check overwrites all multipart parts of completed upload
		await r2.put('key', 'new-value')
		// omitted: Miniflare part rows and blobs deleted
	})
	conformanceTest(known, 'delete: is multipart aware', async () => {
		// Check doesn't remove parts for in-progress multipart upload
		const upload = await r2.createMultipartUpload('key')
		const part1 = await upload.uploadPart(1, '1'.repeat(PART_SIZE))
		const part2 = await upload.uploadPart(2, '2'.repeat(PART_SIZE))
		const part3 = await upload.uploadPart(3, '3'.repeat(PART_SIZE))
		await r2.delete('key')

		// Check removes all multipart parts of completed upload
		const object = await upload.complete([part1, part2, part3])
		expect(object.size).toBe(3 * PART_SIZE)
		// omitted: Miniflare part rows before delete
		await r2.delete('key')
		// omitted: Miniflare part rows and blobs deleted
	})
	conformanceTest(known, 'delete: waits for in-progress multipart gets before deleting part blobs', async () => {
		const upload = await r2.createMultipartUpload('key')
		const part1 = await upload.uploadPart(1, '1'.repeat(PART_SIZE))
		const part2 = await upload.uploadPart(2, '2'.repeat(PART_SIZE))
		const part3 = await upload.uploadPart(3, '3'.repeat(PART_SIZE))
		await upload.complete([part1, part2, part3])

		const objectBody1 = bodyOf(await r2.get('key'))
		const objectBody2 = bodyOf(await r2.get('key', { range: { offset: PART_SIZE } }))
		// omitted: Miniflare part rows before delete
		await r2.delete('key')
		expect(await objectBody1?.text()).toBe(`${'1'.repeat(PART_SIZE)}${'2'.repeat(PART_SIZE)}${'3'.repeat(PART_SIZE)}`)
		expect(await objectBody2?.text()).toBe(`${'2'.repeat(PART_SIZE)}${'3'.repeat(PART_SIZE)}`)

		// omitted: Miniflare part blobs deleted afterwards
	})
	conformanceTest(known, 'list: is multipart aware', async () => {
		// Check returns nothing for in-progress multipart upload
		const upload = await r2.createMultipartUpload('key', {
			customMetadata: { key: 'value' },
			httpMetadata: { contentType: 'text/plain' },
		})
		const part1 = await upload.uploadPart(1, 'x'.repeat(PART_SIZE))
		const part2 = await upload.uploadPart(2, 'y'.repeat(PART_SIZE))
		const part3 = await upload.uploadPart(3, 'z'.repeat(PART_SIZE))
		let { objects } = await r2.list({
			prefix: ns,
			include: ['httpMetadata', 'customMetadata'],
		})
		expect(objects.length).toBe(0)

		// Check returns metadata for completed upload
		const completed = await upload.complete([part1, part2, part3])
		;({ objects } = await r2.list({
			prefix: ns,
			include: ['httpMetadata', 'customMetadata'],
		}))
		expect(objects.length).toBe(1)
		const object = objects[0]
		expect(object?.key).toBe(`${ns}key`)
		expect(object?.version).toBe(completed.version)
		expect(object?.size).toBe(3 * PART_SIZE)
		expect(object?.etag).toBe('9f4271a2af6d83c1d3fef1cc6d170f9f-3')
		expect(object?.httpEtag).toBe('"9f4271a2af6d83c1d3fef1cc6d170f9f-3"')
		expect(object?.range).toBeUndefined()
		expect(checksumsJSON(object)).toEqual({})
		expect(object?.customMetadata).toEqual({ key: 'value' })
		expect(object?.httpMetadata).toEqual({ contentType: 'text/plain' })
	})
})
