import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	CopyObjectCommand,
	CreateMultipartUploadCommand,
	DeleteObjectCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	ListPartsCommand,
	PutObjectCommand,
	S3Client,
	UploadPartCommand,
} from '@aws-sdk/client-s3'
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileR2Bucket } from '../src/bindings/r2'
import { runMigrations } from '../src/db'
import { handleS3Request } from '../src/s3/proxy'

// Spin a real Bun.serve to exercise the proxy with the real AWS SDK.
// This catches wire-format issues (aws-chunked, signature auth, SDK quirks)
// that the direct-call tests can't.

const BUCKET = 'sdk-bucket'
let db: Database
let r2: FileR2Bucket
let tmpDir: string
let server: { stop(): void; url: URL }
let s3: S3Client

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 's3-sdk-test-'))
	db = new Database(':memory:')
	runMigrations(db)
	r2 = new FileR2Bucket(db, BUCKET, tmpDir)

	const bun = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url)
			// Strip /bucket prefix (path style) — the SDK appends the bucket name
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
		credentials: { accessKeyId: 'ignored', secretAccessKey: 'ignored' },
	})
})

afterAll(() => {
	s3?.destroy()
	server?.stop()
	db.close()
	rmSync(tmpDir, { recursive: true, force: true })
})

test('SDK: HeadBucket', async () => {
	const out = await s3.send(new HeadBucketCommand({ Bucket: BUCKET }))
	expect(out.$metadata.httpStatusCode).toBe(200)
})

test('SDK: PutObject + GetObject small body', async () => {
	await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'sdk/small.txt', Body: 'hello sdk' }))
	const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'sdk/small.txt' }))
	expect(await got.Body!.transformToString()).toBe('hello sdk')
})

test('SDK: PutObject with metadata round-trips', async () => {
	await s3.send(
		new PutObjectCommand({
			Bucket: BUCKET,
			Key: 'meta.json',
			Body: '{}',
			ContentType: 'application/json',
			CacheControl: 'max-age=60',
			Metadata: { author: 'nobile', tag: 'v1' },
		}),
	)
	const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'meta.json' }))
	expect(head.ContentType).toBe('application/json')
	expect(head.CacheControl).toBe('max-age=60')
	expect(head.Metadata).toEqual({ author: 'nobile', tag: 'v1' })
})

test('SDK: PutObject with large Body triggers aws-chunked encoding', async () => {
	// The SDK switches to aws-chunked / STREAMING signature for bodies that are
	// streams or Buffers of non-trivial size. Using a Buffer here exercises that path.
	const buf = Buffer.alloc(64 * 1024, 0x41) // 64 KiB of 'A'
	await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'big', Body: buf }))
	const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'big' }))
	const bytes = await got.Body!.transformToByteArray()
	expect(bytes.length).toBe(buf.length)
	expect(bytes[0]).toBe(0x41)
	expect(bytes[buf.length - 1]).toBe(0x41)
})

test('SDK: GetObject Range returns partial content', async () => {
	await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'range', Body: 'abcdefghij' }))
	const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'range', Range: 'bytes=2-5' }))
	expect(await got.Body!.transformToString()).toBe('cdef')
	expect(got.ContentRange).toBe('bytes 2-5/10')
})

test('SDK: ListObjectsV2', async () => {
	await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'list/a', Body: '1' }))
	await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'list/b', Body: '2' }))
	const out = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'list/' }))
	const keys = (out.Contents ?? []).map((o) => o.Key).sort()
	expect(keys).toEqual(['list/a', 'list/b'])
})

test('SDK: CopyObject same-bucket', async () => {
	await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'copy/src', Body: 'hi' }))
	await s3.send(new CopyObjectCommand({ Bucket: BUCKET, Key: 'copy/dst', CopySource: `${BUCKET}/copy/src` }))
	const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'copy/dst' }))
	expect(await got.Body!.transformToString()).toBe('hi')
})

test('SDK: DeleteObjects batch', async () => {
	await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'del/a', Body: '1' }))
	await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'del/b', Body: '2' }))
	const out = await s3.send(
		new DeleteObjectsCommand({
			Bucket: BUCKET,
			Delete: { Objects: [{ Key: 'del/a' }, { Key: 'del/b' }] },
		}),
	)
	expect(out.Deleted?.length).toBe(2)
	expect(await r2.get('del/a')).toBeNull()
	expect(await r2.get('del/b')).toBeNull()
})

test('SDK: Multipart upload end-to-end', async () => {
	const create = await s3.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: 'mp/big' }))
	const uploadId = create.UploadId!
	expect(uploadId).toBeTruthy()

	const p1 = await s3.send(
		new UploadPartCommand({ Bucket: BUCKET, Key: 'mp/big', UploadId: uploadId, PartNumber: 1, Body: 'hello ' }),
	)
	const p2 = await s3.send(
		new UploadPartCommand({ Bucket: BUCKET, Key: 'mp/big', UploadId: uploadId, PartNumber: 2, Body: 'world' }),
	)

	const listParts = await s3.send(new ListPartsCommand({ Bucket: BUCKET, Key: 'mp/big', UploadId: uploadId }))
	expect(listParts.Parts?.map((p) => p.PartNumber).sort()).toEqual([1, 2])

	await s3.send(
		new CompleteMultipartUploadCommand({
			Bucket: BUCKET,
			Key: 'mp/big',
			UploadId: uploadId,
			MultipartUpload: { Parts: [{ PartNumber: 1, ETag: p1.ETag }, { PartNumber: 2, ETag: p2.ETag }] },
		}),
	)

	const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'mp/big' }))
	expect(await got.Body!.transformToString()).toBe('hello world')
})

test('SDK: AbortMultipartUpload', async () => {
	const create = await s3.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: 'mp/abort' }))
	await s3.send(
		new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: 'mp/abort', UploadId: create.UploadId! }),
	)
	// Completing an aborted upload should fail
	await expect(
		s3.send(
			new CompleteMultipartUploadCommand({
				Bucket: BUCKET,
				Key: 'mp/abort',
				UploadId: create.UploadId!,
				MultipartUpload: { Parts: [{ PartNumber: 1, ETag: 'x' }] },
			}),
		),
	).rejects.toThrow()
})

test('SDK: DeleteObject', async () => {
	await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'del-single', Body: 'x' }))
	await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'del-single' }))
	expect(await r2.get('del-single')).toBeNull()
})
