import { test, expect, beforeEach, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db";
import { SqliteCache, SqliteCacheStorage } from "../bindings/cache";

let db: Database;
let cache: SqliteCache;

beforeEach(() => {
	db = new Database(":memory:");
	runMigrations(db);
	cache = new SqliteCache(db, "default");
});

describe("Cache.match", () => {
	test("returns undefined for non-existent entry", async () => {
		const result = await cache.match("https://example.com/missing");
		expect(result).toBeUndefined();
	});

	test("returns stored response", async () => {
		await cache.put("https://example.com/hello", new Response("world", { status: 200 }));
		const result = await cache.match("https://example.com/hello");
		expect(result).toBeDefined();
		expect(result!.status).toBe(200);
		expect(await result!.text()).toBe("world");
	});

	test("returns undefined for non-GET request", async () => {
		await cache.put("https://example.com/data", new Response("ok"));
		const result = await cache.match(new Request("https://example.com/data", { method: "POST" }));
		expect(result).toBeUndefined();
	});

	test("returns response for non-GET request with ignoreMethod", async () => {
		await cache.put("https://example.com/data", new Response("ok"));
		const result = await cache.match(new Request("https://example.com/data", { method: "POST" }), { ignoreMethod: true });
		expect(result).toBeDefined();
		expect(await result!.text()).toBe("ok");
	});

	test("preserves response headers", async () => {
		const resp = new Response("data", {
			status: 201,
			headers: { "Content-Type": "application/json", "X-Custom": "test" },
		});
		await cache.put("https://example.com/json", resp);
		const result = await cache.match("https://example.com/json");
		expect(result!.status).toBe(201);
		expect(result!.headers.get("X-Custom")).toBe("test");
	});

	test("accepts Request object", async () => {
		await cache.put(new Request("https://example.com/req"), new Response("from-request"));
		const result = await cache.match(new Request("https://example.com/req"));
		expect(result).toBeDefined();
		expect(await result!.text()).toBe("from-request");
	});

	test("adds cf-cache-status HIT header", async () => {
		await cache.put("https://example.com/hit", new Response("data"));
		const result = await cache.match("https://example.com/hit");
		expect(result).toBeDefined();
		expect(result!.headers.get("cf-cache-status")).toBe("HIT");
	});

	test("returns undefined for expired entry (max-age)", async () => {
		// Put with max-age=1
		const resp = new Response("expiring", {
			headers: { "Cache-Control": "max-age=0" },
		});
		await cache.put("https://example.com/expired", resp);
		// Wait a tiny bit so it expires
		await new Promise((r) => setTimeout(r, 10));
		const result = await cache.match("https://example.com/expired");
		expect(result).toBeUndefined();
	});

	test("returns response for non-expired entry (max-age)", async () => {
		const resp = new Response("fresh", {
			headers: { "Cache-Control": "max-age=3600" },
		});
		await cache.put("https://example.com/fresh", resp);
		const result = await cache.match("https://example.com/fresh");
		expect(result).toBeDefined();
		expect(await result!.text()).toBe("fresh");
	});

	test("lazily deletes expired entry from DB", async () => {
		const resp = new Response("gone", {
			headers: { "Cache-Control": "max-age=0" },
		});
		await cache.put("https://example.com/lazy-del", resp);
		await new Promise((r) => setTimeout(r, 10));

		// match returns undefined
		await cache.match("https://example.com/lazy-del");

		// Verify it's actually deleted from DB
		const row = db.query("SELECT * FROM cache_entries WHERE url = ?").get("https://example.com/lazy-del");
		expect(row).toBeNull();
	});
});

describe("Cache.put", () => {
	test("overwrites existing entry", async () => {
		await cache.put("https://example.com/key", new Response("v1"));
		await cache.put("https://example.com/key", new Response("v2"));
		const result = await cache.match("https://example.com/key");
		expect(await result!.text()).toBe("v2");
	});

	test("throws for non-GET request", async () => {
		const req = new Request("https://example.com/post", { method: "POST" });
		expect(cache.put(req, new Response("data"))).rejects.toThrow("Cache API only supports caching GET requests");
	});

	test("silently skips response with Set-Cookie header", async () => {
		const resp = new Response("data", { headers: { "Set-Cookie": "session=abc" } });
		await cache.put("https://example.com/cookie", resp);
		const result = await cache.match("https://example.com/cookie");
		expect(result).toBeUndefined();
	});

	test("stores binary body", async () => {
		const binary = new Uint8Array([1, 2, 3, 4, 5]);
		await cache.put("https://example.com/bin", new Response(binary));
		const result = await cache.match("https://example.com/bin");
		const body = new Uint8Array(await result!.arrayBuffer());
		expect(body).toEqual(binary);
	});

	test("rejects 206 Partial Content", async () => {
		const resp = new Response("partial", { status: 206 });
		expect(cache.put("https://example.com/partial", resp)).rejects.toThrow("206 Partial Content");
	});

	test("rejects Vary: *", async () => {
		const resp = new Response("vary", { headers: { Vary: "*" } });
		expect(cache.put("https://example.com/vary", resp)).rejects.toThrow("Vary: *");
	});

	test("does not cache response with no-store", async () => {
		const resp = new Response("secret", {
			headers: { "Cache-Control": "no-store" },
		});
		await cache.put("https://example.com/nostore", resp);
		const result = await cache.match("https://example.com/nostore");
		expect(result).toBeUndefined();
	});

	test("parses s-maxage over max-age", async () => {
		const resp = new Response("data", {
			headers: { "Cache-Control": "max-age=10, s-maxage=3600" },
		});
		await cache.put("https://example.com/smaxage", resp);
		// Should be cached with s-maxage=3600 (not expired)
		const result = await cache.match("https://example.com/smaxage");
		expect(result).toBeDefined();
		expect(await result!.text()).toBe("data");
	});

	test("parses Expires header as fallback", async () => {
		const futureDate = new Date(Date.now() + 3600 * 1000).toUTCString();
		const resp = new Response("expires", {
			headers: { Expires: futureDate },
		});
		await cache.put("https://example.com/expires", resp);
		const result = await cache.match("https://example.com/expires");
		expect(result).toBeDefined();
		expect(await result!.text()).toBe("expires");
	});

	test("expired Expires header causes immediate expiration", async () => {
		const pastDate = new Date(Date.now() - 1000).toUTCString();
		const resp = new Response("old", {
			headers: { Expires: pastDate },
		});
		await cache.put("https://example.com/past-expires", resp);
		const result = await cache.match("https://example.com/past-expires");
		expect(result).toBeUndefined();
	});

	test("stores expires_at in DB for max-age", async () => {
		const before = Date.now();
		const resp = new Response("data", {
			headers: { "Cache-Control": "max-age=60" },
		});
		await cache.put("https://example.com/ttl-check", resp);
		const after = Date.now();

		const row = db.query<{ expires_at: number | null }, [string]>(
			"SELECT expires_at FROM cache_entries WHERE url = ?"
		).get("https://example.com/ttl-check");

		expect(row).not.toBeNull();
		expect(row!.expires_at).not.toBeNull();
		// expires_at should be roughly now + 60s
		expect(row!.expires_at!).toBeGreaterThanOrEqual(before + 60000);
		expect(row!.expires_at!).toBeLessThanOrEqual(after + 60000);
	});

	test("stores null expires_at when no cache headers", async () => {
		await cache.put("https://example.com/no-ttl", new Response("forever"));
		const row = db.query<{ expires_at: number | null }, [string]>(
			"SELECT expires_at FROM cache_entries WHERE url = ?"
		).get("https://example.com/no-ttl");

		expect(row).not.toBeNull();
		expect(row!.expires_at).toBeNull();
	});
});

describe("Cache.delete", () => {
	test("returns true when entry deleted", async () => {
		await cache.put("https://example.com/del", new Response("gone"));
		const result = await cache.delete("https://example.com/del");
		expect(result).toBe(true);
	});

	test("returns false when entry does not exist", async () => {
		const result = await cache.delete("https://example.com/nonexistent");
		expect(result).toBe(false);
	});

	test("entry is gone after delete", async () => {
		await cache.put("https://example.com/key", new Response("val"));
		await cache.delete("https://example.com/key");
		expect(await cache.match("https://example.com/key")).toBeUndefined();
	});

	test("returns false for non-GET request", async () => {
		await cache.put("https://example.com/data", new Response("ok"));
		const result = await cache.delete(new Request("https://example.com/data", { method: "POST" }));
		expect(result).toBe(false);
	});

	test("deletes for non-GET request with ignoreMethod", async () => {
		await cache.put("https://example.com/data", new Response("ok"));
		const result = await cache.delete(new Request("https://example.com/data", { method: "POST" }), { ignoreMethod: true });
		expect(result).toBe(true);
		expect(await cache.match("https://example.com/data")).toBeUndefined();
	});
});

describe("CacheStorage", () => {
	test("default cache works", async () => {
		const storage = new SqliteCacheStorage(db);
		await storage.default.put("https://example.com/a", new Response("default"));
		const result = await storage.default.match("https://example.com/a");
		expect(await result!.text()).toBe("default");
	});

	test("open returns named cache", async () => {
		const storage = new SqliteCacheStorage(db);
		const named = await storage.open("my-cache");
		await named.put("https://example.com/b", new Response("named"));
		const result = await named.match("https://example.com/b");
		expect(await result!.text()).toBe("named");
	});

	test("named caches are isolated from default", async () => {
		const storage = new SqliteCacheStorage(db);
		await storage.default.put("https://example.com/shared", new Response("default-val"));
		const named = await storage.open("other");
		const result = await named.match("https://example.com/shared");
		expect(result).toBeUndefined();
	});

	test("different named caches are isolated", async () => {
		const storage = new SqliteCacheStorage(db);
		const cache1 = await storage.open("cache-1");
		const cache2 = await storage.open("cache-2");
		await cache1.put("https://example.com/key", new Response("from-1"));
		const result = await cache2.match("https://example.com/key");
		expect(result).toBeUndefined();
	});
});

describe("persistence", () => {
	test("data persists across Cache instances", async () => {
		const cache1 = new SqliteCache(db, "persist");
		await cache1.put("https://example.com/persist", new Response("saved"));

		const cache2 = new SqliteCache(db, "persist");
		const result = await cache2.match("https://example.com/persist");
		expect(result).toBeDefined();
		expect(await result!.text()).toBe("saved");
	});
});

describe("CacheLimits", () => {
	test("rejects body exceeding maxBodySize", async () => {
		const smallCache = new SqliteCache(db, "limited", { maxBodySize: 10 });
		const resp = new Response("this is more than 10 bytes");
		expect(smallCache.put("https://example.com/big", resp)).rejects.toThrow("exceeds max size");
	});

	test("accepts body within maxBodySize", async () => {
		const smallCache = new SqliteCache(db, "limited", { maxBodySize: 100 });
		await smallCache.put("https://example.com/ok", new Response("small"));
		const result = await smallCache.match("https://example.com/ok");
		expect(result).toBeDefined();
		expect(await result!.text()).toBe("small");
	});
});
