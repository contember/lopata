import type { Database } from "bun:sqlite";

export interface CacheLimits {
	maxBodySize?: number; // default 512 MiB (CF limit)
	maxHeaderSize?: number; // default 32 KiB per header pair
}

const CACHE_DEFAULTS: Required<CacheLimits> = {
	maxBodySize: 512 * 1024 * 1024,
	maxHeaderSize: 32 * 1024,
};

/**
 * Parse Cache-Control header and return the effective max-age in seconds,
 * or null if no cacheable directive found.
 * Returns -1 for no-store (should not be cached at all).
 */
function parseCacheControlMaxAge(header: string | null): number | null {
	if (!header) return null;

	const directives = header.toLowerCase().split(",").map((d) => d.trim());

	for (const d of directives) {
		if (d === "no-store") return -1;
	}

	// s-maxage takes precedence over max-age for shared caches (CF behavior)
	for (const d of directives) {
		const sMaxAgeMatch = d.match(/^s-maxage\s*=\s*(\d+)$/);
		if (sMaxAgeMatch?.[1]) return parseInt(sMaxAgeMatch[1], 10);
	}

	for (const d of directives) {
		const maxAgeMatch = d.match(/^max-age\s*=\s*(\d+)$/);
		if (maxAgeMatch?.[1]) return parseInt(maxAgeMatch[1], 10);
	}

	return null;
}

/**
 * Compute the expiration timestamp (ms since epoch) from response headers.
 * Returns null if no expiration info is present (cache indefinitely).
 */
function computeExpiresAt(headers: Headers): number | null {
	const cacheControl = headers.get("cache-control");
	const maxAge = parseCacheControlMaxAge(cacheControl);

	if (maxAge === -1) return -1; // signal: no-store
	if (maxAge !== null) return Date.now() + maxAge * 1000;

	// Fallback to Expires header
	const expires = headers.get("expires");
	if (expires) {
		const expiresTime = Date.parse(expires);
		if (!isNaN(expiresTime)) return expiresTime;
	}

	return null;
}

export class SqliteCache {
	private db: Database;
	private cacheName: string;
	private limits: Required<CacheLimits>;

	constructor(db: Database, cacheName: string, limits?: CacheLimits) {
		this.db = db;
		this.cacheName = cacheName;
		this.limits = { ...CACHE_DEFAULTS, ...limits };
	}

	async match(request: Request | string, options?: { ignoreMethod?: boolean }): Promise<Response | undefined> {
		const req = typeof request === "string" ? new Request(request) : request;

		// Only GET requests are cacheable unless ignoreMethod is true
		if (req.method !== "GET" && !options?.ignoreMethod) {
			return undefined;
		}

		const url = req.url;
		const row = this.db.query<{ status: number; headers: string; body: Uint8Array; expires_at: number | null }, [string, string]>(
			"SELECT status, headers, body, expires_at FROM cache_entries WHERE cache_name = ? AND url = ?"
		).get(this.cacheName, url);

		if (!row) return undefined;

		// Check expiration — lazily delete expired entries
		if (row.expires_at !== null && row.expires_at <= Date.now()) {
			this.db.query(
				"DELETE FROM cache_entries WHERE cache_name = ? AND url = ?"
			).run(this.cacheName, url);
			return undefined;
		}

		const headers = new Headers(JSON.parse(row.headers));
		headers.set("cf-cache-status", "HIT");
		return new Response(row.body as unknown as BodyInit, { status: row.status, headers });
	}

	async put(request: Request | string, response: Response): Promise<void> {
		const req = typeof request === "string" ? new Request(request) : request;

		// Only GET requests are cacheable
		if (req.method !== "GET") {
			throw new Error("Cache API only supports caching GET requests");
		}

		// Reject 206 Partial Content
		if (response.status === 206) {
			throw new Error("Cache API does not support caching 206 Partial Content responses");
		}

		// Reject Vary: *
		const vary = response.headers.get("vary");
		if (vary && vary.trim() === "*") {
			throw new Error("Cache API does not support caching responses with Vary: *");
		}

		// Responses with Set-Cookie header should not be cached (Cloudflare behavior)
		if (response.headers.has("Set-Cookie")) {
			return;
		}

		// Parse expiration from Cache-Control / Expires
		const expiresAt = computeExpiresAt(response.headers);

		// no-store — don't cache at all
		if (expiresAt === -1) {
			return;
		}

		const url = req.url;
		const status = response.status;
		const headers = JSON.stringify(Array.from(response.headers as unknown as Iterable<[string, string]>));
		const body = new Uint8Array(await response.arrayBuffer());

		// Validate body size
		if (body.byteLength > this.limits.maxBodySize) {
			throw new Error(`Response body exceeds max size of ${this.limits.maxBodySize} bytes`);
		}

		this.db.query(
			"INSERT OR REPLACE INTO cache_entries (cache_name, url, status, headers, body, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
		).run(this.cacheName, url, status, headers, body, expiresAt);
	}

	async delete(request: Request | string, options?: { ignoreMethod?: boolean }): Promise<boolean> {
		const req = typeof request === "string" ? new Request(request) : request;

		// Only GET requests are cacheable unless ignoreMethod is true
		if (req.method !== "GET" && !options?.ignoreMethod) {
			return false;
		}

		const url = req.url;
		const result = this.db.query(
			"DELETE FROM cache_entries WHERE cache_name = ? AND url = ?"
		).run(this.cacheName, url);

		return result.changes > 0;
	}
}

export class SqliteCacheStorage {
	private db: Database;
	private limits?: CacheLimits;
	public default: SqliteCache;

	constructor(db: Database, limits?: CacheLimits) {
		this.db = db;
		this.limits = limits;
		this.default = new SqliteCache(db, "default", limits);
	}

	async open(cacheName: string): Promise<SqliteCache> {
		return new SqliteCache(this.db, cacheName, this.limits);
	}
}
