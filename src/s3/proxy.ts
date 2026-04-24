import type { FileR2Bucket, R2HTTPMetadata, R2ObjectBody } from '../bindings/r2'
import { decodeAwsChunked, isAwsChunked } from './chunked'
import { applyObjectHeaders, corsHeaders, evaluateConditional, extractPutOptions, parseConditional, parseRange } from './headers'
import {
	completeMultipartUploadXml,
	copyObjectResultXml,
	type DeleteResultEntry,
	deleteResultXml,
	getBucketLocationXml,
	initiateMultipartUploadXml,
	listBucketV1Xml,
	listBucketV2Xml,
	listMultipartUploadsXml,
	listPartsXml,
	type ListV1Params,
	type ListV2Params,
	parseCompletePartsXml,
	parseDeleteRequestXml,
	xmlError,
	xmlResponse,
} from './xml'

export type ResolveBucket = (name: string) => FileR2Bucket | undefined

/**
 * S3-compatible proxy over R2 bindings.
 *
 * Covers the R2-supported S3 ops: Get/Put/Head/Delete object, List v1/v2,
 * multipart upload, CopyObject, DeleteObjects, HeadBucket, GetBucketLocation.
 * No SigV4 auth — intended for local dev use.
 *
 * `resolveBucket` is used to look up another R2 binding for cross-bucket CopyObject.
 * When absent, only same-bucket copies are supported.
 */
export async function handleS3Request(
	req: Request,
	bucket: string,
	r2: FileR2Bucket | undefined,
	resolveBucket?: ResolveBucket,
): Promise<Response> {
	const url = new URL(req.url)
	const origin = req.headers.get('origin')
	const cors = corsHeaders(origin)

	if (req.method === 'OPTIONS') {
		return new Response(null, { headers: cors })
	}
	if (!r2) {
		return xmlError('NoSuchBucket', 'The specified bucket does not exist.', bucket, cors)
	}

	const sp = url.searchParams
	const rawKey = url.pathname.replace(/^\/+/, '')
	let key: string
	try {
		key = decodeURIComponent(rawKey)
	} catch {
		return xmlError('InvalidRequest', 'Invalid URL-encoded key', url.pathname, cors)
	}

	// Bucket-level ops — no key
	if (!key) {
		return handleBucketLevel(req, bucket, r2, url, sp, cors)
	}

	// Multipart object-level ops — detected by query params
	if (sp.has('uploads') && req.method === 'POST') {
		return handleCreateMultipartUpload(req, bucket, key, r2, cors)
	}
	const uploadId = sp.get('uploadId')
	if (uploadId) {
		if (req.method === 'PUT' && sp.has('partNumber')) {
			return handleUploadPart(req, bucket, key, r2, uploadId, Number(sp.get('partNumber')), cors)
		}
		if (req.method === 'POST') {
			return handleCompleteMultipartUpload(req, bucket, key, r2, uploadId, cors)
		}
		if (req.method === 'DELETE') {
			return handleAbortMultipartUpload(bucket, key, r2, uploadId, cors)
		}
		if (req.method === 'GET') {
			return handleListParts(bucket, key, r2, uploadId, cors)
		}
	}

	// Regular object ops
	switch (req.method) {
		case 'GET':
			return handleGetObject(req, bucket, key, r2, cors)
		case 'HEAD':
			return handleHeadObject(req, bucket, key, r2, cors)
		case 'PUT':
			return handlePutObject(req, bucket, key, r2, resolveBucket, cors)
		case 'DELETE':
			return handleDeleteObject(key, r2, cors)
	}
	return xmlError('InvalidRequest', `Unsupported method: ${req.method}`, url.pathname, cors)
}

// ─── Bucket-level dispatch ───────────────────────────────────────────────────

async function handleBucketLevel(
	req: Request,
	bucket: string,
	r2: FileR2Bucket,
	url: URL,
	sp: URLSearchParams,
	cors: Headers,
): Promise<Response> {
	if (req.method === 'HEAD') {
		return new Response(null, { status: 200, headers: cors })
	}
	if (req.method === 'GET' && sp.has('location')) {
		return xmlResponse(getBucketLocationXml(), 200, cors)
	}
	if (req.method === 'GET' && sp.has('uploads')) {
		const prefix = sp.get('prefix') ?? undefined
		const uploads = r2.listMultipartUploads(prefix)
		return xmlResponse(listMultipartUploadsXml(bucket, uploads), 200, cors)
	}
	if (req.method === 'POST' && sp.has('delete')) {
		return handleDeleteObjects(req, r2, cors)
	}
	if (req.method === 'GET') {
		return handleListObjects(bucket, r2, sp, cors)
	}
	return xmlError('InvalidRequest', `Unsupported bucket operation: ${req.method}`, url.pathname, cors)
}

async function handleListObjects(
	bucket: string,
	r2: FileR2Bucket,
	sp: URLSearchParams,
	cors: Headers,
): Promise<Response> {
	const listType = sp.get('list-type')
	if (listType === '2') {
		const params: ListV2Params = {
			prefix: sp.get('prefix') ?? undefined,
			continuationToken: sp.get('continuation-token') ?? undefined,
			maxKeys: sp.get('max-keys') ? Number(sp.get('max-keys')) : undefined,
			delimiter: sp.get('delimiter') ?? undefined,
		}
		const list = await r2.list({
			prefix: params.prefix,
			cursor: params.continuationToken,
			limit: params.maxKeys ?? 1000,
			delimiter: params.delimiter,
		})
		const body = listBucketV2Xml(
			bucket,
			params,
			list.objects,
			list.truncated,
			list.truncated && list.cursor ? list.cursor : undefined,
			list.delimitedPrefixes,
		)
		return xmlResponse(body, 200, cors)
	}

	// V1
	const params: ListV1Params = {
		prefix: sp.get('prefix') ?? undefined,
		marker: sp.get('marker') ?? undefined,
		maxKeys: sp.get('max-keys') ? Number(sp.get('max-keys')) : undefined,
		delimiter: sp.get('delimiter') ?? undefined,
	}
	const list = await r2.list({
		prefix: params.prefix,
		cursor: params.marker,
		limit: params.maxKeys ?? 1000,
		delimiter: params.delimiter,
	})
	const nextMarker = list.truncated && list.objects.length > 0
		? list.objects[list.objects.length - 1]!.key
		: undefined
	const body = listBucketV1Xml(bucket, params, list.objects, list.truncated, nextMarker, list.delimitedPrefixes)
	return xmlResponse(body, 200, cors)
}

async function handleDeleteObjects(req: Request, r2: FileR2Bucket, cors: Headers): Promise<Response> {
	const body = await req.text()
	const { keys, quiet } = parseDeleteRequestXml(body)
	const results: DeleteResultEntry[] = []
	for (const k of keys) {
		try {
			await r2.delete(k)
			results.push({ key: k })
		} catch (err) {
			results.push({ key: k, error: { code: 'InternalError', message: String(err) } })
		}
	}
	return xmlResponse(deleteResultXml(results, quiet), 200, cors)
}

// ─── Object-level handlers ───────────────────────────────────────────────────

async function handleGetObject(
	req: Request,
	bucket: string,
	key: string,
	r2: FileR2Bucket,
	cors: Headers,
): Promise<Response> {
	const range = parseRange(req.headers.get('range'))
	const head = await r2.head(key)
	if (!head) return xmlError('NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, cors)

	const cond = parseConditional(req.headers)
	const condResult = evaluateConditional(cond, head, 'read')
	if (condResult === 'precondition-failed') {
		return xmlError('PreconditionFailed', 'At least one of the preconditions failed', `/${bucket}/${key}`, cors)
	}
	if (condResult === 'not-modified') {
		const headers = applyObjectHeaders(head, new Headers(cors))
		return new Response(null, { status: 304, headers })
	}

	const obj = (await r2.get(key, { range: range ?? undefined })) as R2ObjectBody | null
	if (!obj) return xmlError('NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, cors)

	const headers = applyObjectHeaders(obj, new Headers(cors))
	if (range && obj.range) {
		const { offset, length } = obj.range
		headers.set('Content-Length', String(length))
		headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${head.size}`)
		return new Response(obj.body, { status: 206, headers })
	}
	return new Response(obj.body, { status: 200, headers })
}

async function handleHeadObject(
	req: Request,
	bucket: string,
	key: string,
	r2: FileR2Bucket,
	cors: Headers,
): Promise<Response> {
	const obj = await r2.head(key)
	if (!obj) return xmlError('NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, cors)

	const cond = parseConditional(req.headers)
	const condResult = evaluateConditional(cond, obj, 'read')
	const headers = applyObjectHeaders(obj, new Headers(cors))
	if (condResult === 'precondition-failed') return new Response(null, { status: 412, headers })
	if (condResult === 'not-modified') return new Response(null, { status: 304, headers })
	return new Response(null, { status: 200, headers })
}

async function handlePutObject(
	req: Request,
	bucket: string,
	key: string,
	r2: FileR2Bucket,
	resolveBucket: ResolveBucket | undefined,
	cors: Headers,
): Promise<Response> {
	const copySource = req.headers.get('x-amz-copy-source')
	if (copySource) {
		return handleCopyObject(req, bucket, key, r2, resolveBucket, copySource, cors)
	}

	// Conditional PUT: apply to existing object if any
	const cond = parseConditional(req.headers)
	if (cond.ifMatch || cond.ifNoneMatch || cond.ifUnmodifiedSince) {
		const existing = await r2.head(key)
		if (existing) {
			const res = evaluateConditional(cond, existing, 'write')
			if (res === 'precondition-failed') {
				return xmlError('PreconditionFailed', 'At least one of the preconditions failed', `/${bucket}/${key}`, cors)
			}
		} else if (cond.ifMatch) {
			return xmlError('PreconditionFailed', 'If-Match precondition failed (no object)', `/${bucket}/${key}`, cors)
		}
	}

	const { httpMetadata, customMetadata } = extractPutOptions(req)
	const body = decodedBody(req)
	const putRes = await r2.put(key, body, { httpMetadata, customMetadata })
	const headers = new Headers(cors)
	if (putRes) headers.set('ETag', `"${putRes.etag}"`)
	return new Response('', { status: 200, headers })
}

async function handleCopyObject(
	req: Request,
	destBucket: string,
	destKey: string,
	destR2: FileR2Bucket,
	resolveBucket: ResolveBucket | undefined,
	copySource: string,
	cors: Headers,
): Promise<Response> {
	const source = parseCopySource(copySource)
	if (!source) return xmlError('InvalidArgument', 'Invalid x-amz-copy-source header', copySource, cors)

	const srcR2 = source.bucket === destBucket ? destR2 : resolveBucket?.(source.bucket)
	if (!srcR2) return xmlError('NoSuchBucket', `Source bucket not found: ${source.bucket}`, copySource, cors)

	const srcObj = (await srcR2.get(source.key)) as R2ObjectBody | null
	if (!srcObj) return xmlError('NoSuchKey', 'Source object not found', copySource, cors)

	// metadataDirective=REPLACE copies request headers; otherwise inherit from source
	const directive = (req.headers.get('x-amz-metadata-directive') ?? 'COPY').toUpperCase()
	let httpMetadata: R2HTTPMetadata
	let customMetadata: Record<string, string>
	if (directive === 'REPLACE') {
		const opts = extractPutOptions(req)
		httpMetadata = opts.httpMetadata
		customMetadata = opts.customMetadata
	} else {
		httpMetadata = { ...srcObj.httpMetadata }
		customMetadata = { ...srcObj.customMetadata }
	}

	const data = await srcObj.arrayBuffer()
	const putRes = await destR2.put(destKey, data, { httpMetadata, customMetadata })
	if (!putRes) return xmlError('InvalidRequest', 'Copy failed', `/${destBucket}/${destKey}`, cors)
	return xmlResponse(copyObjectResultXml(putRes.etag, putRes.uploaded), 200, cors)
}

function parseCopySource(raw: string): { bucket: string; key: string } | null {
	let s = raw.trim()
	try {
		s = decodeURIComponent(s)
	} catch {
		return null
	}
	// Strip optional ?versionId=
	const q = s.indexOf('?')
	if (q !== -1) s = s.slice(0, q)
	if (s.startsWith('/')) s = s.slice(1)
	const slash = s.indexOf('/')
	if (slash === -1) return null
	return { bucket: s.slice(0, slash), key: s.slice(slash + 1) }
}

async function handleDeleteObject(key: string, r2: FileR2Bucket, cors: Headers): Promise<Response> {
	await r2.delete(key)
	return new Response('', { status: 204, headers: cors })
}

// ─── Multipart handlers ──────────────────────────────────────────────────────

async function handleCreateMultipartUpload(
	req: Request,
	bucket: string,
	key: string,
	r2: FileR2Bucket,
	cors: Headers,
): Promise<Response> {
	const { httpMetadata, customMetadata } = extractPutOptions(req)
	const upload = await r2.createMultipartUpload(key, { httpMetadata, customMetadata })
	return xmlResponse(initiateMultipartUploadXml(bucket, key, upload.uploadId), 200, cors)
}

async function handleUploadPart(
	req: Request,
	bucket: string,
	key: string,
	r2: FileR2Bucket,
	uploadId: string,
	partNumber: number,
	cors: Headers,
): Promise<Response> {
	if (!Number.isInteger(partNumber) || partNumber < 1) {
		return xmlError('InvalidArgument', 'Invalid partNumber', `/${bucket}/${key}`, cors)
	}
	const upload = r2.resumeMultipartUpload(key, uploadId)
	// r2.uploadPart accepts ArrayBuffer | ArrayBufferView | string | ReadableStream;
	// for aws-chunked, decode framing first then buffer.
	const body = decodedBody(req)
	// Buffer to ArrayBuffer — keeps behaviour simple and mirrors how FileR2Bucket
	// persists parts to disk anyway.
	const bytes = body ? new Uint8Array(await new Response(body).arrayBuffer()) : new Uint8Array(0)
	try {
		const part = await upload.uploadPart(partNumber, bytes)
		const headers = new Headers(cors)
		headers.set('ETag', `"${part.etag}"`)
		return new Response('', { status: 200, headers })
	} catch (err) {
		return xmlError('NoSuchUpload', String(err), `/${bucket}/${key}`, cors)
	}
}

async function handleCompleteMultipartUpload(
	req: Request,
	bucket: string,
	key: string,
	r2: FileR2Bucket,
	uploadId: string,
	cors: Headers,
): Promise<Response> {
	const xml = await req.text()
	const parts = parseCompletePartsXml(xml)
	if (parts.length === 0) return xmlError('MalformedXML', 'No parts in request', `/${bucket}/${key}`, cors)

	const upload = r2.resumeMultipartUpload(key, uploadId)
	try {
		const result = await upload.complete(parts)
		const location = `/${bucket}/${encodeURIComponent(key)}`
		return xmlResponse(completeMultipartUploadXml(bucket, key, result.etag, location), 200, cors)
	} catch (err) {
		const msg = String(err)
		if (msg.includes('etag mismatch')) {
			return xmlError('InvalidPart', msg, `/${bucket}/${key}`, cors)
		}
		return xmlError('NoSuchUpload', msg, `/${bucket}/${key}`, cors)
	}
}

async function handleAbortMultipartUpload(
	bucket: string,
	key: string,
	r2: FileR2Bucket,
	uploadId: string,
	cors: Headers,
): Promise<Response> {
	const upload = r2.resumeMultipartUpload(key, uploadId)
	await upload.abort()
	// S3 returns 204 whether or not the upload existed
	void bucket
	return new Response('', { status: 204, headers: cors })
}

async function handleListParts(
	bucket: string,
	key: string,
	r2: FileR2Bucket,
	uploadId: string,
	cors: Headers,
): Promise<Response> {
	const upload = r2.resumeMultipartUpload(key, uploadId)
	const parts = upload.listParts()
	return xmlResponse(listPartsXml(bucket, key, uploadId, parts), 200, cors)
}

// ─── Body helpers ────────────────────────────────────────────────────────────

function decodedBody(req: Request): ReadableStream<Uint8Array> | null {
	if (!req.body) return null
	if (isAwsChunked(req.headers)) return decodeAwsChunked(req.body)
	return req.body
}

// ─── Path matcher for the dev server ─────────────────────────────────────────

/**
 * Route dispatcher for /__s3/{bucket}/{key...}.
 * Returns null if pathname does not match; caller falls through to other routes.
 */
export function matchS3Path(pathname: string): { bucket: string; keyPath: string } | null {
	if (!pathname.startsWith('/__s3/')) return null
	const rest = pathname.slice('/__s3/'.length)
	const slash = rest.indexOf('/')
	if (slash === -1) return { bucket: rest, keyPath: '' }
	return { bucket: rest.slice(0, slash), keyPath: rest.slice(slash + 1) }
}
