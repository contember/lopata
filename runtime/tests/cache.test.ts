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
