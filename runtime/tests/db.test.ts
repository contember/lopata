import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db";

describe("runMigrations", () => {
	test("creates all tables on a fresh database", () => {
		const db = new Database(":memory:");
		runMigrations(db);

		const tables = db
			.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as { name: string }[];
		const names = tables.map((t) => t.name);

		expect(names).toContain("kv");
		expect(names).toContain("r2_objects");
		expect(names).toContain("do_storage");
		expect(names).toContain("do_alarms");
		expect(names).toContain("queue_messages");
		expect(names).toContain("workflow_instances");
		expect(names).toContain("cache_entries");
	});

	test("is idempotent — running twice does not throw", () => {
		const db = new Database(":memory:");
		runMigrations(db);
		runMigrations(db);

		const tables = db
			.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as { name: string }[];
		expect(tables.length).toBeGreaterThanOrEqual(7);
	});

	test("kv table has correct columns", () => {
		const db = new Database(":memory:");
		runMigrations(db);

		const cols = db.query("PRAGMA table_info(kv)").all() as { name: string }[];
		const colNames = cols.map((c) => c.name);
		expect(colNames).toEqual(["namespace", "key", "value", "metadata", "expiration"]);
	});

	test("r2_objects table has correct columns", () => {
		const db = new Database(":memory:");
		runMigrations(db);

		const cols = db.query("PRAGMA table_info(r2_objects)").all() as { name: string }[];
		const colNames = cols.map((c) => c.name);
		expect(colNames).toEqual(["bucket", "key", "size", "etag", "uploaded", "http_metadata", "custom_metadata"]);
	});

	test("do_storage table has correct columns", () => {
		const db = new Database(":memory:");
		runMigrations(db);

		const cols = db.query("PRAGMA table_info(do_storage)").all() as { name: string }[];
		const colNames = cols.map((c) => c.name);
		expect(colNames).toEqual(["namespace", "id", "key", "value"]);
	});

	test("queue_messages table has correct columns", () => {
		const db = new Database(":memory:");
		runMigrations(db);

		const cols = db.query("PRAGMA table_info(queue_messages)").all() as { name: string }[];
		const colNames = cols.map((c) => c.name);
		expect(colNames).toEqual(["id", "queue", "body", "content_type", "attempts", "visible_at", "created_at"]);
	});

	test("workflow_instances table has correct columns", () => {
		const db = new Database(":memory:");
		runMigrations(db);

		const cols = db.query("PRAGMA table_info(workflow_instances)").all() as { name: string }[];
		const colNames = cols.map((c) => c.name);
		expect(colNames).toEqual(["id", "workflow_name", "class_name", "params", "status", "output", "error", "created_at", "updated_at"]);
	});

	test("cache_entries table has correct columns", () => {
		const db = new Database(":memory:");
		runMigrations(db);

		const cols = db.query("PRAGMA table_info(cache_entries)").all() as { name: string }[];
		const colNames = cols.map((c) => c.name);
		expect(colNames).toEqual(["cache_name", "url", "status", "headers", "body"]);
	});

	test("can insert and read from kv table", () => {
		const db = new Database(":memory:");
		runMigrations(db);

		db.run(
			"INSERT INTO kv (namespace, key, value) VALUES (?, ?, ?)",
			["ns1", "hello", Buffer.from("world")]
		);
		const row = db.query("SELECT * FROM kv WHERE namespace = ? AND key = ?").get("ns1", "hello") as {
			namespace: string;
			key: string;
			value: Buffer;
		};
		expect(row.namespace).toBe("ns1");
		expect(row.key).toBe("hello");
		expect(Buffer.from(row.value).toString()).toBe("world");
	});

	test("kv primary key enforces uniqueness", () => {
		const db = new Database(":memory:");
		runMigrations(db);

		db.run("INSERT INTO kv (namespace, key, value) VALUES (?, ?, ?)", ["ns1", "k", Buffer.from("v1")]);
		expect(() => {
			db.run("INSERT INTO kv (namespace, key, value) VALUES (?, ?, ?)", ["ns1", "k", Buffer.from("v2")]);
		}).toThrow();
	});
});
