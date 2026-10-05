import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { SqliteWorkflowBinding, WorkflowEntrypointBase } from '../src/bindings/workflow'
import type { WorkflowStepImpl } from '../src/bindings/workflow'
import { WorkflowStore } from '../src/bindings/workflow-store'
import { runMigrations } from '../src/db'

let db: Database
beforeEach(() => {
	db = new Database(':memory:')
	runMigrations(db)
})
afterEach(() => db.close())
function legacy() {
	db.query(
		"INSERT INTO workflow_instances (id, workflow_name, class_name, status, created_at, updated_at) VALUES ('old', 'LEGACY', 'LegacyWorkflow', 'running', 1, 1)",
	).run()
	runMigrations(db)
}
function checkpoint(name: string, output: string | null) {
	db.query('INSERT INTO workflow_steps VALUES (?, ?, ?, ?)').run('old', name, output, 1)
}

test('twice-migrated interrupted adoption preserves raw NULL/null/objects and completed effects', async () => {
	legacy()
	checkpoint('undefined', null)
	checkpoint('null', 'null')
	checkpoint('sleep:literal', '{ "preserved": true }')
	checkpoint('object', '{}')
	const raw = db.query('SELECT * FROM workflow_steps').all()
	runMigrations(db)
	runMigrations(db)
	const store = new WorkflowStore(db)
	const token = store.acquireExecution('old', 'LEGACY')
	store.openOccurrence(token, { key: { name: 'undefined', type: 'do', count: 1 }, method: 'do', startOrder: 1, rollbackRegistered: true })
	let executed = 0
	const undos: unknown[] = []
	class LegacyWorkflow extends WorkflowEntrypointBase {
		override async run(_event: unknown, step: WorkflowStepImpl) {
			const outputs: unknown[] = []
			for (const name of ['undefined', 'null', 'sleep:literal', 'object']) {
				outputs.push(
					await step.do(name, async () => {
						executed++
						return 'rerun'
					}, {
						rollback: async ({ output }) => {
							undos.push(output)
						},
					}),
				)
			}
			if (outputs[0] !== undefined || outputs[1] !== null) throw new Error('Lost null identity')
			await step.do('object', async ({ step }) => {
				executed++
				return step.count
			})
			throw new Error('compensate')
		}
	}
	const binding = new SqliteWorkflowBinding(db, 'LEGACY', 'LegacyWorkflow', { defaultRetryLimit: 0 })
	binding._setClass(LegacyWorkflow, {})
	binding.resumeInterrupted()
	const instance = await binding.get('old')
	const deadline = Date.now() + 2000
	while ((await instance.status()).status === 'running' && Date.now() < deadline) await Bun.sleep(5)
	expect((await instance.status()).rollback?.outcome).toBe('complete')
	expect(executed).toBe(1)
	expect(undos).toEqual([{}, { preserved: true }, null, undefined])
	expect(db.query('SELECT * FROM workflow_steps').all()).toEqual(raw)
})

test('legacy retry counters, error links and completed compensation survive adoption', () => {
	legacy()
	db.query(
		"INSERT INTO workflow_step_history (instance_id, step_name, state, attempt, rollback_registered, rollback_state, rollback_attempts, rollback_error, rollback_error_name) VALUES ('old', 'retry', 'started', 3, 1, 'complete', 2, 'old rollback error', 'RangeError')",
	).run()
	db.query("INSERT INTO workflow_step_attempts VALUES ('old', 'retry', 2, 'forward error', 'TypeError', 'error-link', 123)").run()
	const rawHistory = db.query('SELECT * FROM workflow_step_history').all()
	const rawAttempts = db.query('SELECT * FROM workflow_step_attempts').all()
	runMigrations(db)
	runMigrations(db)
	const store = new WorkflowStore(db)
	const token = store.acquireExecution('old', 'LEGACY')
	const row = store.openOccurrence(token, { key: { name: 'retry', type: 'do', count: 1 }, method: 'do', startOrder: 1, rollbackRegistered: true })
	expect(row.failedAttempts).toBe(2)
	expect(row.attempt).toBe(3)
	expect(row.error).toEqual({ message: 'forward error', name: 'TypeError', nonRetryable: false, errorId: 'error-link' })
	expect(row.rollbackState).toBe('complete')
	expect(row.rollbackAttempts).toBe(2)
	expect(db.query('SELECT * FROM workflow_step_history').all()).toEqual(rawHistory)
	expect(db.query('SELECT * FROM workflow_step_attempts').all()).toEqual(rawAttempts)
})

test('a completed legacy effect with a missing checkpoint fails instead of repeating the callback', async () => {
	legacy()
	db.query("INSERT INTO workflow_step_history (instance_id, step_name, state) VALUES ('old', 'missing', 'completed')").run()
	let calls = 0
	class LegacyWorkflow extends WorkflowEntrypointBase {
		override async run(_event: unknown, step: WorkflowStepImpl) {
			return step.do('missing', async () => ++calls)
		}
	}
	const binding = new SqliteWorkflowBinding(db, 'LEGACY', 'LegacyWorkflow')
	binding._setClass(LegacyWorkflow, {})
	binding.resumeInterrupted()
	const instance = await binding.get('old')
	const deadline = Date.now() + 2000
	while ((await instance.status()).status === 'running' && Date.now() < deadline) await Bun.sleep(5)
	expect(calls).toBe(0)
	expect((await instance.status()).error?.message).toContain('has no checkpoint')
})

test('literal prefix collisions and detectable historic order divergence fail explicitly', () => {
	legacy()
	checkpoint('sleep:x', '{"until":1}')
	const store = new WorkflowStore(db)
	const token = store.acquireExecution('old', 'LEGACY')
	store.openOccurrence(token, { key: { type: 'do', name: 'sleep:x', count: 1 }, method: 'do', startOrder: 1, rollbackRegistered: false })
	expect(() => store.openOccurrence(token, { key: { type: 'sleep', name: 'x', count: 1 }, method: 'sleep', startOrder: 2, rollbackRegistered: false }))
		.toThrow('Ambiguous legacy')
	db.query("INSERT INTO workflow_step_history (instance_id, step_name) VALUES ('old', 'earlier'), ('old', 'later')").run()
	store.openOccurrence(token, { key: { type: 'do', name: 'later', count: 1 }, method: 'do', startOrder: 2, rollbackRegistered: false })
	expect(() => store.openOccurrence(token, { key: { type: 'do', name: 'earlier', count: 1 }, method: 'do', startOrder: 3, rollbackRegistered: false }))
		.toThrow('Ambiguous legacy workflow order')
	expect(store.readDetail('old', 'LEGACY').legacy.some(row => row.step_name === 'earlier')).toBe(true)
})

test('legacy sleep methods adopt separate raw keys into one counted namespace', () => {
	legacy()
	checkpoint('sleep:nap', '{"until":10}')
	checkpoint('sleepUntil:nap', '{"until":"1970-01-01T00:00:00.020Z"}')
	const store = new WorkflowStore(db)
	const token = store.acquireExecution('old', 'LEGACY')
	const first = store.openOccurrence(token, {
		key: { type: 'sleep', name: 'nap', count: 1 },
		method: 'sleep',
		startOrder: 1,
		rollbackRegistered: false,
	})
	const second = store.openOccurrence(token, {
		key: { type: 'sleep', name: 'nap', count: 2 },
		method: 'sleepUntil',
		startOrder: 2,
		rollbackRegistered: false,
	})
	expect(first.deadline).toBe(10)
	expect(second.deadline).toBe(20)
	expect(store.setDeadline({ token, occurrenceId: second.id }, 100000, null)).toBe(20)
	store.completeSleep({ token, occurrenceId: first.id }, 30)
	expect(store.readCheckpoint({ token, occurrenceId: first.id })).toEqual({ kind: 'undefined' })
	expect(store.readDetail('old', 'LEGACY').legacy).toEqual([])
})

test('event consumption and checkpoint publication roll back together on a failed write', () => {
	legacy()
	const store = new WorkflowStore(db)
	const token = store.acquireExecution('old', 'LEGACY')
	const row = store.openOccurrence(token, {
		key: { type: 'waitForEvent', name: 'gate', count: 1 },
		method: 'waitForEvent',
		startOrder: 1,
		rollbackRegistered: false,
	})
	const ref = { token, occurrenceId: row.id }
	store.setDeadline(ref, 10000, 'go')
	db.query("INSERT INTO workflow_events (instance_id, event_type, payload, created_at) VALUES ('old', 'go', '123', 1), ('old', 'go', '456', 2)").run()
	db.run(
		"CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON workflow_occurrences WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END",
	)
	expect(() => store.consumeEvent(ref, 3)).toThrow('injected write failure')
	expect(store.readCheckpoint(ref)).toBeNull()
	db.run('DROP TRIGGER reject_checkpoint')
	const result = store.consumeEvent(ref, 4)
	expect(result?.kind === 'json' ? JSON.parse(result.serialized).payload : undefined).toBe(123)
	expect(db.query<{ payload: string }, []>('SELECT payload FROM workflow_events').all()).toEqual([{ payload: '456' }])
})

test('unmapped terminal legacy restart rejects before fencing; explicit full restart invalidates old checkpoints', () => {
	legacy()
	checkpoint('old', '123')
	db.query("UPDATE workflow_instances SET status = 'complete' WHERE id = 'old'").run()
	const store = new WorkflowStore(db)
	const token = store.currentToken('old', 'LEGACY')
	expect(() => store.resolveRestartTarget(token, { type: 'do', name: 'old', count: 1 })).toThrow('legacy identity/order')
	expect(store.currentToken('old', 'LEGACY')).toEqual(token)
	const next = store.replaceRun(store.fenceExecution(token), null)
	const row = store.openOccurrence(next, { key: { type: 'do', name: 'old', count: 1 }, method: 'do', startOrder: 1, rollbackRegistered: false })
	expect(row.checkpoint).toBeNull()
	expect(() => store.commitCheckpoint({ token, occurrenceId: row.id }, { kind: 'undefined' }, 1)).toThrow('Stale')
})

test('fresh processes recover isolated attempts and skip committed forward and rollback effects', async () => {
	const directory = mkdtempSync('/tmp/opencode/workflow-occurrences-')
	const path = join(directory, 'data.sqlite')
	try {
		for (const phase of ['forward', 'rollback', 'finish']) {
			const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/workflow-occurrences-process.ts'), path, phase], {
				stdout: 'pipe',
				stderr: 'pipe',
			})
			const stdout = new Response(child.stdout).text()
			const stderr = new Response(child.stderr).text()
			if (await child.exited !== 0) throw new Error(`${phase}: ${await stdout}\n${await stderr}`)
		}
		const reopened = new Database(path)
		try {
			expect(reopened.query('SELECT kind, count, attempt FROM effects').all()).toEqual([
				{ kind: 'forward', count: 1, attempt: 1 },
				{ kind: 'forward', count: 2, attempt: 1 },
				{ kind: 'forward', count: 2, attempt: 2 },
				{ kind: 'rollback', count: 2, attempt: 2 },
				{ kind: 'rollback', count: 1, attempt: 1 },
				{ kind: 'rollback', count: 1, attempt: 1 },
			])
		} finally {
			reopened.close()
		}
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}, 15000)
