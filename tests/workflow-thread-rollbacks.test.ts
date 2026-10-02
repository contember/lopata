import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { WorkerExecutorFactory } from '../src/bindings/do-executor-worker'
import { DurableObjectNamespaceImpl } from '../src/bindings/durable-object'
import { SqliteWorkflowBinding } from '../src/bindings/workflow'
import type { WranglerConfig } from '../src/config'
import { runMigrations } from '../src/db'
import { WorkerThreadExecutor } from '../src/worker-thread/executor'

let executor: WorkerThreadExecutor | undefined
let directory: string | undefined

afterEach(() => {
	executor?.dispose()
	if (directory && process.env.LOPATA_ROLLBACK_THREAD_CHILD !== '1') rmSync(directory, { recursive: true, force: true })
})

async function until(predicate: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5_000
	while (!await predicate()) {
		if (Date.now() >= deadline) throw new Error('Thread rollback condition timed out')
		await Bun.sleep(10)
	}
}

test('worker reload recovers saga handlers without repeating persisted forward or rollback effects', async () => {
	// The executor's data directory is resolved from cwd at import time.
	if (process.env.LOPATA_ROLLBACK_THREAD_CHILD !== '1') {
		directory = mkdtempSync('/tmp/opencode/workflow-thread-rollbacks-')
		const child = Bun.spawn(['bun', 'test', import.meta.path], {
			cwd: directory,
			env: { ...process.env, LOPATA_ROLLBACK_THREAD_CHILD: '1' },
			stdout: 'pipe',
			stderr: 'pipe',
		})
		const stdout = new Response(child.stdout).text()
		const stderr = new Response(child.stderr).text()
		const exit = await child.exited
		if (exit !== 0) throw new Error(`Thread rollback subprocess failed (${exit}):\n${await stdout}\n${await stderr}`)
		expect(exit).toBe(0)
		return
	}
	directory = process.cwd()
	const counts = new Map<string, number>()
	const config: WranglerConfig = {
		name: 'rollback-worker',
		main: 'workflow-rollbacks.ts',
		workflows: [
			{ name: 'rollback', binding: 'SAGA', class_name: 'RollbackWorkflow', limits: { defaultRetryLimit: 0 } },
			{ name: 'termination', binding: 'TERMINATION', class_name: 'TerminationWorkflow', limits: { defaultRetryLimit: 0 } },
		],
		durable_objects: { bindings: [{ name: 'CONTROLLER', class_name: 'TerminationController' }] },
		services: [{ binding: 'OBSERVER', service: 'observer' }],
	}
	const options = {
		modulePath: resolve(import.meta.dir, 'fixtures/workflow-rollbacks.ts'),
		config,
		baseDir: directory,
		mainEnv: {
			OBSERVER: {
				record: async (name: string) => {
					const count = (counts.get(name) ?? 0) + 1
					counts.set(name, count)
					return count
				},
			},
		},
	}
	executor = new WorkerThreadExecutor(options)
	await executor.ready()
	await executor.executeWorkflowControl('SAGA', { kind: 'create', id: 'recover', params: {} })
	await until(async () => counts.get('undo-older:durable-reservation') === 1)
	const active = await executor.executeWorkflowControl('SAGA', { kind: 'status', instanceId: 'recover' })
	expect(active).toMatchObject({ kind: 'status', value: { status: 'running', error: { message: 'original forward failure' } } })
	executor.dispose()
	executor = new WorkerThreadExecutor(options)
	await executor.ready()
	await executor.executeWorkflowControl('SAGA', { kind: 'resumeInterrupted' })
	await until(async () => {
		if (!executor) return false
		const result = await executor.executeWorkflowControl('SAGA', { kind: 'status', instanceId: 'recover' })
		return result.kind === 'status' && result.value.status === 'errored'
	})
	const result = await executor.executeWorkflowControl('SAGA', { kind: 'status', instanceId: 'recover' })
	expect(result).toMatchObject({
		kind: 'status',
		value: {
			status: 'errored',
			error: { name: 'TypeError', message: 'original forward failure' },
			rollback: { outcome: 'complete', error: null },
		},
	})
	expect(counts.get('forward-older')).toBe(1)
	expect(counts.get('forward-latest')).toBe(1)
	expect(counts.get('undo-latest:undefined')).toBe(1)
	expect(counts.get('undo-older:durable-reservation')).toBe(2)
	const db = new Database(resolve(directory, '.lopata/data.sqlite'))
	runMigrations(db)
	const factory = new WorkerExecutorFactory()
	factory.configure(options.modulePath, resolve(directory, 'wrangler.json'), config)
	const workflow = new SqliteWorkflowBinding(db, 'TERMINATION', 'TerminationWorkflow')
	workflow._setThreadRouter(op => {
		if (!executor) throw new Error('User worker is not running')
		return executor.executeWorkflowControl('TERMINATION', op)
	})
	const namespace = new DurableObjectNamespaceImpl(db, 'TerminationController', resolve(directory, '.lopata'), { evictionTimeoutMs: 0 }, factory)
	namespace._setExternalClass('TerminationController', { TERMINATION: workflow, OBSERVER: options.mainEnv.OBSERVER })
	try {
		const stub = namespace.get(namespace.idFromName('controller'))
		if (typeof stub !== 'object' || stub === null) throw new Error('DO stub is unavailable')
		const fetch: unknown = Reflect.get(stub, 'fetch')
		if (typeof fetch !== 'function') throw new Error('DO fetch stub is unavailable')
		for (const rollback of [false, true]) {
			const id = `do-termination-${rollback}`
			await executor.executeWorkflowControl('TERMINATION', { kind: 'create', id, params: {} })
			await until(async () => {
				if (!executor) return false
				const result = await executor.executeWorkflowControl('TERMINATION', { kind: 'status', instanceId: id })
				return result.kind === 'status' && result.value.status === 'waiting'
			})
			const response: unknown = await fetch.call(stub, `http://localhost/terminate?id=${id}&rollback=${rollback}`)
			if (!(response instanceof Response)) throw new Error('DO fetch did not return a Response')
			const status: unknown = await response.json()
			expect(status).toMatchObject({ status: 'terminated', rollback: rollback ? { outcome: 'complete', error: null } : null })
			expect(counts.get('termination-undo:reservation') ?? 0).toBe(rollback ? 1 : 0)
		}
	} finally {
		namespace.destroy({ force: true })
		db.close()
	}
}, 15_000)
