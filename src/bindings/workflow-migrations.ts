import type { Database } from 'bun:sqlite'

export function migrateWorkflowOccurrences(db: Database): void {
	db.transaction(() => {
		const columns = db.query<{ name: string }, []>('PRAGMA table_info(workflow_instances)').all()
		for (
			const [name, definition] of [
				['incarnation', 'TEXT'],
				['run', 'INTEGER NOT NULL DEFAULT 1'],
				['execution_epoch', 'INTEGER NOT NULL DEFAULT 0'],
				['persistence_version', 'INTEGER NOT NULL DEFAULT 0'],
			]
		) {
			if (!columns.some(column => column.name === name)) db.run(`ALTER TABLE workflow_instances ADD COLUMN ${name} ${definition}`)
		}
		db.run('UPDATE workflow_instances SET incarnation = lower(hex(randomblob(16))) WHERE incarnation IS NULL')
		db.run(`CREATE TABLE IF NOT EXISTS workflow_occurrences (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			incarnation TEXT NOT NULL,
			run INTEGER NOT NULL CHECK (run > 0),
			type TEXT NOT NULL CHECK (type IN ('do', 'sleep', 'waitForEvent')),
			name TEXT NOT NULL,
			count INTEGER NOT NULL CHECK (count > 0),
			method TEXT NOT NULL CHECK (method IN ('do', 'sleep', 'sleepUntil', 'waitForEvent')),
			start_order INTEGER NOT NULL CHECK (start_order > 0),
			state TEXT NOT NULL DEFAULT 'started' CHECK (state IN ('started', 'completed', 'failed')),
			deadline INTEGER,
			event_type TEXT,
			output_kind TEXT CHECK (output_kind IN ('undefined', 'json')),
			output TEXT,
			completed_at INTEGER,
			attempt INTEGER NOT NULL DEFAULT 1,
			failed_attempts INTEGER NOT NULL DEFAULT 0,
			error TEXT,
			error_name TEXT,
			non_retryable INTEGER NOT NULL DEFAULT 0 CHECK (non_retryable IN (0, 1)),
			last_error_id TEXT,
			updated_at INTEGER,
			rollback_registered INTEGER NOT NULL DEFAULT 0 CHECK (rollback_registered IN (0, 1)),
			rollback_state TEXT CHECK (rollback_state IN ('running', 'complete', 'failed')),
			rollback_attempts INTEGER NOT NULL DEFAULT 0,
			rollback_error TEXT,
			rollback_error_name TEXT,
			UNIQUE (incarnation, run, type, name, count),
			UNIQUE (incarnation, run, start_order),
			CHECK ((output_kind = 'json' AND output IS NOT NULL) OR (output_kind IS NULL AND output IS NULL) OR (output_kind = 'undefined' AND output IS NULL)),
			CHECK ((type = 'sleep' AND method IN ('sleep', 'sleepUntil')) OR type = method)
		)`)
		db.run(`CREATE TABLE IF NOT EXISTS workflow_legacy_claims (
			incarnation TEXT NOT NULL,
			raw_key TEXT NOT NULL,
			occurrence_id INTEGER NOT NULL UNIQUE,
			version INTEGER NOT NULL DEFAULT 1,
			history_order INTEGER,
			PRIMARY KEY (incarnation, raw_key)
		)`)
	}).immediate()
}
