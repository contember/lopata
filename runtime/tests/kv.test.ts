import { test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db";
import { SqliteKVNamespace } from "../bindings/kv";

let kv: SqliteKVNamespace;

beforeEach(() => {
  const db = new Database(":memory:");
  runMigrations(db);
  kv = new SqliteKVNamespace(db, "TEST_KV");
});

test("get non-existent key returns null", async () => {
  expect(await kv.get("missing")).toBeNull();
});

test("put and get text", async () => {
  await kv.put("key", "hello");
  expect(await kv.get("key")).toBe("hello");
});

test("put overwrites existing value", async () => {
  await kv.put("key", "first");
  await kv.put("key", "second");
  expect(await kv.get("key")).toBe("second");
});

test("delete removes key", async () => {
  await kv.put("key", "value");
  await kv.delete("key");
  expect(await kv.get("key")).toBeNull();
});

test("delete non-existent key is no-op", async () => {
  await kv.delete("missing"); // should not throw
});

test("get with type json", async () => {
  await kv.put("key", JSON.stringify({ a: 1 }));
  const result = await kv.get("key", "json");
  expect(result).toEqual({ a: 1 });
});

test("get with type arrayBuffer", async () => {
  await kv.put("key", "hello");
  const result = await kv.get("key", "arrayBuffer");
  expect(result).toBeInstanceOf(ArrayBuffer);
  expect(new TextDecoder().decode(result as ArrayBuffer)).toBe("hello");
});

test("get with type stream", async () => {
  await kv.put("key", "hello");
  const stream = (await kv.get("key", "stream")) as ReadableStream;
  const reader = stream.getReader();
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toBe("hello");
});

test("get with options object", async () => {
  await kv.put("key", JSON.stringify([1, 2]));
  const result = await kv.get("key", { type: "json" });
  expect(result).toEqual([1, 2]);
});

test("put with metadata and getWithMetadata", async () => {
  await kv.put("key", "val", { metadata: { tag: "test" } });
  const { value, metadata } = await kv.getWithMetadata("key");
  expect(value).toBe("val");
  expect(metadata).toEqual({ tag: "test" });
});

test("getWithMetadata returns null metadata when none set", async () => {
  await kv.put("key", "val");
  const { value, metadata } = await kv.getWithMetadata("key");
  expect(value).toBe("val");
  expect(metadata).toBeNull();
});

test("getWithMetadata for missing key", async () => {
  const { value, metadata } = await kv.getWithMetadata("missing");
  expect(value).toBeNull();
  expect(metadata).toBeNull();
});

test("put with expiration (absolute)", async () => {
  // expired in the past
  await kv.put("key", "val", { expiration: Date.now() / 1000 - 10 });
  expect(await kv.get("key")).toBeNull();
});

test("put with expirationTtl", async () => {
  // expires far in the future
  await kv.put("key", "val", { expirationTtl: 3600 });
  expect(await kv.get("key")).toBe("val");
});

test("put with expirationTtl of 0-ish expires immediately", async () => {
  await kv.put("key", "val", { expirationTtl: -1 });
  expect(await kv.get("key")).toBeNull();
});

test("list returns all keys", async () => {
  await kv.put("a", "1");
  await kv.put("b", "2");
  await kv.put("c", "3");
  const result = await kv.list();
  expect(result.keys.map((k) => k.name)).toEqual(["a", "b", "c"]);
  expect(result.list_complete).toBe(true);
});

test("list with prefix", async () => {
  await kv.put("user:1", "a");
  await kv.put("user:2", "b");
  await kv.put("post:1", "c");
  const result = await kv.list({ prefix: "user:" });
  expect(result.keys.map((k) => k.name)).toEqual(["user:1", "user:2"]);
});

test("list with limit", async () => {
  await kv.put("a", "1");
  await kv.put("b", "2");
  await kv.put("c", "3");
  const result = await kv.list({ limit: 2 });
  expect(result.keys).toHaveLength(2);
  expect(result.list_complete).toBe(false);
});

test("list empty namespace", async () => {
  const result = await kv.list();
  expect(result.keys).toEqual([]);
  expect(result.list_complete).toBe(true);
});

test("list filters out expired keys", async () => {
  await kv.put("good", "val");
  await kv.put("expired", "val", { expiration: Date.now() / 1000 - 10 });
  const result = await kv.list();
  expect(result.keys.map((k) => k.name)).toEqual(["good"]);
});

test("put ArrayBuffer and get as text", async () => {
  const buf = new TextEncoder().encode("binary").buffer;
  await kv.put("key", buf as ArrayBuffer);
  expect(await kv.get("key")).toBe("binary");
});

test("list with cursor pagination", async () => {
  await kv.put("a", "1");
  await kv.put("b", "2");
  await kv.put("c", "3");
  const first = await kv.list({ limit: 2 });
  expect(first.keys).toHaveLength(2);
  expect(first.list_complete).toBe(false);
  expect(first.cursor).toBeTruthy();

  const second = await kv.list({ cursor: first.cursor, limit: 2 });
  expect(second.keys.map((k) => k.name)).toEqual(["c"]);
  expect(second.list_complete).toBe(true);
});

test("namespaces are isolated", async () => {
  const db = new Database(":memory:");
  runMigrations(db);
  const kv1 = new SqliteKVNamespace(db, "NS1");
  const kv2 = new SqliteKVNamespace(db, "NS2");

  await kv1.put("key", "from-ns1");
  await kv2.put("key", "from-ns2");

  expect(await kv1.get("key")).toBe("from-ns1");
  expect(await kv2.get("key")).toBe("from-ns2");
});
