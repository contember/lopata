import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const DATA_DIR = join(process.cwd(), ".bunflare");
const DB_PATH = join(DATA_DIR, "data.sqlite");

let instance: Database | null = null;

/**
 * Returns the shared SQLite database singleton for bunflare runtime data.
 * Creates the .bunflare/ directory and database file on first call.
 */
export function getDatabase(): Database {
	if (instance) return instance;

	mkdirSync(DATA_DIR, { recursive: true });
	mkdirSync(join(DATA_DIR, "r2"), { recursive: true });
	mkdirSync(join(DATA_DIR, "d1"), { recursive: true });

	instance = new Database(DB_PATH, { create: true });
	instance.run("PRAGMA journal_mode=WAL");
	runMigrations(instance);
	return instance;
}

/**
 * Initialize schema on the given database. Exported so tests and
 * external callers can run migrations on an arbitrary Database instance (e.g. :memory:).
 */
export function runMigrations(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS kv (
			namespace TEXT NOT NULL,
			key TEXT NOT NULL,
			value BLOB NOT NULL,
			metadata TEXT,
			expiration INTEGER,
			PRIMARY KEY (namespace, key)
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS r2_objects (
			bucket TEXT NOT NULL,
			key TEXT NOT NULL,
			size INTEGER NOT NULL,
			etag TEXT NOT NULL,
			version TEXT NOT NULL DEFAULT '',
			uploaded TEXT NOT NULL,
			http_metadata TEXT,
			custom_metadata TEXT,
			checksums TEXT,
			PRIMARY KEY (bucket, key)
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS r2_multipart_uploads (
			upload_id TEXT PRIMARY KEY,
			bucket TEXT NOT NULL,
			key TEXT NOT NULL,
			http_metadata TEXT,
			custom_metadata TEXT,
			created_at TEXT NOT NULL
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS r2_multipart_parts (
			upload_id TEXT NOT NULL,
			part_number INTEGER NOT NULL,
			etag TEXT NOT NULL,
			size INTEGER NOT NULL,
			file_path TEXT NOT NULL,
			PRIMARY KEY (upload_id, part_number)
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS do_instances (
			namespace TEXT NOT NULL,
			id TEXT NOT NULL,
			name TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (namespace, id)
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS do_storage (
			namespace TEXT NOT NULL,
			id TEXT NOT NULL,
			key TEXT NOT NULL,
			value TEXT NOT NULL,
			PRIMARY KEY (namespace, id, key)
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS do_alarms (
			namespace TEXT NOT NULL,
			id TEXT NOT NULL,
			alarm_time INTEGER NOT NULL,
			PRIMARY KEY (namespace, id)
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS queue_messages (
			id TEXT PRIMARY KEY,
			queue TEXT NOT NULL,
			body BLOB NOT NULL,
			content_type TEXT NOT NULL DEFAULT 'json',
			attempts INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'pending',
			visible_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			completed_at INTEGER
		)
	`);

	// Migrate: add status column if missing (existing databases)
	{
		const cols = db.query<{ name: string }, []>("PRAGMA table_info(queue_messages)").all();
		if (!cols.some(c => c.name === "status")) {
			db.run("ALTER TABLE queue_messages ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
		}
		if (!cols.some(c => c.name === "completed_at")) {
			db.run("ALTER TABLE queue_messages ADD COLUMN completed_at INTEGER");
		}
	}

	db.run(`CREATE INDEX IF NOT EXISTS idx_queue_visible ON queue_messages(queue, visible_at)`);

	db.run(`
		CREATE TABLE IF NOT EXISTS queue_leases (
			lease_id TEXT PRIMARY KEY,
			message_id TEXT NOT NULL,
			queue TEXT NOT NULL,
			expires_at INTEGER NOT NULL
		)
	`);

	db.run(`CREATE INDEX IF NOT EXISTS idx_queue_leases_queue ON queue_leases(queue)`);

	db.run(`
		CREATE TABLE IF NOT EXISTS workflow_instances (
			id TEXT PRIMARY KEY,
			workflow_name TEXT NOT NULL,
			class_name TEXT NOT NULL,
			params TEXT,
			status TEXT NOT NULL DEFAULT 'running',
			output TEXT,
			error TEXT,
			error_name TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS workflow_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			instance_id TEXT NOT NULL,
			event_type TEXT NOT NULL,
			payload TEXT,
			created_at INTEGER NOT NULL
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS workflow_steps (
			instance_id TEXT NOT NULL,
			step_name TEXT NOT NULL,
			output TEXT,
			completed_at INTEGER NOT NULL,
			PRIMARY KEY (instance_id, step_name)
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS cache_entries (
			cache_name TEXT NOT NULL,
			url TEXT NOT NULL,
			status INTEGER NOT NULL,
			headers TEXT NOT NULL,
			body BLOB NOT NULL,
			expires_at INTEGER,
			PRIMARY KEY (cache_name, url)
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS email_messages (
			id TEXT PRIMARY KEY,
			binding TEXT NOT NULL,
			from_addr TEXT NOT NULL,
			to_addr TEXT NOT NULL,
			raw BLOB NOT NULL,
			raw_size INTEGER NOT NULL,
			status TEXT NOT NULL DEFAULT 'sent',
			reject_reason TEXT,
			created_at INTEGER NOT NULL
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS ai_requests (
			id TEXT PRIMARY KEY,
			model TEXT NOT NULL,
			input_summary TEXT,
			output_summary TEXT,
			duration_ms INTEGER NOT NULL,
			status TEXT NOT NULL DEFAULT 'ok',
			error TEXT,
			is_streaming INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL
		)
	`);
}

/** Returns the path to the .bunflare data directory. */
export function getDataDir(): string {
	return DATA_DIR;
}
