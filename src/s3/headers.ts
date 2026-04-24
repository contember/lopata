import type { R2Conditional, R2HTTPMetadata, R2Object, R2Range } from '../bindings/r2'

export function extractPutOptions(req: Request): {
	httpMetadata: R2HTTPMetadata
	customMetadata: Record<string, string>
} {
	const h = req.headers
	const httpMetadata: R2HTTPMetadata = {}
	const contentType = h.get('content-type')
	if (contentType) httpMetadata.contentType = contentType
	const contentLanguage = h.get('content-language')
	if (contentLanguage) httpMetadata.contentLanguage = contentLanguage
	const contentDisposition = h.get('content-disposition')
	if (contentDisposition) httpMetadata.contentDisposition = contentDisposition
	const contentEncoding = h.get('content-encoding')
	if (contentEncoding) httpMetadata.contentEncoding = contentEncoding
	const cacheControl = h.get('cache-control')
	if (cacheControl) httpMetadata.cacheControl = cacheControl
	const expires = h.get('expires')
	if (expires) {
		const d = new Date(expires)
		if (!Number.isNaN(d.getTime())) httpMetadata.cacheExpiry = d
	}

	const customMetadata: Record<string, string> = {}
	for (const [k, v] of h) {
		if (k.toLowerCase().startsWith('x-amz-meta-')) {
			customMetadata[k.slice('x-amz-meta-'.length)] = v
		}
	}
	return { httpMetadata, customMetadata }
}

export function applyObjectHeaders(obj: R2Object, headers = new Headers()): Headers {
	headers.set('ETag', `"${obj.etag}"`)
	headers.set('Last-Modified', obj.uploaded.toUTCString())
	headers.set('Content-Length', String(obj.size))
	const m = obj.httpMetadata
	if (m.contentType) headers.set('Content-Type', m.contentType)
	if (m.contentLanguage) headers.set('Content-Language', m.contentLanguage)
	if (m.contentDisposition) headers.set('Content-Disposition', m.contentDisposition)
	if (m.contentEncoding) headers.set('Content-Encoding', m.contentEncoding)
	if (m.cacheControl) headers.set('Cache-Control', m.cacheControl)
	if (m.cacheExpiry) headers.set('Expires', m.cacheExpiry.toUTCString())
	for (const [k, v] of Object.entries(obj.customMetadata)) {
		headers.set(`x-amz-meta-${k}`, v)
	}
	return headers
}

/**
 * Parse a Range header: bytes=<start>-<end> | bytes=<start>- | bytes=-<suffix>.
 * Returns null if the header is absent or malformed.
 */
export function parseRange(header: string | null): R2Range | null {
	if (!header) return null
	const m = header.match(/^bytes=(\d*)-(\d*)$/)
	if (!m) return null
	const startStr = m[1]!
	const endStr = m[2]!
	if (startStr === '' && endStr === '') return null
	if (startStr === '') {
		return { suffix: Number(endStr) }
	}
	const offset = Number(startStr)
	if (endStr === '') return { offset }
	return { offset, length: Number(endStr) - offset + 1 }
}

export interface Conditional {
	ifMatch?: string[]
	ifNoneMatch?: string[]
	ifModifiedSince?: Date
	ifUnmodifiedSince?: Date
}

export function parseConditional(headers: Headers): Conditional {
	const c: Conditional = {}
	const ifMatch = headers.get('if-match')
	if (ifMatch) c.ifMatch = ifMatch.split(',').map((s) => s.trim().replace(/^"|"$/g, ''))
	const ifNoneMatch = headers.get('if-none-match')
	if (ifNoneMatch) c.ifNoneMatch = ifNoneMatch.split(',').map((s) => s.trim().replace(/^"|"$/g, ''))
	const ims = headers.get('if-modified-since')
	if (ims) {
		const d = new Date(ims)
		if (!Number.isNaN(d.getTime())) c.ifModifiedSince = d
	}
	const iums = headers.get('if-unmodified-since')
	if (iums) {
		const d = new Date(iums)
		if (!Number.isNaN(d.getTime())) c.ifUnmodifiedSince = d
	}
	return c
}

/**
 * Evaluate a conditional against an existing object.
 * Returns 'match' (preconditions met, proceed), 'not-modified' (GET/HEAD 304),
 * or 'precondition-failed' (412).
 *
 * Per RFC 7232 & S3 semantics:
 *   If-Match fails → 412
 *   If-Unmodified-Since fails → 412
 *   If-None-Match matches → 304 for GET/HEAD, 412 for others
 *   If-Modified-Since not modified → 304 for GET/HEAD, ignored otherwise
 */
export type ConditionalResult = 'match' | 'not-modified' | 'precondition-failed'

export function evaluateConditional(
	cond: Conditional,
	obj: { etag: string; uploaded: Date },
	method: 'read' | 'write',
): ConditionalResult {
	const etag = obj.etag
	// Normalise "uploaded" to second precision — HTTP dates have 1-second resolution.
	const uploadedSec = Math.floor(obj.uploaded.getTime() / 1000) * 1000

	if (cond.ifMatch) {
		const matches = cond.ifMatch.some((t) => t === '*' || t === etag)
		if (!matches) return 'precondition-failed'
	}
	if (cond.ifUnmodifiedSince) {
		if (uploadedSec > cond.ifUnmodifiedSince.getTime()) return 'precondition-failed'
	}
	if (cond.ifNoneMatch) {
		const matches = cond.ifNoneMatch.some((t) => t === '*' || t === etag)
		if (matches) return method === 'read' ? 'not-modified' : 'precondition-failed'
	}
	if (cond.ifModifiedSince && method === 'read') {
		if (uploadedSec <= cond.ifModifiedSince.getTime()) return 'not-modified'
	}
	return 'match'
}

export function corsHeaders(origin: string | null): Headers {
	const h = new Headers()
	h.set('Access-Control-Allow-Origin', origin ?? '*')
	h.set('Access-Control-Allow-Methods', 'GET, PUT, POST, HEAD, DELETE, OPTIONS')
	h.set('Access-Control-Allow-Headers', '*')
	h.set('Access-Control-Expose-Headers', '*')
	return h
}

// Tell R2 it was conditionally fetched but we want R2 to return the body regardless —
// S3 evaluates the conditions itself on top. We just use R2 as a byte store here.
export type { R2Conditional }
