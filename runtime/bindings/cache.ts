import type { Database } from "bun:sqlite";

export class SqliteCache {
	private db: Database;
	private cacheName: string;

	constructor(db: Database, cacheName: string) {
		this.db = db;
		this.cacheName = cacheName;
	}

	async match(request: Request | string, options?: { ignoreMethod?: boolean }): Promise<Response | undefined> {
		const req = typeof request === "string" ? new Request(request) : request;

		// Only GET requests are cacheable unless ignoreMethod is true
		if (req.method !== "GET" && !options?.ignoreMethod) {
			return undefined;
		}

		const url = req.url;
		const row = this.db.query<{ status: number; headers: string; body: Uint8Array }, [string, string]>(
			"SELECT status, headers, body FROM cache_entries WHERE cache_name = ? AND url = ?"
		).get(this.cacheName, url);

		if (!row) return undefined;

		const headers = new Headers(JSON.parse(row.headers));
		return new Response(row.body, { status: row.status, headers });
	}

	async put(request: Request | string, response: Response): Promise<void> {
		const req = typeof request === "string" ? new Request(request) : request;

		// Only GET requests are cacheable
		if (req.method !== "GET") {
			throw new Error("Cache API only supports caching GET requests");
		}

		// Responses with Set-Cookie header should not be cached (Cloudflare behavior)
		if (response.headers.has("Set-Cookie")) {
			return;
		}

		const url = req.url;
		const status = response.status;
		const headers = JSON.stringify([...response.headers.entries()]);
		const body = new Uint8Array(await response.arrayBuffer());

		this.db.query(
			"INSERT OR REPLACE INTO cache_entries (cache_name, url, status, headers, body) VALUES (?, ?, ?, ?, ?)"
		).run(this.cacheName, url, status, headers, body);
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
	public default: SqliteCache;

	constructor(db: Database) {
		this.db = db;
		this.default = new SqliteCache(db, "default");
	}

	async open(cacheName: string): Promise<SqliteCache> {
		return new SqliteCache(this.db, cacheName);
	}
}
