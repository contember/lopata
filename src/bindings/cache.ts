import type { Database } from 'bun:sqlite'
import type { Clock } from '../testing/clock'
import { realClock } from '../testing/clock'

export interface CacheLimits {
	maxBodySize?: number // default 512 MiB (CF limit)
	maxHeaderSize?: number // default 32 KiB per header pair
}

const CACHE_DEFAULTS: Required<CacheLimits> = {
	maxBodySize: 512 * 1024 * 1024,
	maxHeaderSize: 32 * 1024,
}

/**
 * Parse Cache-Control into lower-cased directive names mapped to their unquoted value (null when bare).
 * Commas inside quoted values (e.g. `private="set-cookie, x"`) do not split directives.
 */
function parseCacheControl(header: string | null): Map<string, string | null> {
	const directives = new Map<string, string | null>()
	if (!header) return directives
	for (const part of header.match(/(?:[^,"]|"[^"]*")+/g) ?? []) {
		const eq = part.indexOf('=')
		const name = (eq === -1 ? part : part.slice(0, eq)).trim().toLowerCase()
		if (!name) continue
		const value = eq === -1 ? null : part.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1')
		directives.set(name, value)
	}
	return directives
}

function parseSeconds(value: string | null | undefined): number | null {
	return value && /^\d+$/.test(value) ? parseInt(value, 10) : null
}

type StoragePolicy =
	| { storable: false }
	| { storable: true; expiresAt: number | null; stripSetCookie: boolean }

/**
 * Decide whether Cloudflare's cache would store this response and until when (ms since epoch, null = no expiry info).
 * Shared-cache rules: `no-store`, `no-cache` and `private` are not stored; a Set-Cookie response is stored only with
 * `private=set-cookie`, which strips the cookie (as Miniflare's cache.worker.ts getExpiration does).
 */
function storagePolicy(headers: Headers, now: number): StoragePolicy {
	const cc = parseCacheControl(headers.get('cache-control'))
	if (cc.has('no-store') || cc.has('no-cache')) return { storable: false }

	let stripSetCookie = false
	if (cc.has('private')) {
		if (cc.get('private')?.toLowerCase() !== 'set-cookie') return { storable: false }
		stripSetCookie = true
	}
	if (headers.has('set-cookie') && !stripSetCookie) return { storable: false }

	// s-maxage takes precedence over max-age for shared caches
	const maxAge = parseSeconds(cc.get('s-maxage')) ?? parseSeconds(cc.get('max-age'))
	if (maxAge !== null) return { storable: true, expiresAt: now + maxAge * 1000, stripSetCookie }

	const expires = headers.get('expires')
	const expiresTime = expires ? Date.parse(expires) : NaN
	return { storable: true, expiresAt: Number.isNaN(expiresTime) ? null : expiresTime, stripSetCookie }
}

const ETAG = /^(W\/)?"(.+)"$/

// If-None-Match always uses weak comparison, so the W/ prefix is ignored.
function parseETag(value: string): string | undefined {
	return ETAG.exec(value.trim())?.[2]
}

const IMF_FIXDATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d\d (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d\d:\d\d:\d\d GMT$/

function parseHttpDate(value: string): number {
	return IMF_FIXDATE.test(value) ? Date.parse(value) : NaN
}

/**
 * Evaluate If-None-Match / If-Modified-Since against the cached response, as Miniflare's
 * cache.worker.ts getMatchResponse does for Cloudflare's cache.
 */
function isNotModified(requestHeaders: Headers, responseHeaders: Headers): boolean {
	const ifNoneMatch = requestHeaders.get('if-none-match')
	const etag = parseETag(responseHeaders.get('etag') ?? '')
	if (ifNoneMatch !== null && etag !== undefined) {
		if (ifNoneMatch.trim() === '*') return true
		if (ifNoneMatch.split(',').some((candidate) => parseETag(candidate) === etag)) return true
	}

	const ifModifiedSince = requestHeaders.get('if-modified-since')
	const lastModified = responseHeaders.get('last-modified')
	if (ifModifiedSince === null || lastModified === null) return false
	// An invalid date on either side is NaN, which compares false
	return parseHttpDate(lastModified) <= parseHttpDate(ifModifiedSince)
}

interface ByteRange {
	start: number // inclusive
	end: number // inclusive
}

const RANGE_UNIT = /^ *bytes *=/i
const RANGE_SPEC = /^ *(\d+)? *- *(\d+)? *$/

/**
 * Parse a Range header against a body of `length` bytes, as Miniflare's shared/range.ts parseRanges does:
 * undefined = not satisfiable (416), [] = serve the whole body, otherwise the ranges to serve.
 */
function parseRanges(header: string, length: number): ByteRange[] | undefined {
	const unit = RANGE_UNIT.exec(header)
	if (!unit) return undefined
	const specs = header.slice(unit[0].length)
	if (specs.trim() === '') return []

	const ranges: ByteRange[] = []
	for (const spec of specs.split(',')) {
		const match = RANGE_SPEC.exec(spec)
		if (!match) return undefined
		const [, start, end] = match
		if (start !== undefined) {
			const rangeStart = parseInt(start, 10)
			const rangeEnd = end === undefined ? length - 1 : parseInt(end, 10)
			if (rangeStart > rangeEnd || rangeStart >= length) return undefined
			ranges.push({ start: rangeStart, end: Math.min(rangeEnd, length - 1) })
		} else if (end !== undefined) {
			const suffix = parseInt(end, 10)
			if (suffix >= length) return []
			if (suffix === 0) continue
			ranges.push({ start: length - suffix, end: length - 1 })
		} else {
			return undefined
		}
	}
	// Overlapping or repeated ranges could multiply the body; RFC 9110 §14.2 lets a server ignore Range and send it whole.
	const total = ranges.reduce((sum, { start, end }) => sum + end - start + 1, 0)
	return total > length ? [] : ranges
}

function multipartByteRanges(body: Uint8Array, ranges: ByteRange[], contentType: string | null): { boundary: string; body: Blob } {
	const boundary = `lopata-boundary-${crypto.randomUUID()}`
	const parts: Bun.BlobPart[] = []
	for (const [i, { start, end }] of ranges.entries()) {
		const typeLine = contentType === null ? '' : `Content-Type: ${contentType}\r\n`
		parts.push(`${i > 0 ? '\r\n' : ''}--${boundary}\r\n${typeLine}Content-Range: bytes ${start}-${end}/${body.byteLength}\r\n\r\n`)
		parts.push(body.subarray(start, end + 1))
	}
	parts.push(`\r\n--${boundary}--`)
	return { boundary, body: new Blob(parts) }
}

export class SqliteCache {
	private db: Database
	private cacheName: string
	private limits: Required<CacheLimits>
	private clock: Clock

	constructor(db: Database, cacheName: string, limits?: CacheLimits, clock?: Clock) {
		this.db = db
		this.cacheName = cacheName
		this.limits = { ...CACHE_DEFAULTS, ...limits }
		this.clock = clock ?? realClock
	}

	async match(request: Request | string, options?: { ignoreMethod?: boolean }): Promise<Response | undefined> {
		const req = typeof request === 'string' ? new Request(request) : request

		// Only GET requests are cacheable unless ignoreMethod is true
		if (req.method !== 'GET' && !options?.ignoreMethod) {
			return undefined
		}

		const url = req.url
		const row = this.db.query<{ status: number; headers: string; body: Uint8Array; expires_at: number | null }, [string, string]>(
			'SELECT status, headers, body, expires_at FROM cache_entries WHERE cache_name = ? AND url = ?',
		).get(this.cacheName, url)

		if (!row) return undefined

		// Check expiration — lazily delete expired entries
		if (row.expires_at !== null && row.expires_at <= this.clock.now()) {
			this.db.query(
				'DELETE FROM cache_entries WHERE cache_name = ? AND url = ?',
			).run(this.cacheName, url)
			return undefined
		}

		const size = row.body.byteLength
		const rangeHeader = req.headers.get('range')
		const ranges = rangeHeader === null ? [] : parseRanges(rangeHeader, size)
		if (ranges === undefined) {
			return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'CF-Cache-Status': 'HIT' } })
		}

		const headers = new Headers(JSON.parse(row.headers))
		headers.set('cf-cache-status', 'HIT')
		if (isNotModified(req.headers, headers)) {
			return new Response(null, { status: 304, headers })
		}

		const [range, ...moreRanges] = ranges
		if (range === undefined) {
			return new Response(row.body as unknown as Bun.BodyInit, { status: row.status, headers })
		}
		if (moreRanges.length === 0) {
			headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
			headers.set('Content-Length', String(range.end - range.start + 1))
			return new Response(row.body.slice(range.start, range.end + 1), { status: 206, headers })
		}
		const multipart = multipartByteRanges(row.body, ranges, headers.get('content-type'))
		headers.set('Content-Type', `multipart/byteranges; boundary=${multipart.boundary}`)
		headers.set('Content-Length', String(multipart.body.size))
		return new Response(multipart.body, { status: 206, headers })
	}

	async put(request: Request | string, response: Response): Promise<void> {
		const req = typeof request === 'string' ? new Request(request) : request

		// Only GET requests are cacheable
		if (req.method !== 'GET') {
			throw new Error('Cache API only supports caching GET requests')
		}

		// Reject 206 Partial Content
		if (response.status === 206) {
			throw new Error('Cache API does not support caching 206 Partial Content responses')
		}

		// workerd discards a 304 instead of storing it, so writing back a revalidation result keeps the full entry.
		if (response.status === 304) return

		// Reject Vary: *
		const vary = response.headers.get('vary')
		if (vary && vary.trim() === '*') {
			throw new Error('Cache API does not support caching responses with Vary: *')
		}

		const policy = storagePolicy(response.headers, this.clock.now())
		if (!policy.storable) {
			return
		}

		const storedHeaders = new Headers(response.headers)
		if (policy.stripSetCookie) {
			storedHeaders.delete('set-cookie')
		}

		const url = req.url
		const status = response.status
		const expiresAt = policy.expiresAt
		const headers = JSON.stringify(Array.from(storedHeaders))
		const body = new Uint8Array(await response.arrayBuffer())

		// Validate body size
		if (body.byteLength > this.limits.maxBodySize) {
			throw new Error(`Response body exceeds max size of ${this.limits.maxBodySize} bytes`)
		}

		this.db.query(
			'INSERT OR REPLACE INTO cache_entries (cache_name, url, status, headers, body, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
		).run(this.cacheName, url, status, headers, body, expiresAt)
	}

	async delete(request: Request | string, options?: { ignoreMethod?: boolean }): Promise<boolean> {
		const req = typeof request === 'string' ? new Request(request) : request

		// Only GET requests are cacheable unless ignoreMethod is true
		if (req.method !== 'GET' && !options?.ignoreMethod) {
			return false
		}

		const url = req.url
		const result = this.db.query(
			'DELETE FROM cache_entries WHERE cache_name = ? AND url = ?',
		).run(this.cacheName, url)

		return result.changes > 0
	}
}

export class SqliteCacheStorage {
	private db: Database
	private limits?: CacheLimits
	private clock: Clock
	public default: SqliteCache

	constructor(db: Database, limits?: CacheLimits, clock?: Clock) {
		this.db = db
		this.limits = limits
		this.clock = clock ?? realClock
		this.default = new SqliteCache(db, 'default', limits, this.clock)
	}

	async open(cacheName: string): Promise<SqliteCache> {
		return new SqliteCache(this.db, cacheName, this.limits, this.clock)
	}
}
