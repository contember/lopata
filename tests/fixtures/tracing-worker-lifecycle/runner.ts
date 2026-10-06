import { Database } from 'bun:sqlite'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { runTracingMigrations } from '../../../src/tracing/db'
import { createInvocationTrace } from '../../../src/tracing/invocation'
import { setTraceStore, TraceStore } from '../../../src/tracing/store'
import { WorkerThreadExecutor } from '../../../src/worker-thread/executor'

const db = new Database(':memory:')
runTracingMigrations(db)
const store = new TraceStore(db)
setTraceStore(store)
const executors: WorkerThreadExecutor[] = []

async function executor(name: string): Promise<WorkerThreadExecutor> {
	const result = new WorkerThreadExecutor({
		modulePath: resolve(import.meta.dir, 'worker.ts'),
		config: { name },
		workerName: name,
		baseDir: process.cwd(),
		mainEnv: {},
	})
	executors.push(result)
	await result.ready()
	return result
}

function spans() {
	return store.listAllSpans({ limit: 1000 }).items.flatMap(row => store.getTrace(row.traceId).spans.filter(value => value.spanId === row.spanId))
}

function named(name: string) {
	const result = spans().find(value => value.name === name)
	assert.ok(result, `Missing span ${name}`)
	return result
}

function root(id: string) {
	const manual = named(`manual:${id}`)
	const result = spans().find(value => value.spanId === manual.parentSpanId)
	assert.ok(result, `Missing invocation root for ${id}`)
	return result
}

async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out; spans: ${JSON.stringify(spans())}`)
		await Bun.sleep(5)
	}
}

function request(path: string, id: string): Request {
	return new Request(`http://worker${path}?id=${id}`)
}

async function release(worker: WorkerThreadExecutor, id: string): Promise<void> {
	await worker.executeEntrypointRpc('Control', 'release', [id])
}

try {
	const worker = await executor('first')
	switch (process.argv[2]) {
		case 'body': {
			const response = await worker.executeFetch(request('/body', 'slow'))
			assert.equal(root('slow').name, 'fetch default')
			assert.equal(root('slow').parentSpanId, null)
			assert.equal(root('slow').workerName, 'first')
			assert.equal(root('slow').endTime, null)
			assert.equal(named('manual:slow').endTime, null)
			assert.ok(worker.pendingWaitUntil() > 0)
			await release(worker, 'slow')
			assert.equal(await response.text(), 'slow')
			await until(() => root('slow').endTime !== null)
			assert.equal(named('manual:slow').attributes['body-done'], true)
			assert.equal(named('body:slow').parentSpanId, root('slow').spanId)
			assert.equal(root('slow').status, 'ok')
			break
		}
		case 'background': {
			const response = await worker.executeFetch(request('/background', 'bg'))
			assert.equal(response.status, 204)
			assert.equal(root('bg').endTime, null)
			await release(worker, 'bg:first')
			await Bun.sleep(20)
			assert.equal(root('bg').endTime, null)
			await release(worker, 'bg:second')
			await until(() => root('bg').endTime !== null)
			assert.equal(root('bg').status, 'error')
			assert.equal(root('bg').statusMessage, 'background failed:bg')
			assert.equal(named('manual:bg').attributes.nested, true)
			await until(() => worker.pendingWaitUntil() === 0)
			break
		}
		case 'cancel': {
			const response = await worker.executeFetch(request('/cancel', 'cancel'))
			assert.ok(response.body)
			await response.body.cancel()
			await until(() => named('manual:cancel').attributes['cancel-started'] === true)
			assert.equal(root('cancel').endTime, null)
			assert.ok(worker.pendingWaitUntil() > 0)
			await release(worker, 'cancel:cancel')
			await until(() => root('cancel').endTime !== null)
			assert.equal(named('manual:cancel').attributes['cancel-finished'], true)
			assert.equal(named('cancel-cleanup:cancel').parentSpanId, root('cancel').spanId)
			assert.equal(root('cancel').status, 'error')
			break
		}
		case 'concurrency': {
			const first = await worker.executeFetch(request('/body', 'one'))
			const second = await worker.executeFetch(request('/body', 'two'))
			assert.notEqual(root('one').traceId, root('two').traceId)
			await release(worker, 'two')
			assert.equal(await second.text(), 'two')
			await until(() => root('two').endTime !== null)
			assert.equal(root('one').endTime, null)
			assert.equal(named('manual:one').attributes['body-done'], undefined)
			await release(worker, 'one')
			assert.equal(await first.text(), 'one')
			await until(() => root('one').endTime !== null)
			assert.equal(named('manual:one').attributes['body-done'], true)
			break
		}
		case 'terminate':
		case 'crash': {
			const other = await executor('second')
			const parent = createInvocationTrace({ name: 'caller', kind: 'server' })
			await parent.run(() => worker.executeFetch(request('/body', 'doomed')))
			const liveResponse = await parent.run(() => other.executeFetch(request('/body', 'live')))
			assert.equal(root('doomed').traceId, root('live').traceId)
			if (process.argv[2] === 'crash') {
				await worker.executeEntrypointRpc('Control', 'crash', [])
				await until(() => root('doomed').endTime !== null)
			} else worker.dispose()
			assert.equal(root('doomed').status, 'error')
			assert.equal(named('manual:doomed').status, 'error')
			assert.equal(root('live').endTime, null)
			assert.equal(named('caller').endTime, null)
			assert.ok(parent.root.isTraced)
			await release(other, 'live')
			assert.equal(await liveResponse.text(), 'live')
			await until(() => root('live').endTime !== null)
			parent.finishHandler()
			assert.equal(named('caller').status, 'ok')
			break
		}
		case 'failures': {
			await assert.rejects(worker.executeFetch(request('/throw', 'throw')), /handler failed/)
			await until(() => root('throw').endTime !== null)
			assert.equal(root('throw').status, 'error')
			await assert.rejects(worker.executeFetch(request('/', 'ctor'), undefined, 'BrokenConstructor'), /constructor failed/)
			await until(() => named('constructor-manual').endTime !== null)
			assert.equal(named('constructor-manual').status, 'error')
			await assert.rejects(worker.executeEntrypointPropertyGet('Control', 'broken'), /getter failed/)
			await until(() => named('broken-getter').endTime !== null)
			assert.equal(named('broken-getter').status, 'error')
			await assert.rejects(worker.executeEntrypointRpc('Control', 'uncloneable', []))
			await until(() => named('uncloneable').endTime !== null)
			assert.equal(named('uncloneable').status, 'error')
			const locked = await worker.executeFetch(request('/locked', 'locked'))
			await assert.rejects(locked.text())
			await until(() => root('locked').endTime !== null)
			assert.equal(root('locked').status, 'error')
			const bodyError = await worker.executeFetch(request('/body-error', 'error'))
			await release(worker, 'error')
			await assert.rejects(bodyError.text(), /body failed:error/)
			await until(() => root('error').endTime !== null)
			assert.equal(root('error').status, 'error')
			break
		}
		case 'handlers': {
			assert.equal(await worker.executeEntrypointRpc('Control', 'rpc', []), 'rpc-ok')
			assert.deepEqual(await worker.executeEntrypointPropertyGet('Control', 'property'), { kind: 'value', value: 'property-ok' })
			await until(() => named('rpc-manual').endTime !== null && named('property-manual').endTime !== null)
			assert.deepEqual(await worker.executeScheduled('* * * * *', Date.now()), { ok: true })
			assert.equal(named('scheduled-manual').endTime, null)
			await release(worker, 'scheduled')
			await until(() => named('scheduled-manual').endTime !== null)
			assert.deepEqual(await worker.executeEmail('test', 'a@example.com', 'b@example.com', new Uint8Array()), { ok: true })
			assert.equal(named('email-manual').endTime, null)
			await release(worker, 'email')
			await until(() => named('email-manual').endTime !== null)
			break
		}
		case 'late-messages': {
			const unsubscribe = store.subscribe(event => {
				if (event.type === 'span.start' && event.span.name === 'burst:0') worker.dispose()
			})
			try {
				await assert.rejects(worker.executeFetch(request('/burst', 'burst')), /terminated/)
				await Bun.sleep(50)
				assert.ok(spans().some(value => value.name === 'burst:0'))
				for (const value of spans()) {
					assert.notEqual(value.endTime, null, `Unfinished late span ${value.name}`)
					assert.equal(value.status, 'error')
					assert.equal(value.attributes['before-termination'], undefined)
				}
			} finally {
				unsubscribe()
			}
			break
		}
		default:
			throw new Error(`Unknown scenario ${process.argv[2]}`)
	}
} finally {
	for (const worker of executors) worker.dispose()
	store.close()
}
