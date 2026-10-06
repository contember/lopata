import { Database } from 'bun:sqlite'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import type { WranglerConfig } from '../../src/config'
import { runTracingMigrations } from '../../src/tracing/db'
import { setTraceStore, TraceStore } from '../../src/tracing/store'
import { WorkerThreadExecutor } from '../../src/worker-thread/executor'

const db = new Database(':memory:')
runTracingMigrations(db)
const store = new TraceStore(db)
setTraceStore(store)
const config: WranglerConfig = {
	name: 'tracing-workflow',
	main: 'tracing-workflow-worker.ts',
	workflows: [{ name: 'traced', binding: 'WORKFLOW', class_name: 'TracedWorkflow' }],
	services: [{ binding: 'OBSERVER', service: 'observer' }],
}
let effects = 0
const background = Promise.withResolvers<void>()
const options = {
	modulePath: resolve(import.meta.dir, 'tracing-workflow-worker.ts'),
	config,
	baseDir: process.cwd(),
	mainEnv: {
		OBSERVER: {
			record: async () => {
				effects++
			},
			background: () => background.promise,
		},
	},
}
let executor = new WorkerThreadExecutor(options)
async function until(predicate: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 5000
	while (!await predicate()) {
		if (Date.now() > deadline) throw new Error('Worker Workflow trace condition timed out')
		await Bun.sleep(5)
	}
}
function roots() {
	return store.listAllSpans({}).items.filter(span => span.name === 'workflow WORKFLOW').flatMap(row =>
		store.getTrace(row.traceId).spans.filter(span => span.spanId === row.spanId)
	)
}
function spans() {
	return roots().flatMap(root => store.getTrace(root.traceId).spans)
}
async function status() {
	const result = await executor.executeWorkflowControl('WORKFLOW', { kind: 'status', instanceId: 'recover' })
	assert.equal(result.kind, 'status')
	return result.kind === 'status' ? result.value.status : undefined
}
try {
	await executor.ready()
	await executor.executeWorkflowControl('WORKFLOW', { kind: 'create', id: 'recover', params: {} })
	await until(async () => await status() === 'waiting' && roots().length === 1)
	const old = roots()[0]
	assert.ok(old)
	assert.equal(old.endTime, null)
	assert.equal(executor.pendingWaitUntil(), 0)
	executor.dispose()
	assert.notEqual(spans().find(span => span.spanId === old.spanId)?.endTime, null)
	executor = new WorkerThreadExecutor(options)
	await executor.ready()
	await executor.executeWorkflowControl('WORKFLOW', { kind: 'resumeInterrupted' })
	await until(async () => await status() === 'waiting' && roots().length === 2)
	assert.notEqual(roots()[0]?.traceId, roots()[1]?.traceId)
	await executor.executeWorkflowControl('WORKFLOW', { kind: 'sendEvent', instanceId: 'recover', eventType: 'resume', payload: null })
	await until(async () => await status() === 'complete')
	assert.ok(roots().some(root => root.endTime === null))
	background.resolve()
	await until(() => roots().every(root => root.endTime !== null))
	assert.ok(spans().some(span => span.name === 'imported background'))
	assert.equal(effects, 1)
} finally {
	executor.dispose()
	setTraceStore(null)
	store.close()
}
