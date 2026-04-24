import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileR2Bucket } from '../src/bindings/r2'
import { runMigrations } from '../src/db'
import { handleS3Request } from '../src/s3/proxy'

const BUCKET = 'presign-bucket'
let db: Database
let r2: FileR2Bucket
let tmpDir: string
let server: { stop(): void; url: URL }
let s3: S3Client

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 's3-presign-test-'))
	db = new Database(':memory:')
	runMigrations(db)
	r2 = new FileR2Bucket(db, BUCKET, tmpDir)

	const bun = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url)
			const match = url.pathname.match(/^\/([^/]+)(\/.*)?$/)
			if (!match) return new Response('bad', { status: 400 })
			const [, bucketInUrl, rest] = match
			const rewritten = new URL(req.url)
			rewritten.pathname = rest ?? '/'
			const virtual = new Request(rewritten.toString(), {
				method: req.method,
				headers: req.headers,
				body: req.body,
				duplex: 'half',
			} as RequestInit)
			return handleS3Request(virtual, bucketInUrl!, bucketInUrl === BUCKET ? r2 : undefined)
		},
	})
	server = { stop: () => bun.stop(true), url: bun.url }

	s3 = new S3Client({
		region: 'auto',
		endpoint: server.url.toString().replace(/\/$/, ''),
		forcePathStyle: true,
		credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
	})
})

afterAll(() => {
	s3?.destroy()
	server?.stop()
	db.close()
	rmSync(tmpDir, { recursive: true, force: true })
})

test('Presigned PUT URL: raw fetch uploads object', async () => {
	const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key: 'presign/put.txt' }), {
		expiresIn: 300,
	})
	// The URL contains all SigV4 query params; lopata ignores them.
	expect(url).toContain('X-Amz-Signature')
	expect(url).toContain('X-Amz-Expires')

	const res = await fetch(url, { method: 'PUT', body: 'uploaded via presigned url' })
	expect(res.status).toBe(200)
	const got = await r2.get('presign/put.txt')
	expect(await (got as unknown as { text(): Promise<string> }).text()).toBe('uploaded via presigned url')
})

test('Presigned PUT URL with content-type enforced by the signer', async () => {
	const url = await getSignedUrl(
		s3,
		new PutObjectCommand({ Bucket: BUCKET, Key: 'presign/typed.json', ContentType: 'application/json' }),
		{ expiresIn: 300, signableHeaders: new Set(['content-type']) },
	)
	const res = await fetch(url, {
		method: 'PUT',
		body: '{"hello":"world"}',
		headers: { 'content-type': 'application/json' },
	})
	expect(res.status).toBe(200)
	const head = await r2.head('presign/typed.json')
	expect(head!.httpMetadata.contentType).toBe('application/json')
})

test('Presigned GET URL: raw fetch downloads object', async () => {
	await r2.put('presign/get.txt', 'download me')
	const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: 'presign/get.txt' }), {
		expiresIn: 300,
	})
	const res = await fetch(url)
	expect(res.status).toBe(200)
	expect(await res.text()).toBe('download me')
})

test('Presigned GET URL with Range header', async () => {
	await r2.put('presign/range.txt', 'abcdefghij')
	const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: 'presign/range.txt' }), {
		expiresIn: 300,
	})
	const res = await fetch(url, { headers: { range: 'bytes=2-5' } })
	expect(res.status).toBe(206)
	expect(await res.text()).toBe('cdef')
})
