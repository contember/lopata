import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SqliteWorkflowBinding, WorkflowEntrypointBase, type WorkflowStepImpl } from '../src/bindings/workflow'
import { runMigrations } from '../src/db'
import { getActiveExecutionContext } from '../src/execution-context'
import { runTracingMigrations } from '../src/tracing/db'
import { tracing } from '../src/tracing/span'
import { setTraceStore, TraceStore } from '../src/tracing/store'

let db: Database
let store: TraceStore
let bindings: SqliteWorkflowBinding[]

beforeEach(() => {
	db = new Database(':memory:')
	runMigrations(db)
	const traces = new Database(':memory:')
	runTracingMigrations(traces)
	store = new TraceStore(traces)
	setTraceStore(store)
	bindings = []
})

afterEach(async () => {
	for (const binding of bindings) {
		binding.terminateTracing('test disposed')
		binding.abortRunning()
	}
	await Bun.sleep(10)
	db.close()
	store.close()
	setTraceStore(null)
})

async function until(predicate: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 3000
	while (!await predicate()) {
		if (Date.now() > deadline) throw new Error('Workflow trace condition timed out')
		await Bun.sleep(5)
	}
}

function bind(cls: new(ctx: unknown, env: unknown) => WorkflowEntrypointBase, name = 'test') {
	const binding = new SqliteWorkflowBinding(db, name, 'Workflow', { defaultRetryLimit: 0, defaultRetryDelayMs: 1 })
	binding._setClass(cls, { marker: 'env' })
	bindings.push(binding)
	return binding
}

function root(name = 'test') {
	const row = store.listAllSpans({}).items.find(span => span.name === `workflow ${name}`)
	if (!row) throw new Error('Missing Workflow root')
	const span = store.getTrace(row.traceId).spans.find(span => span.spanId === row.spanId)
	if (!span) throw new Error('Missing Workflow span')
	return span
}

test('constructor and nested background work share ownership after engine completion', async () => {
	const first = Promise.withResolvers<void>()
	const nested = Promise.withResolvers<void>()
	class Workflow extends WorkflowEntrypointBase {
		constructor(ctx: unknown, env: unknown) {
			super(ctx, env)
			this.ctx.tracing.enterSpan('constructor', () => {})
			expect(this.ctx.env).toBe(env)
		}
		override async run() {
			expect(getActiveExecutionContext()).toBeDefined()
			this.ctx.waitUntil(first.promise.then(() => {
				this.ctx.waitUntil(nested.promise.then(() => {
					throw new Error('background failed')
				}))
			}))
			return 'done'
		}
	}
	const instance = await bind(Workflow).create()
	await until(async () => (await instance.status()).status === 'complete')
	expect(root().endTime).toBeNull()
	first.resolve()
	await Bun.sleep(10)
	expect(root().endTime).toBeNull()
	nested.resolve()
	await until(() => root().endTime !== null)
	expect(root().statusMessage).toBe('background failed')
	expect(store.getTrace(root().traceId).spans.map(span => span.name)).toContain('constructor')
})

test('timed-out attempt holds the root until actual settlement without poisoning a successful retry', async () => {
	const release = Promise.withResolvers<void>()
	let attempts = 0
	class Workflow extends WorkflowEntrypointBase {
		override async run(_event: unknown, step: WorkflowStepImpl) {
			return step.do('retry', { timeout: 5, retries: { limit: 1, delay: 1 } }, async () => {
				if (++attempts === 1) {
					await release.promise
					throw new Error('late retry failure')
				}
				return 'ok'
			})
		}
	}
	const instance = await bind(Workflow).create()
	await until(async () => (await instance.status()).status === 'complete')
	expect(root().endTime).toBeNull()
	release.resolve()
	await until(() => root().endTime !== null)
	expect(root().status).toBe('ok')
})

test('root includes compensation and preserves original and compensation failures', async () => {
	const release = Promise.withResolvers<void>()
	let compensating = false
	class Workflow extends WorkflowEntrypointBase {
		override async run(_event: unknown, step: WorkflowStepImpl) {
			await step.do('reserve', async () => 'reserved', {
				rollback: async () => {
					compensating = true
					await release.promise
					throw new Error('compensation failed')
				},
			})
			throw new Error('original failure')
		}
	}
	const instance = await bind(Workflow).create()
	await until(() => compensating)
	expect(root().endTime).toBeNull()
	release.resolve()
	await until(() => root().endTime !== null)
	expect(root().statusMessage).toBe('original failure')
	expect(root().attributes['workflow.rollback.outcome']).toBe('failed')
	expect(JSON.stringify(store.getTrace(root().traceId))).toContain('compensation failed')
	expect((await instance.status()).status).toBe('errored')
})

test('rollback termination keeps the invocation live through compensation', async () => {
	const release = Promise.withResolvers<void>()
	let compensating = false
	class Workflow extends WorkflowEntrypointBase {
		override async run(_event: unknown, step: WorkflowStepImpl) {
			await step.do('reserve', async () => 'reserved', {
				rollback: async () => {
					compensating = true
					await release.promise
					this.ctx.tracing.enterSpan('compensation', () => {})
				},
			})
			await step.waitForEvent('gate', { type: 'go' })
		}
	}
	const instance = await bind(Workflow).create()
	await until(async () => (await instance.status()).status === 'waiting')
	const terminated = instance.terminate({ rollback: true })
	await until(() => compensating)
	expect(root().endTime).toBeNull()
	release.resolve()
	await terminated
	await until(() => root().endTime !== null)
	expect(root().status).toBe('error')
	expect(root().attributes['workflow.rollback.outcome']).toBe('complete')
})

test('invalid restart preserves the live invocation and cooperative termination retains actual callbacks', async () => {
	const release = Promise.withResolvers<void>()
	let started = false
	class Workflow extends WorkflowEntrypointBase {
		override async run() {
			started = true
			await release.promise
			this.ctx.tracing.enterSpan('late callback', () => {})
		}
	}
	const instance = await bind(Workflow).create()
	await until(() => started)
	await expect(instance.restart({ from: { name: 'missing' } })).rejects.toThrow('not found')
	expect(root().endTime).toBeNull()
	await instance.terminate()
	expect(root().endTime).toBeNull()
	release.resolve()
	await until(() => root().endTime !== null)
	expect(root().statusMessage).toContain('terminated')
	expect(store.getTrace(root().traceId).spans.map(span => span.name)).toContain('late callback')
})

test('forced binding teardown reaches settled engines and leaves other bindings live', async () => {
	const release = Promise.withResolvers<void>()
	class Workflow extends WorkflowEntrypointBase {
		override async run() {
			this.ctx.waitUntil(release.promise)
		}
	}
	const a = bind(Workflow, 'a')
	const first = await a.create({ id: 'first' })
	const second = await bind(Workflow, 'b').create({ id: 'second' })
	await until(async () => (await first.status()).status === 'complete' && (await second.status()).status === 'complete')
	a.terminateTracing('runtime stopped')
	expect(root('a').statusMessage).toBe('runtime stopped')
	expect(root('b').endTime).toBeNull()
	release.resolve()
	await until(() => root('b').endTime !== null)
	expect(root('b').status).toBe('ok')
})

test('constructor failure is owned and direct base construction preserves env', async () => {
	const env = {}
	expect(new WorkflowEntrypointBase({}, env).ctx.env).toBe(env)
	class Workflow extends WorkflowEntrypointBase {
		constructor(ctx: unknown, env: unknown) {
			super(ctx, env)
			tracing.enterSpan('failing constructor', () => {})
			throw new Error('constructor failed')
		}
	}
	await bind(Workflow).create()
	await until(() => root().endTime !== null)
	expect(root().statusMessage).toBe('constructor failed')
})

test('real worker control, imported waitUntil, forced termination and reload retain completed side effects', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'tracing-workflow-'))
	try {
		const child = Bun.spawn([process.execPath, resolve(import.meta.dir, 'fixtures/tracing-workflow-runner.ts')], {
			cwd: directory,
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...process.env, BUN_CONFIG_NO_INSTALL: '1' },
		})
		const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
		if (exit !== 0) throw new Error(`Workflow trace subprocess failed: ${stdout}\n${stderr}`)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}, 15_000)
