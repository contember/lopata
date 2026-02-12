import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../db";
import { FileR2Bucket } from "../bindings/r2";

let r2: FileR2Bucket;
let db: Database;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "r2-test-"));
  db = new Database(":memory:");
  runMigrations(db);
  r2 = new FileR2Bucket(db, "test-bucket", tmpDir);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test("get non-existent key returns null", async () => {
  expect(await r2.get("missing")).toBeNull();
});

test("put string and get", async () => {
  await r2.put("key", "hello world");
  const obj = await r2.get("key");
  expect(obj).not.toBeNull();
  expect(await obj!.text()).toBe("hello world");
});

test("put and get as arrayBuffer", async () => {
  await r2.put("key", "data");
  const obj = await r2.get("key");
  const buf = await obj!.arrayBuffer();
  expect(new TextDecoder().decode(buf)).toBe("data");
});

test("put and get as json", async () => {
  await r2.put("key", JSON.stringify({ x: 42 }));
  const obj = await r2.get("key");
  expect(await obj!.json<{ x: number }>()).toEqual({ x: 42 });
});

test("put and read body stream", async () => {
  await r2.put("key", "stream-data");
  const obj = await r2.get("key");
  const reader = obj!.body.getReader();
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toBe("stream-data");
});

test("put ArrayBuffer", async () => {
  const data = new TextEncoder().encode("binary").buffer as ArrayBuffer;
  await r2.put("key", data);
  const obj = await r2.get("key");
  expect(await obj!.text()).toBe("binary");
});

test("put null creates empty object", async () => {
  await r2.put("key", null);
  const obj = await r2.get("key");
  expect(obj).not.toBeNull();
  expect(obj!.size).toBe(0);
  expect(await obj!.text()).toBe("");
});

test("put Blob", async () => {
  const blob = new Blob(["blob-data"]);
  await r2.put("key", blob);
  const obj = await r2.get("key");
  expect(await obj!.text()).toBe("blob-data");
});

test("head returns metadata without body", async () => {
  await r2.put("key", "hello");
  const obj = await r2.head("key");
  expect(obj).not.toBeNull();
  expect(obj!.key).toBe("key");
  expect(obj!.size).toBe(5);
  expect(obj!.uploaded).toBeInstanceOf(Date);
  expect((obj as any).body).toBeUndefined();
});

test("head non-existent returns null", async () => {
  expect(await r2.head("missing")).toBeNull();
});

test("delete removes object", async () => {
  await r2.put("key", "val");
  await r2.delete("key");
  expect(await r2.get("key")).toBeNull();
});

test("delete array of keys", async () => {
  await r2.put("a", "1");
  await r2.put("b", "2");
  await r2.put("c", "3");
  await r2.delete(["a", "b"]);
  expect(await r2.get("a")).toBeNull();
  expect(await r2.get("b")).toBeNull();
  expect(await r2.get("c")).not.toBeNull();
});

test("delete non-existent is no-op", async () => {
  await r2.delete("missing"); // should not throw
});

test("put overwrites existing object", async () => {
  await r2.put("key", "first");
  await r2.put("key", "second");
  const obj = await r2.get("key");
  expect(await obj!.text()).toBe("second");
});

test("put with custom metadata", async () => {
  await r2.put("key", "data", { customMetadata: { tag: "test" } });
  const obj = await r2.get("key");
  expect(obj!.customMetadata).toEqual({ tag: "test" });
});

test("put returns R2Object with correct properties", async () => {
  const result = await r2.put("key", "hello");
  expect(result.key).toBe("key");
  expect(result.size).toBe(5);
  expect(result.uploaded).toBeInstanceOf(Date);
});

test("list returns all objects", async () => {
  await r2.put("a", "1");
  await r2.put("b", "2");
  const result = await r2.list();
  expect(result.objects).toHaveLength(2);
  expect(result.objects.map((o) => o.key)).toEqual(["a", "b"]);
  expect(result.truncated).toBe(false);
});

test("list with prefix", async () => {
  await r2.put("img/a.png", "1");
  await r2.put("img/b.png", "2");
  await r2.put("doc/c.txt", "3");
  const result = await r2.list({ prefix: "img/" });
  expect(result.objects.map((o) => o.key)).toEqual(["img/a.png", "img/b.png"]);
});

test("list with limit", async () => {
  await r2.put("a", "1");
  await r2.put("b", "2");
  await r2.put("c", "3");
  const result = await r2.list({ limit: 2 });
  expect(result.objects).toHaveLength(2);
  expect(result.truncated).toBe(true);
});

test("list empty bucket", async () => {
  const result = await r2.list();
  expect(result.objects).toEqual([]);
  expect(result.truncated).toBe(false);
});

test("nested keys with slashes", async () => {
  await r2.put("a/b/c.txt", "nested");
  const obj = await r2.get("a/b/c.txt");
  expect(await obj!.text()).toBe("nested");
});

test("put returns etag", async () => {
  const result = await r2.put("key", "hello");
  expect(result.etag).toBeTruthy();
  expect(typeof result.etag).toBe("string");
});

test("path traversal is rejected", async () => {
  expect(r2.put("../escape", "bad")).rejects.toThrow("path traversal");
});

test("bucket isolation", async () => {
  const r2b = new FileR2Bucket(db, "other-bucket", tmpDir);
  await r2.put("key", "bucket-a");
  await r2b.put("key", "bucket-b");
  expect(await (await r2.get("key"))!.text()).toBe("bucket-a");
  expect(await (await r2b.get("key"))!.text()).toBe("bucket-b");
});

test("list with cursor pagination", async () => {
  await r2.put("a", "1");
  await r2.put("b", "2");
  await r2.put("c", "3");
  const page1 = await r2.list({ limit: 2 });
  expect(page1.objects).toHaveLength(2);
  expect(page1.truncated).toBe(true);
  expect(page1.cursor).toBeTruthy();
  const page2 = await r2.list({ limit: 2, cursor: page1.cursor });
  expect(page2.objects).toHaveLength(1);
  expect(page2.truncated).toBe(false);
  expect(page2.objects[0]!.key).toBe("c");
});

test("persistence across instances", async () => {
  await r2.put("persist", "data");
  const r2b = new FileR2Bucket(db, "test-bucket", tmpDir);
  const obj = await r2b.get("persist");
  expect(await obj!.text()).toBe("data");
});
