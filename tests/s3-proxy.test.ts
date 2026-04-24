import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileR2Bucket } from '../src/bindings/r2'
import { runMigrations } from '../src/db'
import { handleS3Request, matchS3Path } from '../src/s3/proxy'

let r2: FileR2Bucket
let db: Database
let tmpDir: string
const BUCKET = 'my-bucket'

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 's3-proxy-test-'))
	db = new Database(':memory:')
	runMigrations(db)
	r2 = new FileR2Bucket(db, BUCKET, tmpDir)
})

afterEach(() => {
	db.close()
	rmSync(tmpDir, { recursive: true, force: true })
})

function s3(method: string, path: string, init?: RequestInit): Request {
	return new Request(`http://localhost${path}`, { method, ...init, duplex: 'half' } as RequestInit)
}

// --- matchS3Path ---

test('matchS3Path: unmatched path returns null', () => {
	expect(matchS3Path('/foo')).toBeNull()
	expect(matchS3Path('/__api/foo')).toBeNull()
})

test('matchS3Path: bucket only', () => {
	expect(matchS3Path('/__s3/bucket')).toEqual({ bucket: 'bucket', keyPath: '' })
})

test('matchS3Path: bucket + key', () => {
	expect(matchS3Path('/__s3/bucket/foo/bar.txt')).toEqual({ bucket: 'bucket', keyPath: 'foo/bar.txt' })
})

// --- CORS + error handling ---

test('OPTIONS preflight returns CORS headers', async () => {
	const res = await handleS3Request(s3('OPTIONS', '/'), BUCKET, r2)
	expect(res.status).toBe(200)
	expect(res.headers.get('access-control-allow-origin')).toBe('*')
	expect(res.headers.get('access-control-allow-methods')).toContain('PUT')
})

test('unknown bucket returns NoSuchBucket (404)', async () => {
	const res = await handleS3Request(s3('GET', '/key'), 'nope', undefined)
	expect(res.status).toBe(404)
	const body = await res.text()
	expect(body).toContain('<Code>NoSuchBucket</Code>')
})

test('GET missing key returns NoSuchKey (404)', async () => {
	const res = await handleS3Request(s3('GET', '/does-not-exist'), BUCKET, r2)
	expect(res.status).toBe(404)
	expect(await res.text()).toContain('<Code>NoSuchKey</Code>')
})

test('unsupported method returns InvalidRequest', async () => {
	const res = await handleS3Request(s3('PATCH', '/key'), BUCKET, r2)
	expect(res.status).toBe(400)
	expect(await res.text()).toContain('Unsupported method')
})

// --- PUT / GET / HEAD / DELETE ---

test('PUT stores body, GET returns it', async () => {
	const put = await handleS3Request(s3('PUT', '/hello.txt', { body: 'hello world' }), BUCKET, r2)
	expect(put.status).toBe(200)
	expect(put.headers.get('etag')).toMatch(/^"[0-9a-f]+"$/)

	const get = await handleS3Request(s3('GET', '/hello.txt'), BUCKET, r2)
	expect(get.status).toBe(200)
	expect(await get.text()).toBe('hello world')
	expect(get.headers.get('content-length')).toBe('11')
})

test('HEAD returns headers without body', async () => {
	await r2.put('k', 'payload')
	const res = await handleS3Request(s3('HEAD', '/k'), BUCKET, r2)
	expect(res.status).toBe(200)
	expect(res.headers.get('content-length')).toBe('7')
	expect(await res.text()).toBe('')
})

test('DELETE removes the object', async () => {
	await r2.put('k', 'x')
	const del = await handleS3Request(s3('DELETE', '/k'), BUCKET, r2)
	expect(del.status).toBe(204)
	expect(await r2.get('k')).toBeNull()
})

// --- Metadata round-trip ---

test('PUT preserves content-type and custom metadata, GET returns them as headers', async () => {
	await handleS3Request(
		s3('PUT', '/doc.json', {
			body: '{"a":1}',
			headers: {
				'content-type': 'application/json',
				'cache-control': 'max-age=60',
				'x-amz-meta-author': 'nobile',
				'x-amz-meta-tag': 'v1',
			},
		}),
		BUCKET,
		r2,
	)
	const res = await handleS3Request(s3('GET', '/doc.json'), BUCKET, r2)
	expect(res.headers.get('content-type')).toBe('application/json')
	expect(res.headers.get('cache-control')).toBe('max-age=60')
	expect(res.headers.get('x-amz-meta-author')).toBe('nobile')
	expect(res.headers.get('x-amz-meta-tag')).toBe('v1')
})

test('PUT with Expires header round-trips as cacheExpiry Date', async () => {
	const expires = new Date('2030-06-15T12:00:00Z')
	await handleS3Request(
		s3('PUT', '/x', {
			body: 'x',
			headers: { expires: expires.toUTCString() },
		}),
		BUCKET,
		r2,
	)
	const obj = await r2.head('x')
	expect(obj!.httpMetadata.cacheExpiry).toBeInstanceOf(Date)
	expect(obj!.httpMetadata.cacheExpiry!.getTime()).toBe(expires.getTime())
})

// --- ListObjectsV2 ---

test('ListObjectsV2 returns all keys', async () => {
	await r2.put('a.txt', '1')
	await r2.put('b.txt', '2')
	const res = await handleS3Request(s3('GET', '/?list-type=2'), BUCKET, r2)
	expect(res.status).toBe(200)
	expect(res.headers.get('content-type')).toBe('application/xml')
	const xml = await res.text()
	expect(xml).toContain('<Key>a.txt</Key>')
	expect(xml).toContain('<Key>b.txt</Key>')
	expect(xml).toContain('<IsTruncated>false</IsTruncated>')
})

test('ListObjectsV2 with prefix filters', async () => {
	await r2.put('docs/a', '1')
	await r2.put('docs/b', '2')
	await r2.put('images/c', '3')
	const res = await handleS3Request(s3('GET', '/?list-type=2&prefix=docs/'), BUCKET, r2)
	const xml = await res.text()
	expect(xml).toContain('<Key>docs/a</Key>')
	expect(xml).toContain('<Key>docs/b</Key>')
	expect(xml).not.toContain('images/c')
	expect(xml).toContain('<Prefix>docs/</Prefix>')
})

test('ListObjectsV2 with delimiter returns CommonPrefixes', async () => {
	await r2.put('root.txt', '1')
	await r2.put('dir/a', '2')
	await r2.put('dir/b', '3')
	const res = await handleS3Request(s3('GET', '/?list-type=2&delimiter=/'), BUCKET, r2)
	const xml = await res.text()
	expect(xml).toContain('<Key>root.txt</Key>')
	expect(xml).toContain('<CommonPrefixes><Prefix>dir/</Prefix></CommonPrefixes>')
	expect(xml).not.toContain('<Key>dir/a</Key>')
})

test('ListObjectsV2 pagination with max-keys returns continuation token', async () => {
	for (let i = 0; i < 5; i++) await r2.put(`k${i}`, 'x')
	const res = await handleS3Request(s3('GET', '/?list-type=2&max-keys=2'), BUCKET, r2)
	const xml = await res.text()
	expect(xml).toContain('<IsTruncated>true</IsTruncated>')
	expect(xml).toMatch(/<NextContinuationToken>\d+<\/NextContinuationToken>/)
})

// --- Content-MD5 validation ---

test('PUT with matching Content-MD5 succeeds', async () => {
	const md5 = new Bun.CryptoHasher('md5')
	md5.update('hello')
	const b64 = Buffer.from(md5.digest('hex'), 'hex').toString('base64')
	const res = await handleS3Request(
		s3('PUT', '/k', { body: 'hello', headers: { 'content-md5': b64 } }),
		BUCKET,
		r2,
	)
	expect(res.status).toBe(200)
})

test('PUT with mismatched Content-MD5 returns BadDigest and does not persist', async () => {
	const res = await handleS3Request(
		s3('PUT', '/k', { body: 'hello', headers: { 'content-md5': 'AAAAAAAAAAAAAAAAAAAAAA==' } }),
		BUCKET,
		r2,
	)
	expect(res.status).toBe(400)
	expect(await res.text()).toContain('<Code>BadDigest</Code>')
	expect(await r2.get('k')).toBeNull()
})

// --- URL-encoded keys ---

test('PUT/GET with URL-encoded key decodes to actual characters', async () => {
	const put = await handleS3Request(s3('PUT', '/folder%20name/file%2Bv1.txt', { body: 'ok' }), BUCKET, r2)
	expect(put.status).toBe(200)
	expect(await r2.get('folder name/file+v1.txt')).not.toBeNull()

	const get = await handleS3Request(s3('GET', '/folder%20name/file%2Bv1.txt'), BUCKET, r2)
	expect(await get.text()).toBe('ok')
})

// --- HeadBucket / GetBucketLocation ---

test('HEAD on bucket root returns 200', async () => {
	const res = await handleS3Request(s3('HEAD', '/'), BUCKET, r2)
	expect(res.status).toBe(200)
})

test('HEAD on bucket root with no R2 returns NoSuchBucket', async () => {
	const res = await handleS3Request(s3('HEAD', '/'), 'nope', undefined)
	expect(res.status).toBe(404)
})

test('GET ?location returns LocationConstraint XML', async () => {
	const res = await handleS3Request(s3('GET', '/?location'), BUCKET, r2)
	expect(res.status).toBe(200)
	const xml = await res.text()
	expect(xml).toContain('<LocationConstraint')
	expect(xml).toContain('auto</LocationConstraint>')
})

// --- Range requests ---

test('GET with Range: bytes=0-4 returns 206 with Content-Range', async () => {
	await r2.put('big', 'abcdefghij')
	const res = await handleS3Request(s3('GET', '/big', { headers: { range: 'bytes=0-4' } }), BUCKET, r2)
	expect(res.status).toBe(206)
	expect(res.headers.get('content-range')).toBe('bytes 0-4/10')
	expect(res.headers.get('content-length')).toBe('5')
	expect(await res.text()).toBe('abcde')
})

test('GET with Range: bytes=3- returns trailing bytes', async () => {
	await r2.put('big', 'abcdefghij')
	const res = await handleS3Request(s3('GET', '/big', { headers: { range: 'bytes=3-' } }), BUCKET, r2)
	expect(res.status).toBe(206)
	expect(await res.text()).toBe('defghij')
})

test('GET with Range: bytes=-3 returns last 3 bytes', async () => {
	await r2.put('big', 'abcdefghij')
	const res = await handleS3Request(s3('GET', '/big', { headers: { range: 'bytes=-3' } }), BUCKET, r2)
	expect(res.status).toBe(206)
	expect(await res.text()).toBe('hij')
})

// --- Conditional requests ---

test('GET with matching If-Match returns 200', async () => {
	const put = await r2.put('k', 'data')
	const res = await handleS3Request(s3('GET', '/k', { headers: { 'if-match': `"${put!.etag}"` } }), BUCKET, r2)
	expect(res.status).toBe(200)
})

test('GET with non-matching If-Match returns 412', async () => {
	await r2.put('k', 'data')
	const res = await handleS3Request(s3('GET', '/k', { headers: { 'if-match': '"deadbeef"' } }), BUCKET, r2)
	expect(res.status).toBe(412)
	expect(await res.text()).toContain('<Code>PreconditionFailed</Code>')
})

test('GET with matching If-None-Match returns 304', async () => {
	const put = await r2.put('k', 'data')
	const res = await handleS3Request(s3('GET', '/k', { headers: { 'if-none-match': `"${put!.etag}"` } }), BUCKET, r2)
	expect(res.status).toBe(304)
})

test('GET with If-Modified-Since later than upload returns 304', async () => {
	await r2.put('k', 'data')
	const future = new Date(Date.now() + 86_400_000).toUTCString()
	const res = await handleS3Request(s3('GET', '/k', { headers: { 'if-modified-since': future } }), BUCKET, r2)
	expect(res.status).toBe(304)
})

test('PUT with failing If-Match returns 412', async () => {
	await r2.put('k', 'old')
	const res = await handleS3Request(
		s3('PUT', '/k', { body: 'new', headers: { 'if-match': '"wrong"' } }),
		BUCKET,
		r2,
	)
	expect(res.status).toBe(412)
	expect((await r2.get('k') as R2ObjectBodyLike).text ? await (await r2.get('k') as R2ObjectBodyLike).text() : '').toBe('old')
})

test('PUT with If-None-Match: * and no existing object succeeds', async () => {
	const res = await handleS3Request(
		s3('PUT', '/k', { body: 'first', headers: { 'if-none-match': '*' } }),
		BUCKET,
		r2,
	)
	expect(res.status).toBe(200)
})

test('PUT with If-None-Match: * and existing object returns 412', async () => {
	await r2.put('k', 'existing')
	const res = await handleS3Request(
		s3('PUT', '/k', { body: 'new', headers: { 'if-none-match': '*' } }),
		BUCKET,
		r2,
	)
	expect(res.status).toBe(412)
})

// --- ListObjectsV1 ---

test('ListObjects V1 (no list-type) returns Marker-style response', async () => {
	await r2.put('a', '1')
	await r2.put('b', '2')
	const res = await handleS3Request(s3('GET', '/'), BUCKET, r2)
	const xml = await res.text()
	expect(xml).toContain('<Key>a</Key>')
	expect(xml).toContain('<Key>b</Key>')
	expect(xml).toContain('<Marker/>')
})

// --- DeleteObjects batch ---

test('POST ?delete with XML body removes multiple keys', async () => {
	await r2.put('a', '1')
	await r2.put('b', '2')
	await r2.put('c', '3')
	const body = `<?xml version="1.0"?>
<Delete>
  <Object><Key>a</Key></Object>
  <Object><Key>b</Key></Object>
</Delete>`
	const res = await handleS3Request(s3('POST', '/?delete', { body }), BUCKET, r2)
	expect(res.status).toBe(200)
	const xml = await res.text()
	expect(xml).toContain('<Key>a</Key>')
	expect(xml).toContain('<Key>b</Key>')
	expect(await r2.get('a')).toBeNull()
	expect(await r2.get('b')).toBeNull()
	expect(await r2.get('c')).not.toBeNull()
})

test('POST ?delete with Quiet suppresses Deleted entries', async () => {
	await r2.put('a', '1')
	const body = `<Delete><Object><Key>a</Key></Object><Quiet>true</Quiet></Delete>`
	const res = await handleS3Request(s3('POST', '/?delete', { body }), BUCKET, r2)
	const xml = await res.text()
	expect(xml).not.toContain('<Deleted>')
})

// --- CopyObject ---

test('CopyObject same-bucket copies body and metadata', async () => {
	await r2.put('src', 'payload', { customMetadata: { tag: 'v1' }, httpMetadata: { contentType: 'text/plain' } })
	const res = await handleS3Request(
		s3('PUT', '/dst', { headers: { 'x-amz-copy-source': `/${BUCKET}/src` } }),
		BUCKET,
		r2,
	)
	expect(res.status).toBe(200)
	const xml = await res.text()
	expect(xml).toContain('<CopyObjectResult')
	const dst = await r2.get('dst')
	expect(await (dst as R2ObjectBodyLike).text()).toBe('payload')
	expect(dst!.customMetadata).toEqual({ tag: 'v1' })
	expect(dst!.httpMetadata.contentType).toBe('text/plain')
})

test('CopyObject with REPLACE directive uses request metadata', async () => {
	await r2.put('src', 'x', { customMetadata: { tag: 'old' }, httpMetadata: { contentType: 'text/plain' } })
	const res = await handleS3Request(
		s3('PUT', '/dst', {
			headers: {
				'x-amz-copy-source': `/${BUCKET}/src`,
				'x-amz-metadata-directive': 'REPLACE',
				'content-type': 'application/json',
				'x-amz-meta-tag': 'new',
			},
		}),
		BUCKET,
		r2,
	)
	expect(res.status).toBe(200)
	const dst = await r2.head('dst')
	expect(dst!.customMetadata).toEqual({ tag: 'new' })
	expect(dst!.httpMetadata.contentType).toBe('application/json')
})

test('CopyObject cross-bucket via resolveBucket', async () => {
	const other = new FileR2Bucket(db, 'other', tmpDir)
	await other.put('src', 'from-other')
	const res = await handleS3Request(
		s3('PUT', '/dst', { headers: { 'x-amz-copy-source': '/other/src' } }),
		BUCKET,
		r2,
		(name) => (name === 'other' ? other : undefined),
	)
	expect(res.status).toBe(200)
	expect(await (await r2.get('dst') as R2ObjectBodyLike).text()).toBe('from-other')
})

test('CopyObject with unknown source bucket returns NoSuchBucket', async () => {
	const res = await handleS3Request(
		s3('PUT', '/dst', { headers: { 'x-amz-copy-source': '/missing/src' } }),
		BUCKET,
		r2,
	)
	expect(res.status).toBe(404)
	expect(await res.text()).toContain('<Code>NoSuchBucket</Code>')
})

// --- Multipart lifecycle ---

test('Multipart: create → upload parts → complete reassembles', async () => {
	const createRes = await handleS3Request(s3('POST', '/big?uploads'), BUCKET, r2)
	expect(createRes.status).toBe(200)
	const createXml = await createRes.text()
	const uploadId = createXml.match(/<UploadId>([^<]+)<\/UploadId>/)![1]!

	const put1 = await handleS3Request(
		s3('PUT', `/big?partNumber=1&uploadId=${uploadId}`, { body: 'hello ' }),
		BUCKET,
		r2,
	)
	expect(put1.status).toBe(200)
	const etag1 = put1.headers.get('etag')!.replace(/"/g, '')

	const put2 = await handleS3Request(
		s3('PUT', `/big?partNumber=2&uploadId=${uploadId}`, { body: 'world' }),
		BUCKET,
		r2,
	)
	const etag2 = put2.headers.get('etag')!.replace(/"/g, '')

	const completeBody = `<CompleteMultipartUpload>
<Part><PartNumber>1</PartNumber><ETag>"${etag1}"</ETag></Part>
<Part><PartNumber>2</PartNumber><ETag>"${etag2}"</ETag></Part>
</CompleteMultipartUpload>`
	const completeRes = await handleS3Request(
		s3('POST', `/big?uploadId=${uploadId}`, { body: completeBody }),
		BUCKET,
		r2,
	)
	expect(completeRes.status).toBe(200)
	expect(await (await r2.get('big') as R2ObjectBodyLike).text()).toBe('hello world')
})

test('Multipart: abort removes upload', async () => {
	const createRes = await handleS3Request(s3('POST', '/k?uploads'), BUCKET, r2)
	const uploadId = (await createRes.text()).match(/<UploadId>([^<]+)<\/UploadId>/)![1]!

	const abort = await handleS3Request(s3('DELETE', `/k?uploadId=${uploadId}`), BUCKET, r2)
	expect(abort.status).toBe(204)
	expect(r2.listMultipartUploads()).toEqual([])
})

test('Multipart: ListParts returns uploaded parts', async () => {
	const createRes = await handleS3Request(s3('POST', '/k?uploads'), BUCKET, r2)
	const uploadId = (await createRes.text()).match(/<UploadId>([^<]+)<\/UploadId>/)![1]!
	await handleS3Request(s3('PUT', `/k?partNumber=1&uploadId=${uploadId}`, { body: 'a' }), BUCKET, r2)
	await handleS3Request(s3('PUT', `/k?partNumber=2&uploadId=${uploadId}`, { body: 'b' }), BUCKET, r2)

	const listRes = await handleS3Request(s3('GET', `/k?uploadId=${uploadId}`), BUCKET, r2)
	expect(listRes.status).toBe(200)
	const xml = await listRes.text()
	expect(xml).toContain('<PartNumber>1</PartNumber>')
	expect(xml).toContain('<PartNumber>2</PartNumber>')
})

test('Multipart: ListMultipartUploads returns in-progress uploads', async () => {
	const r1 = await handleS3Request(s3('POST', '/a?uploads'), BUCKET, r2)
	const r2Res = await handleS3Request(s3('POST', '/b?uploads'), BUCKET, r2)
	expect(r1.status).toBe(200)
	expect(r2Res.status).toBe(200)

	const listRes = await handleS3Request(s3('GET', '/?uploads'), BUCKET, r2)
	const xml = await listRes.text()
	expect(xml).toContain('<Key>a</Key>')
	expect(xml).toContain('<Key>b</Key>')
})

test('Multipart: complete with wrong etag returns InvalidPart', async () => {
	const createRes = await handleS3Request(s3('POST', '/k?uploads'), BUCKET, r2)
	const uploadId = (await createRes.text()).match(/<UploadId>([^<]+)<\/UploadId>/)![1]!
	await handleS3Request(s3('PUT', `/k?partNumber=1&uploadId=${uploadId}`, { body: 'a' }), BUCKET, r2)

	const body = `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"wrong"</ETag></Part></CompleteMultipartUpload>`
	const res = await handleS3Request(s3('POST', `/k?uploadId=${uploadId}`, { body }), BUCKET, r2)
	expect(res.status).toBe(400)
	expect(await res.text()).toContain('InvalidPart')
})

// --- Small type helper used in tests ---
interface R2ObjectBodyLike {
	text(): Promise<string>
}
