import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileR2Bucket, R2Object, R2ObjectBody } from '../bindings/r2'
import { runMigrations } from '../db'

let r2: FileR2Bucket
let db: Database
let tmpDir: string

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'r2-test-'))
	db = new Database(':memory:')
	runMigrations(db)
	r2 = new FileR2Bucket(db, 'test-bucket', tmpDir)
})

afterEach(() => {
	db.close()
	rmSync(tmpDir, { recursive: true, force: true })
})

// --- Basic operations (existing) ---

test('get non-existent key returns null', async () => {
	expect(await r2.get('missing')).toBeNull()
})

test('put string and get', async () => {
	await r2.put('key', 'hello world')
	const obj = await r2.get('key')
	expect(obj).not.toBeNull()
	expect(await (obj as R2ObjectBody).text()).toBe('hello world')
})

test('put and get as arrayBuffer', async () => {
	await r2.put('key', 'data')
	const obj = await r2.get('key')
	const buf = await (obj as R2ObjectBody).arrayBuffer()
	expect(new TextDecoder().decode(buf)).toBe('data')
})

test('put and get as json', async () => {
	await r2.put('key', JSON.stringify({ x: 42 }))
	const obj = await r2.get('key')
	expect(await (obj as R2ObjectBody).json<{ x: number }>()).toEqual({ x: 42 })
})

test('put and read body stream', async () => {
	await r2.put('key', 'stream-data')
	const obj = await r2.get('key')
	const reader = (obj as R2ObjectBody).body.getReader()
	const { value } = await reader.read()
	expect(new TextDecoder().decode(value)).toBe('stream-data')
})

test('put ArrayBuffer', async () => {
	const data = new TextEncoder().encode('binary').buffer as ArrayBuffer
	await r2.put('key', data)
	const obj = await r2.get('key')
	expect(await (obj as R2ObjectBody).text()).toBe('binary')
})

test('put null creates empty object', async () => {
	await r2.put('key', null)
	const obj = await r2.get('key')
	expect(obj).not.toBeNull()
	expect(obj!.size).toBe(0)
	expect(await (obj as R2ObjectBody).text()).toBe('')
})

test('put Blob', async () => {
	const blob = new Blob(['blob-data'])
	await r2.put('key', blob)
	const obj = await r2.get('key')
	expect(await (obj as R2ObjectBody).text()).toBe('blob-data')
})

test('head returns metadata without body', async () => {
	await r2.put('key', 'hello')
	const obj = await r2.head('key')
	expect(obj).not.toBeNull()
	expect(obj!.key).toBe('key')
	expect(obj!.size).toBe(5)
	expect(obj!.uploaded).toBeInstanceOf(Date)
	expect((obj as any).body).toBeUndefined()
})

test('head non-existent returns null', async () => {
	expect(await r2.head('missing')).toBeNull()
})

test('delete removes object', async () => {
	await r2.put('key', 'val')
	await r2.delete('key')
	expect(await r2.get('key')).toBeNull()
})

test('delete array of keys', async () => {
	await r2.put('a', '1')
	await r2.put('b', '2')
	await r2.put('c', '3')
	await r2.delete(['a', 'b'])
	expect(await r2.get('a')).toBeNull()
	expect(await r2.get('b')).toBeNull()
	expect(await r2.get('c')).not.toBeNull()
})

test('delete non-existent is no-op', async () => {
	await r2.delete('missing') // should not throw
})

test('put overwrites existing object', async () => {
	await r2.put('key', 'first')
	await r2.put('key', 'second')
	const obj = await r2.get('key')
	expect(await (obj as R2ObjectBody).text()).toBe('second')
})

test('put with custom metadata', async () => {
	await r2.put('key', 'data', { customMetadata: { tag: 'test' } })
	const obj = await r2.get('key')
	expect(obj!.customMetadata).toEqual({ tag: 'test' })
})

test('put returns R2Object with correct properties', async () => {
	const result = await r2.put('key', 'hello')
	expect(result!.key).toBe('key')
	expect(result!.size).toBe(5)
	expect(result!.uploaded).toBeInstanceOf(Date)
})

test('list returns all objects', async () => {
	await r2.put('a', '1')
	await r2.put('b', '2')
	const result = await r2.list()
	expect(result.objects).toHaveLength(2)
	expect(result.objects.map((o) => o.key)).toEqual(['a', 'b'])
	expect(result.truncated).toBe(false)
})

test('list with prefix', async () => {
	await r2.put('img/a.png', '1')
	await r2.put('img/b.png', '2')
	await r2.put('doc/c.txt', '3')
	const result = await r2.list({ prefix: 'img/' })
	expect(result.objects.map((o) => o.key)).toEqual(['img/a.png', 'img/b.png'])
})

test('list with limit', async () => {
	await r2.put('a', '1')
	await r2.put('b', '2')
	await r2.put('c', '3')
	const result = await r2.list({ limit: 2 })
	expect(result.objects).toHaveLength(2)
	expect(result.truncated).toBe(true)
})

test('list empty bucket', async () => {
	const result = await r2.list()
	expect(result.objects).toEqual([])
	expect(result.truncated).toBe(false)
})

test('nested keys with slashes', async () => {
	await r2.put('a/b/c.txt', 'nested')
	const obj = await r2.get('a/b/c.txt')
	expect(await (obj as R2ObjectBody).text()).toBe('nested')
})

test('put returns etag', async () => {
	const result = await r2.put('key', 'hello')
	expect(result!.etag).toBeTruthy()
	expect(typeof result!.etag).toBe('string')
})

test('path traversal is rejected', async () => {
	expect(r2.put('../escape', 'bad')).rejects.toThrow('path traversal')
})

test('bucket isolation', async () => {
	const r2b = new FileR2Bucket(db, 'other-bucket', tmpDir)
	await r2.put('key', 'bucket-a')
	await r2b.put('key', 'bucket-b')
	expect(await (await r2.get('key') as R2ObjectBody).text()).toBe('bucket-a')
	expect(await (await r2b.get('key') as R2ObjectBody).text()).toBe('bucket-b')
})

test('list with cursor pagination', async () => {
	await r2.put('a', '1')
	await r2.put('b', '2')
	await r2.put('c', '3')
	const page1 = await r2.list({ limit: 2 })
	expect(page1.objects).toHaveLength(2)
	expect(page1.truncated).toBe(true)
	expect(page1.cursor).toBeTruthy()
	const page2 = await r2.list({ limit: 2, cursor: page1.cursor })
	expect(page2.objects).toHaveLength(1)
	expect(page2.truncated).toBe(false)
	expect(page2.objects[0]!.key).toBe('c')
})

test('persistence across instances', async () => {
	await r2.put('persist', 'data')
	const r2b = new FileR2Bucket(db, 'test-bucket', tmpDir)
	const obj = await r2b.get('persist')
	expect(await (obj as R2ObjectBody).text()).toBe('data')
})

// --- New: R2Object properties ---

test('R2Object has version property', async () => {
	const result = await r2.put('key', 'data')
	expect(result!.version).toBeTruthy()
	expect(typeof result!.version).toBe('string')
})

test('R2Object has httpEtag with quotes', async () => {
	const result = await r2.put('key', 'data')
	expect(result!.httpEtag).toBe(`"${result!.etag}"`)
})

test('R2Object has storageClass', async () => {
	const result = await r2.put('key', 'data')
	expect(result!.storageClass).toBe('Standard')
})

test('R2Object has checksums with md5', async () => {
	const result = await r2.put('key', 'data')
	expect(result!.checksums.md5).toBeInstanceOf(ArrayBuffer)
})

test('writeHttpMetadata sets headers', async () => {
	await r2.put('key', 'data', { httpMetadata: { 'content-type': 'text/plain', 'cache-control': 'max-age=300' } })
	const obj = await r2.head('key')
	const headers = new Headers()
	obj!.writeHttpMetadata(headers)
	expect(headers.get('content-type')).toBe('text/plain')
	expect(headers.get('cache-control')).toBe('max-age=300')
})

test('R2ObjectBody blob() returns Blob', async () => {
	await r2.put('key', 'blob-test')
	const obj = await r2.get('key') as R2ObjectBody
	const blob = await obj.blob()
	expect(blob).toBeInstanceOf(Blob)
	expect(await blob.text()).toBe('blob-test')
})

// --- New: Validation ---

test('key exceeding max size throws', async () => {
	const longKey = 'a'.repeat(1025)
	expect(r2.put(longKey, 'data')).rejects.toThrow('Key exceeds max size')
})

test('custom metadata exceeding max size throws', async () => {
	const bigMeta: Record<string, string> = {}
	for (let i = 0; i < 200; i++) {
		bigMeta[`key-${i}`] = 'x'.repeat(20)
	}
	expect(r2.put('key', 'data', { customMetadata: bigMeta })).rejects.toThrow('Custom metadata exceeds max size')
})

test('batch delete exceeding limit throws', async () => {
	const r2limited = new FileR2Bucket(db, 'limited', tmpDir, { maxBatchDeleteKeys: 3 })
	expect(r2limited.delete(['a', 'b', 'c', 'd'])).rejects.toThrow('Cannot delete more than 3 keys')
})

test('configurable limits override defaults', async () => {
	const r2custom = new FileR2Bucket(db, 'custom', tmpDir, { maxKeySize: 5 })
	expect(r2custom.put('toolong', 'data')).rejects.toThrow('Key exceeds max size')
	// Short key still works
	const result = await r2custom.put('ok', 'data')
	expect(result!.key).toBe('ok')
})

// --- New: Conditional operations ---

test('get with onlyIf etagMatches — match returns body', async () => {
	const putResult = await r2.put('key', 'data')
	const obj = await r2.get('key', { onlyIf: { etagMatches: putResult!.etag } })
	expect(obj).toBeInstanceOf(R2ObjectBody)
	expect(await (obj as R2ObjectBody).text()).toBe('data')
})

test('get with onlyIf etagMatches — mismatch returns R2Object without body', async () => {
	await r2.put('key', 'data')
	const obj = await r2.get('key', { onlyIf: { etagMatches: 'wrong-etag' } })
	expect(obj).toBeInstanceOf(R2Object)
	expect(obj).not.toBeInstanceOf(R2ObjectBody)
	expect(obj!.key).toBe('key')
})

test('get with onlyIf etagDoesNotMatch — match returns R2Object without body', async () => {
	const putResult = await r2.put('key', 'data')
	const obj = await r2.get('key', { onlyIf: { etagDoesNotMatch: putResult!.etag } })
	expect(obj).toBeInstanceOf(R2Object)
	expect(obj).not.toBeInstanceOf(R2ObjectBody)
})

test('get with onlyIf uploadedBefore — future date returns body', async () => {
	await r2.put('key', 'data')
	const futureDate = new Date(Date.now() + 60000)
	const obj = await r2.get('key', { onlyIf: { uploadedBefore: futureDate } })
	expect(obj).toBeInstanceOf(R2ObjectBody)
})

test('get with onlyIf uploadedBefore — past date returns R2Object', async () => {
	await r2.put('key', 'data')
	const pastDate = new Date(Date.now() - 60000)
	const obj = await r2.get('key', { onlyIf: { uploadedBefore: pastDate } })
	expect(obj).toBeInstanceOf(R2Object)
	expect(obj).not.toBeInstanceOf(R2ObjectBody)
})

test('put with onlyIf — condition fails returns null', async () => {
	await r2.put('key', 'original')
	const result = await r2.put('key', 'updated', { onlyIf: { etagMatches: 'wrong' } })
	expect(result).toBeNull()
	// Original preserved
	const obj = await r2.get('key')
	expect(await (obj as R2ObjectBody).text()).toBe('original')
})

test('put with onlyIf — condition passes writes new data', async () => {
	const original = await r2.put('key', 'original')
	const result = await r2.put('key', 'updated', { onlyIf: { etagMatches: original!.etag } })
	expect(result).not.toBeNull()
	const obj = await r2.get('key')
	expect(await (obj as R2ObjectBody).text()).toBe('updated')
})

// --- New: Range reads ---

test('get with range offset and length', async () => {
	await r2.put('key', 'hello world')
	const obj = await r2.get('key', { range: { offset: 6, length: 5 } }) as R2ObjectBody
	expect(await obj.text()).toBe('world')
	expect(obj.range).toEqual({ offset: 6, length: 5 })
})

test('get with range offset only', async () => {
	await r2.put('key', 'hello world')
	const obj = await r2.get('key', { range: { offset: 6 } }) as R2ObjectBody
	expect(await obj.text()).toBe('world')
})

test('get with range suffix', async () => {
	await r2.put('key', 'hello world')
	const obj = await r2.get('key', { range: { suffix: 5 } }) as R2ObjectBody
	expect(await obj.text()).toBe('world')
})

test('get without range has no range property', async () => {
	await r2.put('key', 'data')
	const obj = await r2.get('key')
	expect(obj!.range).toBeUndefined()
})

// --- New: List enhancements ---

test('list with delimiter returns delimitedPrefixes', async () => {
	await r2.put('photos/2023/jan.jpg', '1')
	await r2.put('photos/2023/feb.jpg', '2')
	await r2.put('photos/2024/mar.jpg', '3')
	await r2.put('docs/readme.txt', '4')

	const result = await r2.list({ prefix: 'photos/', delimiter: '/' })
	// Objects that don't contain delimiter after prefix = none (all have 2023/ or 2024/)
	expect(result.objects).toHaveLength(0)
	expect(result.delimitedPrefixes).toEqual(['photos/2023/', 'photos/2024/'])
})

test('list with delimiter returns both objects and prefixes', async () => {
	await r2.put('root.txt', '1')
	await r2.put('dir/file.txt', '2')
	await r2.put('dir/sub/deep.txt', '3')

	const result = await r2.list({ delimiter: '/' })
	expect(result.objects.map((o) => o.key)).toEqual(['root.txt'])
	expect(result.delimitedPrefixes).toEqual(['dir/'])
})

test('list with include filters metadata', async () => {
	await r2.put('key', 'data', {
		httpMetadata: { 'content-type': 'text/plain' },
		customMetadata: { tag: 'test' },
	})

	const withHttp = await r2.list({ include: ['httpMetadata'] })
	expect(withHttp.objects[0]!.httpMetadata).toEqual({ 'content-type': 'text/plain' })
	expect(withHttp.objects[0]!.customMetadata).toEqual({})

	const withCustom = await r2.list({ include: ['customMetadata'] })
	expect(withCustom.objects[0]!.httpMetadata).toEqual({})
	expect(withCustom.objects[0]!.customMetadata).toEqual({ tag: 'test' })

	const withBoth = await r2.list({ include: ['httpMetadata', 'customMetadata'] })
	expect(withBoth.objects[0]!.httpMetadata).toEqual({ 'content-type': 'text/plain' })
	expect(withBoth.objects[0]!.customMetadata).toEqual({ tag: 'test' })
})

// --- New: Multipart upload ---

test('multipart upload: create, upload parts, complete', async () => {
	const upload = await r2.createMultipartUpload('big-file')
	expect(upload.key).toBe('big-file')
	expect(upload.uploadId).toBeTruthy()

	const part1 = await upload.uploadPart(1, 'hello ')
	const part2 = await upload.uploadPart(2, 'world')
	expect(part1.partNumber).toBe(1)
	expect(part2.partNumber).toBe(2)

	const result = await upload.complete([part1, part2])
	expect(result.key).toBe('big-file')
	expect(result.size).toBe(11)

	// Object should be readable
	const obj = await r2.get('big-file') as R2ObjectBody
	expect(await obj.text()).toBe('hello world')
})

test('multipart upload: abort cleans up', async () => {
	const upload = await r2.createMultipartUpload('aborted')
	await upload.uploadPart(1, 'data')
	await upload.abort()

	// Object should not exist
	expect(await r2.get('aborted')).toBeNull()
})

test('multipart upload: resume', async () => {
	const upload = await r2.createMultipartUpload('resumed')
	const part1 = await upload.uploadPart(1, 'part1')

	// Resume from a different handle
	const resumed = r2.resumeMultipartUpload('resumed', upload.uploadId)
	const part2 = await resumed.uploadPart(2, 'part2')

	const result = await resumed.complete([part1, part2])
	expect(result.size).toBe(10)

	const obj = await r2.get('resumed') as R2ObjectBody
	expect(await obj.text()).toBe('part1part2')
})

test('multipart upload: complete with wrong etag throws', async () => {
	const upload = await r2.createMultipartUpload('key')
	const part1 = await upload.uploadPart(1, 'data')
	expect(upload.complete([{ partNumber: 1, etag: 'wrong' }])).rejects.toThrow('etag mismatch')
})

test('multipart upload: operations on aborted upload throw', async () => {
	const upload = await r2.createMultipartUpload('key')
	await upload.abort()
	expect(upload.uploadPart(1, 'data')).rejects.toThrow('not found')
})
