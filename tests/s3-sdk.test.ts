import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	CopyObjectCommand,
	CreateMultipartUploadCommand,
	DeleteBucketCorsCommand,
	DeleteObjectCommand,
	DeleteObjectsCommand,
	DeleteObjectTaggingCommand,
	GetBucketCorsCommand,
	GetObjectAttributesCommand,
	GetObjectCommand,
	GetObjectTaggingCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	ListBucketsCommand,
	ListObjectsV2Command,
	ListPartsCommand,
	PutBucketCorsCommand,
	PutObjectCommand,
	PutObjectTaggingCommand,
	S3Client,
	UploadPartCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { createPresignedPost } from '@aws-sdk/s3-presigned-post'
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
const OTHER_BUCKET = 'sdk-other'
let db: Database
let r2: FileR2Bucket
let otherR2: FileR2Bucket
let tmpDir: string
let server: { stop(): void; url: URL }
let s3: S3Client

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 's3-sdk-test-'))
	db = new Database(':memory:')
	runMigrations(db)
	r2 = new FileR2Bucket(db, BUCKET, tmpDir)
	otherR2 = new FileR2Bucket(db, OTHER_BUCKET, tmpDir)

	const resolveBucket = (name: string) => {
		if (name === BUCKET) return r2
		if (name === OTHER_BUCKET) return otherR2
		return undefined
	}
	const listAllBuckets = () => [
		{ name: BUCKET, creationDate: new Date(0) },
		{ name: OTHER_BUCKET, creationDate: new Date(0) },
	]

	const bun = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url)
			// Strip /bucket prefix (path style); if path is '/', bucket is '' and we go to ListBuckets
			const match = url.pathname.match(/^\/([^/]*)(\/.*)?$/)
			const bucketInUrl = match?.[1] ?? ''
			const rest = match?.[2] ?? '/'
			const rewritten = new URL(req.url)
			rewritten.pathname = rest
			const virtual = new Request(rewritten.toString(), {
				method: req.method,
				headers: req.headers,
				body: req.body,
				duplex: 'half',
			} as RequestInit)
			return handleS3Request(virtual, bucketInUrl, resolveBucket(bucketInUrl), resolveBucket, listAllBuckets)
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

test('SDK: lib-storage Upload with 15 MiB stream triggers real multipart + aws-chunked', async () => {
	// Build a 15 MiB payload of pseudo-random bytes so md5 is stable per run but
	// distinct from a trivial fill pattern.
	const PART_SIZE = 5 * 1024 * 1024
	const TOTAL = 15 * 1024 * 1024
	const totalBuf = Buffer.alloc(TOTAL)
	for (let i = 0; i < TOTAL; i++) totalBuf[i] = (i * 7 + 13) & 0xff

	// Stream it through lib-storage — this forces CreateMultipartUpload + UploadPart(s)
	// and sets x-amz-content-sha256 to STREAMING-AWS4-HMAC-SHA256-PAYLOAD on each part,
	// exercising the aws-chunked decoder in handleUploadPart.
	const upload = new Upload({
		client: s3,
		params: { Bucket: BUCKET, Key: 'stream/big', Body: totalBuf },
		partSize: PART_SIZE,
		queueSize: 2,
	})
	await upload.done()

	const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'stream/big' }))
	expect(head.ContentLength).toBe(TOTAL)
	// Multipart ETag format: "hex-N"
	expect(head.ETag).toMatch(/^"[0-9a-f]+-\d+"$/)

	// Verify the bytes round-tripped by pulling a middle range
	const got = await s3.send(
		new GetObjectCommand({ Bucket: BUCKET, Key: 'stream/big', Range: `bytes=${PART_SIZE - 3}-${PART_SIZE + 4}` }),
	)
	const slice = await got.Body!.transformToByteArray()
	expect(slice.length).toBe(8)
	for (let i = 0; i < 8; i++) {
		const srcIdx = PART_SIZE - 3 + i
		expect(slice[i]).toBe(totalBuf[srcIdx])
	}
})

test('SDK: ListBuckets', async () => {
	const out = await s3.send(new ListBucketsCommand({}))
	const names = (out.Buckets ?? []).map((b) => b.Name).sort()
	expect(names).toEqual([OTHER_BUCKET, BUCKET].sort())
})

test('SDK: GetObjectAttributes returns requested attributes', async () => {
	await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'attrs/obj', Body: 'hello' }))
	const out = await s3.send(
		new GetObjectAttributesCommand({
			Bucket: BUCKET,
			Key: 'attrs/obj',
			ObjectAttributes: ['ETag', 'ObjectSize', 'StorageClass'],
		}),
	)
	expect(out.ObjectSize).toBe(5)
	expect(out.StorageClass).toBe('STANDARD')
	expect(out.ETag).toBeTruthy()
})

test('SDK: Object tagging round-trip', async () => {
	await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'tag/obj', Body: 'x' }))
	await s3.send(
		new PutObjectTaggingCommand({
			Bucket: BUCKET,
			Key: 'tag/obj',
			Tagging: { TagSet: [{ Key: 'env', Value: 'dev' }, { Key: 'owner', Value: 'nobile' }] },
		}),
	)
	const get = await s3.send(new GetObjectTaggingCommand({ Bucket: BUCKET, Key: 'tag/obj' }))
	const tags = (get.TagSet ?? []).map((t) => [t.Key, t.Value])
	expect(tags).toContainEqual(['env', 'dev'])
	expect(tags).toContainEqual(['owner', 'nobile'])

	await s3.send(new DeleteObjectTaggingCommand({ Bucket: BUCKET, Key: 'tag/obj' }))
	const after = await s3.send(new GetObjectTaggingCommand({ Bucket: BUCKET, Key: 'tag/obj' }))
	expect(after.TagSet ?? []).toHaveLength(0)
})

test('SDK: Bucket CORS round-trip', async () => {
	await s3.send(
		new PutBucketCorsCommand({
			Bucket: BUCKET,
			CORSConfiguration: {
				CORSRules: [{ AllowedMethods: ['GET', 'PUT'], AllowedOrigins: ['*'], AllowedHeaders: ['*'] }],
			},
		}),
	)
	const get = await s3.send(new GetBucketCorsCommand({ Bucket: BUCKET }))
	const rule = get.CORSRules?.[0]
	expect(rule?.AllowedMethods).toEqual(['GET', 'PUT'])
	expect(rule?.AllowedOrigins).toEqual(['*'])

	await s3.send(new DeleteBucketCorsCommand({ Bucket: BUCKET }))
	await expect(s3.send(new GetBucketCorsCommand({ Bucket: BUCKET }))).rejects.toThrow()
})

test('SDK: Presigned POST uploads via form-data', async () => {
	const post = await createPresignedPost(s3, {
		Bucket: BUCKET,
		Key: 'post/${filename}',
		Conditions: [['content-length-range', 0, 1_000_000]],
		Expires: 300,
	})

	const form = new FormData()
	for (const [k, v] of Object.entries(post.fields)) form.append(k, v as string)
	const file = new File(['uploaded via presigned post'], 'hello.txt', { type: 'text/plain' })
	form.append('file', file)

	const res = await fetch(post.url, { method: 'POST', body: form })
	expect(res.status).toBeLessThan(300)
	expect(await r2.get('post/hello.txt')).not.toBeNull()
})

test('SDK: UploadPartCopy via lib-storage large CopyObject', async () => {
	// Seed a ~12 MiB source, then use lib-storage Upload with UploadPartCopy
	// (lib-storage doesn't have a Copy helper that uses UploadPartCopy directly,
	//  so do it manually via CreateMultipartUpload + UploadPartCopyCommand).
	const { UploadPartCopyCommand } = await import('@aws-sdk/client-s3')
	const SIZE = 12 * 1024 * 1024
	const buf = Buffer.alloc(SIZE)
	for (let i = 0; i < SIZE; i++) buf[i] = (i * 31 + 5) & 0xff
	await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'ppcopy/src', Body: buf }))

	const create = await s3.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: 'ppcopy/dst' }))
	const uploadId = create.UploadId!

	// Copy source in two chunks via UploadPartCopy
	const mid = Math.floor(SIZE / 2)
	const p1 = await s3.send(
		new UploadPartCopyCommand({
			Bucket: BUCKET,
			Key: 'ppcopy/dst',
			UploadId: uploadId,
			PartNumber: 1,
			CopySource: `${BUCKET}/ppcopy/src`,
			CopySourceRange: `bytes=0-${mid - 1}`,
		}),
	)
	const p2 = await s3.send(
		new UploadPartCopyCommand({
			Bucket: BUCKET,
			Key: 'ppcopy/dst',
			UploadId: uploadId,
			PartNumber: 2,
			CopySource: `${BUCKET}/ppcopy/src`,
			CopySourceRange: `bytes=${mid}-${SIZE - 1}`,
		}),
	)

	await s3.send(
		new CompleteMultipartUploadCommand({
			Bucket: BUCKET,
			Key: 'ppcopy/dst',
			UploadId: uploadId,
			MultipartUpload: {
				Parts: [
					{ PartNumber: 1, ETag: p1.CopyPartResult?.ETag },
					{ PartNumber: 2, ETag: p2.CopyPartResult?.ETag },
				],
			},
		}),
	)

	const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'ppcopy/dst' }))
	expect(head.ContentLength).toBe(SIZE)
})
