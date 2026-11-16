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

		const headers = new Headers(JSON.parse(row.headers))
		headers.set('cf-cache-status', 'HIT')
		return new Response(row.body as unknown as Bun.BodyInit, { status: row.status, headers })
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
