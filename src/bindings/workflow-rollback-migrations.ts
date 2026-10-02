import type { Database } from 'bun:sqlite'

export function migrateWorkflowRollbacks(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS workflow_step_history (
			start_order INTEGER PRIMARY KEY AUTOINCREMENT,
			instance_id TEXT NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
			step_name TEXT NOT NULL,
			state TEXT NOT NULL DEFAULT 'started',
			attempt INTEGER NOT NULL DEFAULT 1,
			error TEXT,
			error_name TEXT,
			non_retryable INTEGER NOT NULL DEFAULT 0,
			rollback_registered INTEGER NOT NULL DEFAULT 0,
			rollback_state TEXT,
			rollback_attempts INTEGER NOT NULL DEFAULT 0,
			rollback_error TEXT,
			rollback_error_name TEXT,
			UNIQUE (instance_id, step_name)
		)
	`)
	db.run(`
		CREATE TABLE IF NOT EXISTS workflow_rollbacks (
			instance_id TEXT PRIMARY KEY REFERENCES workflow_instances(id) ON DELETE CASCADE,
			phase TEXT NOT NULL,
			target_status TEXT NOT NULL,
			original_non_retryable INTEGER NOT NULL DEFAULT 0,
			error TEXT,
			error_name TEXT
		)
	`)
	db.transaction(() => {
		const columns = db.query<{ name: string }, []>('PRAGMA table_info(workflow_rollbacks)').all()
		if (!columns.some(column => column.name === 'original_non_retryable')) {
			db.run('ALTER TABLE workflow_rollbacks ADD COLUMN original_non_retryable INTEGER NOT NULL DEFAULT 0')
		}
	}).immediate()
}
