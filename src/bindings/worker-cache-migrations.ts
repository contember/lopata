import type { Database } from 'bun:sqlite'

export function migrateWorkerCache(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS worker_cache_entries (
			worker TEXT NOT NULL, entrypoint TEXT NOT NULL, version TEXT NOT NULL,
			cache_key TEXT NOT NULL, variant TEXT NOT NULL, path TEXT NOT NULL,
			vary TEXT NOT NULL, headers TEXT NOT NULL, tags TEXT NOT NULL,
			status INTEGER NOT NULL, status_text TEXT NOT NULL, body BLOB NOT NULL,
			stored_at INTEGER NOT NULL, ttl INTEGER NOT NULL, swr INTEGER NOT NULL,
			stale_error INTEGER NOT NULL, auth_allowed INTEGER NOT NULL,
			PRIMARY KEY (worker, entrypoint, version, cache_key, variant)
		);
		CREATE TABLE IF NOT EXISTS worker_cache_epochs (
			worker TEXT NOT NULL, entrypoint TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (worker, entrypoint)
		);
	`)
}
