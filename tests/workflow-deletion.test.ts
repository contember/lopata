import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { onStatusChange, SqliteWorkflowBinding, WorkflowEntrypointBase } from '../src/bindings/workflow'
import type { WorkflowLimits, WorkflowStepImpl } from '../src/bindings/workflow'
import { WorkflowStore } from '../src/bindings/workflow-store'
import { runMigrations } from '../src/db'
import { TestWorkflowBinding } from '../src/testing/workflow'
import { runTracingMigrations } from '../src/tracing/db'
import { setTraceStore, TraceStore } from '../src/tracing/store'

let db: Database
let traces: TraceStore
let bindings: SqliteWorkflowBinding[]
beforeEach(() => {
	db = new Database(':memory:')
	runMigrations(db)
	const traceDb = new Database(':memory:')
	runTracingMigrations(traceDb)
	traces = new TraceStore(traceDb)
	setTraceStore(traces)
	bindings = []
})
afterEach(async () => {
	for (const binding of bindings) {
		binding.abortRunning()
		binding.terminateTracing('test disposed')
	}
	await Bun.sleep(10)
	db.close()
	traces.close()
	setTraceStore(null)
})
function bind(run: (step: WorkflowStepImpl, id: string) => Promise<unknown>, limits: WorkflowLimits = {}, name = 'DELETE') {
	class Workflow extends WorkflowEntrypointBase {
		override run(event: unknown, step: WorkflowStepImpl) {
			if (!event || typeof event !== 'object' || !('instanceId' in event) || typeof event.instanceId !== 'string') throw new Error('Invalid event')
			return run(step, event.instanceId)
		}
	}
	const binding = new SqliteWorkflowBinding(db, name, 'Workflow', { defaultRetryLimit: 0, ...limits })
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
function bytes() {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array([42]))
			controller.close()
		},
	})
}

test.each(['run', 'step'])(
	'awaited self-delete in %s parks inner and outer catch/finally, closes spans and releases a queued instance',
	async location => {
		const ready = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		const effects: string[] = []
		const binding = bind(async (step, id) => {
			if (id === 'next') return step.do('next', async () => 'queue released')
			await step.do('reserved', async () => 'value', {
				rollback: async () => {
					effects.push('compensation')
				},
			})
			ready.resolve()
			await release.promise
			const remove = async () => {
				try {
					await (await binding.get(id)).delete()
					effects.push('after delete')
				} catch {
					effects.push('caught delete')
				} finally {
					effects.push('finally delete')
				}
			}
			try {
				if (location === 'step') await step.do('delete', remove)
				else await remove()
				effects.push('after step')
			} catch {
				effects.push('caught step')
			} finally {
				effects.push('finally step')
			}
		}, { maxConcurrentInstances: 1 })
		const own = await binding.create({ id: 'own' })
		await ready.promise
		const next = await binding.create({ id: 'next' })
		expect((await next.status()).status).toBe('queued')
		let notified = false
		onStatusChange(own._registryId(), status => {
			if (status === 'deleted') {
				notified = true
				expect(exists('own')).toBe(false)
			}
		})
		release.resolve()
		await until(async () => (await next.status()).status === 'complete')
		expect(notified).toBe(true)
		expect(effects).toEqual([])
		const roots = traces.listAllSpans({}).items.filter(span => span.name === 'workflow DELETE')
		const spans = roots.flatMap(root => traces.getTrace(root.traceId).spans)
		expect(spans.length).toBeGreaterThan(2)
		expect(spans.every(span => span.endTime !== null)).toBe(true)
		expect(spans.some(span => span.statusMessage?.includes('workflow deleted'))).toBe(true)
	},
)

test.each(['sleep', 'event'])('external deletion removes all owned state during %s without compensation', async mode => {
	let compensated = false
	const binding = bind(async step => {
		await step.do('saved', async () => bytes(), {
			rollback: async () => {
				compensated = true
			},
		})
		if (mode === 'sleep') await step.sleep('hold', 60000)
		else await step.waitForEvent('hold', { type: 'hold' })
	})
	const instance = await binding.create({ id: 'remove-all' })
	const store = new WorkflowStore(db)
	await until(() => store.readDetail(instance.id, 'DELETE').occurrences.length === 2)
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
})

test('external deletion permits late user effects but fences checkpoints and stale handles after ID reuse', async () => {
	const started = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	const finished = Promise.withResolvers<void>()
	let calls = 0
	let lateEffect = false
	const binding = bind(async step =>
		step.do('work', async () => {
			if (++calls === 1) {
				started.resolve()
				await release.promise
				lateEffect = true
				finished.resolve()
				return 'old'
			}
			return 'new'
		})
	)
	const old = await binding.create({ id: 'reuse' })
	await started.promise
	const oldToken = new WorkflowStore(db).currentToken(old.id)
	await old.delete()
	const fresh = await binding.create({ id: 'reuse' })
	await until(async () => (await fresh.status()).status === 'complete')
	release.resolve()
	await finished.promise
	expect(lateEffect).toBe(true)
	await expect(old.delete()).rejects.toThrow('no longer exists')
	await expect(binding.executeControl({ kind: 'delete', instanceId: 'reuse', incarnation: oldToken.incarnation })).rejects.toThrow('no longer exists')
	expect((await fresh.status()).output).toBe('new')
	expect(new WorkflowStore(db).readDetail('reuse', 'DELETE').occurrences[0]?.checkpoint).toEqual({ kind: 'json', serialized: '"new"' })
})

test('ignored self-delete promises do not stop arbitrary user code', async () => {
	let continued = false
	const binding = bind(async (_step, id) => {
		void (await binding.get(id)).delete()
		continued = true
	})
	await binding.create({ id: 'ignored' })
	await until(() => continued)
	expect(exists('ignored')).toBe(false)
})

test('deletion bypasses an indefinite rollback drain and releases the queue and trace', async () => {
	let compensated = false
	const binding = bind(async (step, id) => {
		if (id === 'next') return 'released'
		await step.do('never-settles', { timeout: 5 }, () => new Promise<void>(() => {}), {
			rollback: async () => {
				compensated = true
			},
		})
	}, { maxConcurrentInstances: 1 })
	const draining = await binding.create({ id: 'draining' })
	await until(() => db.query("SELECT * FROM workflow_rollbacks WHERE instance_id = 'draining' AND phase = 'running'").get() !== null)
	const next = await binding.create({ id: 'next' })
	expect((await next.status()).status).toBe('queued')
	await draining.delete()
	await until(async () => (await next.status()).status === 'complete')
	expect(compensated).toBe(false)
	const roots = traces.listAllSpans({}).items.filter(span => span.name === 'workflow DELETE')
	expect(roots.flatMap(root => traces.getTrace(root.traceId).spans).every(span => span.endTime !== null)).toBe(true)
})

test('post-commit queue failure cannot unwind an awaited self-delete', async () => {
	const gate = Promise.withResolvers<void>()
	let unwound = false
	const binding = bind(async (_step, id) => {
		if (id !== 'self') return 'next'
		await gate.promise
		try {
			await (await binding.get(id)).delete()
		} finally {
			unwound = true
		}
	}, { maxConcurrentInstances: 1 })
	await binding.create({ id: 'self' })
	const next = await binding.create({ id: 'next' })
	db.run(
		"CREATE TRIGGER fail_queue BEFORE UPDATE OF status ON workflow_instances WHEN NEW.id = 'next' AND NEW.status = 'running' BEGIN SELECT RAISE(FAIL, 'queue unavailable'); END",
	)
	gate.resolve()
	await until(() => !exists('self'))
	expect(unwound).toBe(false)
	expect((await next.status()).status).toBe('queued')
	db.run('DROP TRIGGER fail_queue')
	await next.delete()
})

test('deleteBatch validates the whole list and counts duplicate positions before any mutation', async () => {
	const binding = bind(async () => 'unused')
	await binding._createPrepared({ id: 'keep' })
	for (const invalid of ['', '.', '💥', 'a'.repeat(272)]) {
		await expect(binding.deleteBatch(['keep', invalid])).rejects.toThrow('instance.invalid_id')
		expect(exists('keep')).toBe(true)
	}
	await expect(binding.deleteBatch([])).rejects.toThrow('(body)')
	await expect(binding.deleteBatch(Array.from({ length: 101 }, () => 'keep'))).rejects.toThrow('(body)')
	await expect(binding.deleteBatch(new Array<string>(2))).rejects.toThrow('instance.invalid_id')
	expect(exists('keep')).toBe(true)
	expect((await binding.deleteBatch(Array.from({ length: 100 }, () => 'keep'))).deleted).toHaveLength(100)
})

test('batch results repeat per position, preserve ownership, and use released missing/internal error codes', async () => {
	const binding = bind(async () => 'unused')
	await binding._createPrepared({ id: 'ok' })
	await binding._createPrepared({ id: 'fail' })
	const foreign = bind(async () => 'unused', {}, 'OTHER')
	await foreign._createPrepared({ id: 'foreign' })
	db.run("CREATE TRIGGER fail_delete BEFORE DELETE ON workflow_instances WHEN OLD.id = 'fail' BEGIN SELECT RAISE(FAIL, 'delete unavailable'); END")
	const result = await binding.deleteBatch(['ok', '*/30 * * * *-1786001400000', 'fail', 'ok', 'foreign', 'fail'])
	expect(result).toEqual({
		deleted: [{ id: 'ok' }, { id: 'ok' }],
		errors: [
			{ id: '*/30 * * * *-1786001400000', code: 10400, message: 'workflows.api.error.instance.not_found' },
			{ id: 'fail', code: 10001, message: 'workflows.api.error.internal_server' },
			{ id: 'foreign', code: 10400, message: 'workflows.api.error.instance.not_found' },
			{ id: 'fail', code: 10001, message: 'workflows.api.error.internal_server' },
		],
	})
	expect(exists('foreign')).toBe(true)
	expect(exists('fail')).toBe(true)
})

test.each([0, 1, 3])('local cooperative self-batch finishes other attempts before parking with self at position %i', async position => {
	const gate = Promise.withResolvers<void>()
	let continued = false
	const binding = bind(async (_step, id) => {
		if (id !== 'self') return 'kept'
		await gate.promise
		const ids = ['before', 'failure', 'after']
		ids.splice(position, 0, id)
		try {
			await binding.deleteBatch([...ids, 'missing', id])
			continued = true
		} catch {
			continued = true
		} finally {
			continued = true
		}
	})
	for (const id of ['before', 'failure', 'after']) await binding._createPrepared({ id })
	db.run("CREATE TRIGGER fail_delete BEFORE DELETE ON workflow_instances WHEN OLD.id = 'failure' BEGIN SELECT RAISE(FAIL, 'delete unavailable'); END")
	await binding.create({ id: 'self' })
	gate.resolve()
	await until(() => !exists('self') && !exists('before') && !exists('after'))
	expect(exists('failure')).toBe(true)
	expect(continued).toBe(false)
})

test('testing helpers expose deletion and batch deletion', async () => {
	const helper = new TestWorkflowBinding(bind(async () => 'done'), db)
	try {
		const first = await helper.prepare({ id: 'helper1' })
		await first.delete()
		await helper.prepare({ id: 'helper2' })
		expect(await helper.deleteBatch(['helper2'])).toEqual({ deleted: [{ id: 'helper2' }], errors: [] })
	} finally {
		helper.dispose()
	}
})

test('shared worker self-deletion, DO forwarding, stale proxy handles, and fresh-process recovery', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'workflow-deletion-'))
	cpSync(resolve(import.meta.dir, 'fixtures/workflow-deletion-worker'), dir, { recursive: true })
	const host = '127.0.0.1'
	const reservation = Bun.serve({ hostname: host, port: 0, fetch: () => new Response() })
	const port = reservation.port
	reservation.stop(true)
	const base = `http://${host}:${port}`
	function start() {
		const processHandle = Bun.spawn([process.execPath, resolve(import.meta.dir, '../src/cli.ts'), 'dev', '--port', String(port), '--listen', host], {
			cwd: dir,
			// A conflicting default makes this exercise explicit listener selection even on IPv4-only localhost setups.
			env: { ...process.env, HOST: '::1' },
			stdout: 'pipe',
			stderr: 'pipe',
		})
		const stdout = new Response(processHandle.stdout).text()
		const stderr = new Response(processHandle.stderr).text()
		let stopped: Promise<string> | undefined
		function stop(): Promise<string> {
			return stopped ??= (async () => {
				if (processHandle.exitCode === null) processHandle.kill('SIGKILL')
				await processHandle.exited
				const [out, err] = await Promise.all([stdout, stderr])
				return `stdout:\n${out}\nstderr:\n${err}`
			})()
		}
		return {
			async ready() {
				let lastProbe = 'No HTTP response'
				try {
					await until(async () => {
						if (processHandle.exitCode !== null) throw new Error(`Server exited with code ${processHandle.exitCode}`)
						try {
							const response = await fetch(base)
							lastProbe = `HTTP ${response.status}: ${await response.text()}`
							return response.ok
						} catch (error) {
							lastProbe = String(error)
							return false
						}
					})
				} catch (cause) {
					throw new Error(`Deletion fixture not ready at ${base}. ${lastProbe}\n${await stop()}`, { cause })
				}
			},
			stop,
		}
	}
	async function request(path: string) {
		const response = await fetch(`${base}${path}`)
		if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
		return response
	}
	let server = start()
	try {
		await server.ready()
		const identity: unknown = await (await request('/')).json()
		for (const mode of ['run', 'step']) {
			await request(`/create?id=${mode}&mode=${mode}`)
			await until(async () => {
				const status: unknown = await (await request(`/status?id=${mode}`)).json()
				return !!status && typeof status === 'object' && 'status' in status && status.status === 'waiting'
			})
			await request(`/signal?id=${mode}`)
			await until(async () => (await fetch(`${base}/status?id=${mode}`)).status === 404)
			expect(await (await request('/')).json()).toEqual(identity)
		}
		expect(await (await request('/effects')).json()).toEqual(['started:run', 'started:step'])
		await request('/do/create?id=proxy')
		await request('/do/delete?id=proxy')
		await request('/create?id=proxy')
		expect((await fetch(`${base}/do/delete-saved?id=proxy`)).status).toBe(409)
		expect((await fetch(`${base}/do/send-saved?id=proxy`)).status).toBe(409)
		expect((await request('/status?id=proxy')).ok).toBe(true)
		expect(await (await request('/do/batch?id=proxy&id=missing&id=proxy')).json()).toEqual({
			deleted: [{ id: 'proxy' }, { id: 'proxy' }],
			errors: [{ id: 'missing', code: 10400, message: 'workflows.api.error.instance.not_found' }],
		})
		await server.stop()
		server = start()
		await server.ready()
		for (const id of ['run', 'step', 'proxy']) expect((await fetch(`${base}/status?id=${id}`)).status).toBe(404)
		expect(await (await request('/effects')).json()).toEqual([])
	} finally {
		await server.stop()
		rmSync(dir, { recursive: true, force: true })
	}
}, 30000)
