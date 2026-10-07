import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { SqliteWorkflowBinding, WorkflowEntrypointBase } from '../src/bindings/workflow'
import type { WorkflowStepImpl } from '../src/bindings/workflow'
import { runMigrations } from '../src/db'
import { TestWorkflowBinding } from '../src/testing/workflow'

let db: Database
let bindings: SqliteWorkflowBinding[]
beforeEach(() => {
	db = new Database(':memory:')
	runMigrations(db)
	bindings = []
})
afterEach(async () => {
	for (const binding of bindings) binding.abortRunning()
	await Bun.sleep(10)
	db.close()
})
function bind(run: (step: WorkflowStepImpl) => Promise<unknown>) {
	class Workflow extends WorkflowEntrypointBase {
		override run(_event: unknown, step: WorkflowStepImpl) {
			return run(step)
		}
	}
	const binding = new SqliteWorkflowBinding(db, 'DELETE', 'Workflow', { defaultRetryLimit: 0 })
	binding._setClass(Workflow, {})
	bindings.push(binding)
	return binding
}
async function until(predicate: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 5000
	while (!await predicate()) {
		if (Date.now() > deadline) throw new Error('Deletion test timed out')
		await Bun.sleep(5)
	}
}
function exists(id: string) {
	return db.query('SELECT id FROM workflow_instances WHERE id = ?').get(id) !== null
}

test('delete removes all owned state without compensation', async () => {
	let compensated = false
	const binding = bind(async step => {
		await step.do('saved', async () => 42, {
			rollback: async () => {
				compensated = true
			},
		})
		await step.waitForEvent('hold', { type: 'hold' })
	})
	const instance = await binding.create({ id: 'remove-all' })
	await until(async () => (await instance.status()).status === 'waiting')
	await instance.sendEvent({ type: 'unused', payload: 42 })
	db.query('INSERT INTO workflow_steps (instance_id, step_name, output, completed_at) VALUES (?, ?, ?, ?)').run(instance.id, 'legacy', '42', 1)
	await instance.delete()
	expect(compensated).toBe(false)
	for (
		const table of [
			'workflow_instances',
			'workflow_steps',
			'workflow_step_history',
			'workflow_step_attempts',
			'workflow_legacy_claims',
			'workflow_occurrences',
			'workflow_rollbacks',
			'workflow_events',
		]
	) {
		expect(db.query(`SELECT * FROM ${table}`).all()).toHaveLength(0)
	}
	binding.resumeInterrupted()
	expect(exists(instance.id)).toBe(false)
	await expect(binding.get(instance.id)).rejects.toThrow('not found')
})

test('deleting a running instance stops it', async () => {
	const started = Promise.withResolvers<void>()
	let reachedNextStep = false
	const binding = bind(async step => {
		await step.do('first', async () => {
			started.resolve()
			await Bun.sleep(50)
			return 1
		})
		await step.do('second', async () => {
			reachedNextStep = true
		})
	})
	const instance = await binding.create({ id: 'running' })
	await started.promise
	await instance.delete()
	await Bun.sleep(100)
	expect(reachedNextStep).toBe(false)
	expect(exists('running')).toBe(false)
})

test('self-delete from a running workflow stops the run', async () => {
	let continued = false
	const binding = bind(async step => {
		await step.do('remove', async () => {
			await (await binding.get('self')).delete()
		})
		await step.do('after', async () => {
			continued = true
		})
	})
	await binding.create({ id: 'self' })
	await until(() => !exists('self'))
	await Bun.sleep(20)
	expect(continued).toBe(false)
})

test('deleteBatch deletes each instance and reports missing ones', async () => {
	const binding = bind(async () => 'unused')
	await binding._createPrepared({ id: 'first' })
	await binding._createPrepared({ id: 'second' })
	expect(await binding.deleteBatch(['first', 'missing', 'second'])).toEqual({
		deleted: [{ id: 'first' }, { id: 'second' }],
		errors: [{ id: 'missing', code: 10400, message: 'workflows.api.error.instance.not_found' }],
	})
	expect(exists('first')).toBe(false)
	expect(exists('second')).toBe(false)
})

test('deleteBatch rejects invalid ids and sizes before any mutation', async () => {
	const binding = bind(async () => 'unused')
	await binding._createPrepared({ id: 'keep' })
	for (const invalid of ['', '.', '💥', 'a'.repeat(272)]) {
		await expect(binding.deleteBatch(['keep', invalid])).rejects.toThrow('instance.invalid_id')
	}
	await expect(binding.deleteBatch([])).rejects.toThrow('(body)')
	await expect(binding.deleteBatch(Array.from({ length: 101 }, () => 'keep'))).rejects.toThrow('(body)')
	expect(exists('keep')).toBe(true)
})

test('testing helpers expose deletion and batch deletion', async () => {
	const helper = new TestWorkflowBinding(bind(async () => 'done'), db)
	try {
		const first = await helper.prepare({ id: 'helper1' })
		await first.delete()
		expect(exists('helper1')).toBe(false)
		await helper.prepare({ id: 'helper2' })
		expect(await helper.deleteBatch(['helper2'])).toEqual({ deleted: [{ id: 'helper2' }], errors: [] })
	} finally {
		helper.dispose()
	}
})
