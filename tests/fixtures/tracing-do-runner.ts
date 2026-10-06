import { Database } from 'bun:sqlite'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import type { DOExecutor } from '../../src/bindings/do-executor'
import { InProcessExecutorFactory } from '../../src/bindings/do-executor-inprocess'
import { WorkerExecutorFactory } from '../../src/bindings/do-executor-worker'
import { DurableObjectNamespaceImpl } from '../../src/bindings/durable-object'
import { runMigrations } from '../../src/db'
import { ExecutionContext, getActiveExecutionContext, runWithExecutionContext } from '../../src/execution-context'
import { runTracingMigrations } from '../../src/tracing/db'
import { createInvocationTrace } from '../../src/tracing/invocation'
import { tracing } from '../../src/tracing/span'
import { setTraceStore, TraceStore } from '../../src/tracing/store'
import { WorkerThreadExecutor } from '../../src/worker-thread/executor'

const db = new Database(':memory:')
runMigrations(db)
const traceDb = new Database(':memory:')
runTracingMigrations(traceDb)
const store = new TraceStore(traceDb)
setTraceStore(store)
const mode = process.argv[2]
const scenario = process.argv[3]
const workerFactory = new WorkerExecutorFactory()
workerFactory.configure(resolve(import.meta.dir, 'tracing-do-worker.ts'), resolve(import.meta.dir, 'tracing-do-config.json'))
const ns = new DurableObjectNamespaceImpl(
	db,
	'TracedObject',
	process.cwd(),
	{ evictionTimeoutMs: 0 },
	mode === 'thread' ? workerFactory : new InProcessExecutorFactory(),
)
if (mode === 'thread') ns._setExternalClass('TracedObject', { OBJECTS: ns })
else {
	await import('../../src/plugin')
	const { TracedObject } = await import('./tracing-do-worker')
	ns._setClass(TracedObject, { OBJECTS: ns })
}
const id = ns.idFromName('one')
ns.get(id)
const object = ns._getExecutor(id.toString())
assert.ok(object)
let caller: WorkerThreadExecutor | undefined

function spans() {
	return store.listAllSpans({ limit: 1000 }).items.flatMap(row => store.getTrace(row.traceId).spans.filter(span => span.spanId === row.spanId))
}

function named(name: string) {
	const span = spans().find(span => span.name === name)
	assert.ok(span, `Missing ${name}`)
	return span
}

function root(id: string) {
	const child = named(`manual:${id}`)
	const result = spans().find(span => span.spanId === child.parentSpanId)
	assert.ok(result)
	return result
}

async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timeout: ${JSON.stringify(spans())}`)
		await Bun.sleep(5)
	}
}

function request(path: string, id: string): Request {
	return new Request(`http://object${path}?id=${id}`)
}

async function release(object: DOExecutor, id: string): Promise<void> {
	await object.executeRpc('release', [id])
}

function member(target: unknown, key: string | symbol): Function {
	if (!target || (typeof target !== 'object' && typeof target !== 'function')) throw new Error('Missing RPC target')
	const value: unknown = Reflect.get(target, key)
	if (typeof value !== 'function') throw new Error(`Missing RPC member ${String(key)}`)
	return value
}

async function call(target: unknown, key: string, ...args: unknown[]): Promise<unknown> {
	return Reflect.apply(member(target, key), target, args)
}

async function invoke(target: unknown, ...args: unknown[]): Promise<unknown> {
	if (typeof target !== 'function') throw new Error('Missing RPC function')
	return Reflect.apply(target, undefined, args)
}

function dispose(target: unknown): void {
	Reflect.apply(member(target, Symbol.dispose), target, [])
}

try {
	assert.equal(tracing.getActiveSpan(), undefined)
	switch (scenario) {
		case 'session-caller-finish':
		case 'session-caller-terminate': {
			const caller = createInvocationTrace({ name: 'originating-session-caller' })
			const target = await caller.run(() => object.executeRpc('capability', ['caller-target']))
			const idleFunction = await caller.run(() => object.executeRpc('functionCapability', ['caller-idle-function']))
			const extracted = await caller.run(() => object.executeRpcGet('functionCapability'))
			const other = createInvocationTrace({ name: 'unrelated-later-caller' })
			const fn = await other.run(() => invoke(extracted, 'caller-extracted'))
			assert.equal(await other.run(() => call(target, 'touch', 'later-caller')), 'caller-target')
			other.finishHandler()
			await other.completed
			assert.equal(root('caller-target').endTime, null)
			assert.equal(root('caller-idle-function').endTime, null)
			assert.equal(root('caller-extracted').endTime, null)
			assert.equal(await call(target, 'touch', 'after-later-caller'), 'caller-target')
			assert.ok(object.isActive())
			if (scenario === 'session-caller-finish') caller.finishHandler()
			else caller.terminate('Caller terminated')
			assert.throws(() => member(target, 'touch'), /closed/)
			await until(() => !object.isActive())
			for (const id of ['caller-target', 'caller-idle-function', 'caller-extracted']) assert.notEqual(root(id).endTime, null)
			await assert.rejects(invoke(idleFunction), /closed/)
			await assert.rejects(invoke(extracted, 'late'), /closed/)
			await assert.rejects(invoke(fn), /closed/)
			dispose(target)
			dispose(idleFunction)
			dispose(extracted)
			dispose(fn)
			break
		}
		case 'session-initial-executor-scalar':
		case 'session-initial-executor-plain':
		case 'session-initial-executor-getter':
		case 'session-initial-caller-scalar':
		case 'session-initial-caller-plain':
		case 'session-initial-caller-getter': {
			const kind = scenario.endsWith('-getter') ? 'getter' : scenario.endsWith('-plain') ? 'plain' : 'scalar'
			const caller = createInvocationTrace({ name: 'pending-result-caller' })
			const pending = caller.run(() =>
				kind === 'getter'
					? object.executeRpcGet('delayedProperty')
					: object.executeRpc('delayedResult', [kind])
			)
			const rejected = assert.rejects(pending, /closed/)
			await until(() => spans().some(span => span.name === `manual:initial-${kind}`))
			if (scenario.includes('-executor-')) await object.dispose()
			else caller.finishHandler()
			await call(ns._getInstance(id.toString()), 'release', `initial-${kind}`)
			await rejected
			await until(() => !object.isActive())
			assert.notEqual(root(`initial-${kind}`).endTime, null)
			caller.finishHandler()
			break
		}
		case 'session-target': {
			const stub = ns.get(id)
			const target = await call(stub, 'capability', 'session-target')
			assert.equal(root('session-target').endTime, null)
			assert.ok(object.isActive())
			const duplicate = await call(target, 'dup')
			dispose(target)
			await assert.rejects(call(target, 'touch', 'disposed'), /disposed/)
			const unrelated = createInvocationTrace({ name: 'unrelated-session-caller' })
			await unrelated.run(() =>
				runWithExecutionContext(new ExecutionContext({ 'caller-only': true }), async () => {
					const child = await call(duplicate, 'child')
					assert.equal(await call(child, 'touch', 'nested'), 'session-target:child')
					const callback = await call(duplicate, 'callback')
					assert.equal(await invoke(callback), 'session-target')
					dispose(duplicate)
					dispose(child)
					dispose(callback)
					assert.equal(root('session-target').endTime, null)
					await release(object, 'session-target:background')
					await until(() => root('session-target').endTime !== null && !object.isActive())
					for (
						const name of [
							'capability:session-target:child',
							'capability:session-target:child:nested',
							'capability:session-target:callback',
							'capability:session-target:background',
						]
					) {
						assert.equal(named(name).parentSpanId, root('session-target').spanId)
					}
					assert.equal(named('unrelated-session-caller').endTime, null)
				})
			)
			unrelated.finishHandler()
			break
		}
		case 'session-function-get': {
			const extracted = await object.executeRpcGet('functionCapability')
			const unrelated = createInvocationTrace({ name: 'unrelated-function-caller' })
			await unrelated.run(async () => {
				const fn = await invoke(extracted, 'session-function')
				assert.equal(root('session-function').name, 'do.rpc-get TracedObject')
				const duplicate = await call(fn, 'dup')
				dispose(extracted)
				dispose(fn)
				await assert.rejects(invoke(fn), /disposed/)
				const target = await invoke(duplicate)
				dispose(duplicate)
				assert.equal(root('session-function').endTime, null)
				assert.equal(await call(target, 'touch', 'function-result'), 'session-function')
				assert.equal(named('function:session-function').parentSpanId, root('session-function').spanId)
				assert.equal(named('capability:session-function:function-result').parentSpanId, root('session-function').spanId)
				dispose(target)
				await until(() => root('session-function').endTime !== null)
				const property: unknown = await member(ns.get(id), 'targetProperty')
				assert.equal(root('property-capability').name, 'do.rpc-get TracedObject')
				assert.equal(await call(property, 'touch', 'property-result'), 'property-capability')
				assert.equal(named('capability:property-capability:property-result').parentSpanId, root('property-capability').spanId)
				dispose(property)
				await until(() => root('property-capability').endTime !== null && !object.isActive())
			})
			unrelated.finishHandler()
			break
		}
		case 'session-inflight': {
			const target = await call(ns.get(id), 'capability', 'session-inflight')
			const pending = call(target, 'delayedChild')
			dispose(target)
			assert.equal(root('session-inflight').endTime, null)
			assert.ok(object.isActive())
			await release(object, 'session-inflight:call')
			const child = await pending
			assert.equal(root('session-inflight').endTime, null)
			assert.equal(await call(child, 'touch', 'after-flight'), 'session-inflight:delayed')
			assert.equal(named('capability:session-inflight:delayed:after-flight').parentSpanId, root('session-inflight').spanId)
			dispose(child)
			dispose(child)
			await until(() => root('session-inflight').endTime !== null && !object.isActive())
			break
		}
		case 'session-terminate': {
			const parent = createInvocationTrace({ name: 'session-surviving-parent' })
			const manual = parent.run(() => tracing.startSpan('session-parent-manual'))
			const target = await parent.run(() => call(ns.get(id), 'capability', 'session-terminate'))
			const saved = member(target, 'touch')
			const pending = call(target, 'delayedChild')
			await object.dispose()
			assert.notEqual(root('session-terminate').endTime, null)
			assert.equal(root('session-terminate').status, 'error')
			await assert.rejects(invoke(saved, 'closed'), /closed/)
			await assert.rejects(call(target, 'dup'), /closed/)
			await call(ns._getInstance(id.toString()), 'release', 'session-terminate:call')
			await assert.rejects(pending, /closed/)
			dispose(target)
			assert.equal(named('session-parent-manual').endTime, null)
			manual.setAttribute('live', true)
			assert.equal(named('session-parent-manual').attributes.live, true)
			parent.finishHandler()
			break
		}
		case 'session-nested': {
			const result = await call(ns.get(id), 'nestedCapabilities', 'session-nested')
			assert.ok(result && typeof result === 'object' && 'children' in result && Array.isArray(result.children))
			const target = result.children[0]
			const fn = result.children[1]
			const targetDuplicate = await call(target, 'dup')
			const functionDuplicate = await call(fn, 'dup')
			dispose(result)
			dispose(result)
			await assert.rejects(invoke(fn), /disposed/)
			assert.equal(await call(targetDuplicate, 'touch', 'duplicate'), 'session-nested:nested')
			const child = await invoke(functionDuplicate)
			dispose(targetDuplicate)
			dispose(functionDuplicate)
			assert.equal(root('session-nested').endTime, null)
			assert.equal(await call(child, 'touch', 'nested-result'), 'session-nested:function')
			assert.equal(named('capability:session-nested:function:nested-result').parentSpanId, root('session-nested').spanId)
			dispose(child)
			await until(() => root('session-nested').endTime !== null && !object.isActive())
			break
		}
		case 'body': {
			const response = await object.executeFetch(request('/body', 'slow'))
			assert.equal(root('slow').name, 'do.fetch TracedObject')
			assert.equal(root('slow').endTime, null)
			assert.equal(named('manual:slow').endTime, null)
			assert.ok(object.isActive())
			const text = response.text()
			await release(object, 'slow')
			assert.equal(await text, 'slow')
			await until(() => root('slow').endTime !== null && !object.isActive())
			assert.equal(named('body:slow').parentSpanId, root('slow').spanId)
			assert.equal(named('manual:slow').attributes['body-done'], true)
			assert.equal(root('slow').status, 'ok')
			assert.equal(named('do-constructor').name, 'do-constructor')
			assert.equal(named('do-constructor-ready').parentSpanId, named('do-constructor').parentSpanId)
			break
		}
		case 'background': {
			const response = await object.executeFetch(request('/background', 'bg'))
			assert.equal(response.status, 204)
			assert.ok(object.isActive())
			await release(object, 'bg:first')
			assert.equal(root('bg').endTime, null)
			await release(object, 'bg:second')
			await until(() => root('bg').endTime !== null && !object.isActive())
			assert.equal(root('bg').status, 'error')
			assert.equal(root('bg').statusMessage, 'background failed:bg')
			assert.equal(named('background:bg').parentSpanId, root('bg').spanId)
			assert.equal(named('manual:bg').attributes.nested, true)
			break
		}
		case 'cancel':
		case 'cancel-error': {
			const response = await object.executeFetch(request('/cancel', scenario))
			assert.ok(response.body)
			const cancelled = response.body.cancel().catch(error => error)
			await until(() => named(`manual:${scenario}`).attributes['cancel-started'] === true)
			assert.equal(root(scenario).endTime, null)
			assert.ok(object.isActive())
			await release(object, `${scenario}:cancel`)
			await cancelled
			await until(() => root(scenario).endTime !== null && !object.isActive())
			assert.equal(named(`cleanup:${scenario}`).parentSpanId, root(scenario).spanId)
			assert.equal(named(`manual:${scenario}`).attributes['cancel-finished'], true)
			assert.equal(root(scenario).status, 'error')
			if (scenario === 'cancel-error') assert.equal(root(scenario).statusMessage, 'cleanup failed')
			break
		}
		case 'concurrency': {
			const first = createInvocationTrace({ name: 'parent-one' })
			const second = createInvocationTrace({ name: 'parent-two' })
			const a = first.run(() => object.executeFetch(request('/handler', 'one')))
			const b = second.run(() => object.executeFetch(request('/handler', 'two')))
			await until(() => spans().filter(span => span.name.startsWith('manual:')).length === 2)
			await release(object, 'two')
			await b
			await until(() => root('two').endTime !== null)
			assert.equal(root('one').endTime, null)
			await release(object, 'one')
			await a
			await until(() => root('one').endTime !== null)
			assert.equal(root('one').parentSpanId, named('parent-one').spanId)
			assert.equal(root('two').parentSpanId, named('parent-two').spanId)
			assert.notEqual(root('one').traceId, root('two').traceId)
			assert.equal(named('handler:one').parentSpanId, root('one').spanId)
			assert.equal(named('handler:two').parentSpanId, root('two').spanId)
			first.finishHandler()
			second.finishHandler()
			break
		}
		case 'terminate':
		case 'terminate-body':
		case 'crash': {
			const parent = createInvocationTrace({ name: 'surviving-parent' })
			const parentManual = parent.run(() => tracing.startSpan('parent-manual'))
			const response = await parent.run(() => object.executeFetch(request(scenario === 'terminate-body' ? '/body' : '/background', 'dying')))
			assert.equal(root('dying').endTime, null)
			if (scenario === 'crash') await object.executeRpc('crash', [])
			else await object.dispose()
			await until(() => root('dying').endTime !== null)
			assert.equal(root('dying').status, 'error')
			assert.notEqual(named('manual:dying').endTime, null)
			assert.equal(named('surviving-parent').endTime, null)
			assert.equal(named('parent-manual').endTime, null)
			parentManual.setAttribute('still-live', true)
			assert.equal(named('parent-manual').attributes['still-live'], true)
			parent.finishHandler()
			await response.body?.cancel().catch(() => {})
			break
		}
		case 'handlers': {
			assert.equal(await object.executeRpc('rpc', []), 'rpc-ok')
			assert.equal(await object.executeRpcGet('property'), 'property-ok')
			const property = object.executeRpcGet('asyncProperty')
			await until(() => spans().some(span => span.name === 'async-property-manual'))
			assert.equal(named('async-property-manual').endTime, null)
			await release(object, 'property')
			assert.equal(await property, 'async-property-ok')
			await assert.rejects(object.executeRpcGet('broken'), /getter failed/)
			await object.executeAlarm(0)
			assert.equal(named('alarm-manual').endTime, null)
			await release(object, 'alarm')
			await until(() => named('alarm-manual').endTime !== null && !object.isActive())
			assert.notEqual(named('rpc-manual').endTime, null)
			assert.notEqual(named('property-manual').endTime, null)
			assert.notEqual(named('async-property-manual').endTime, null)
			assert.equal(named('async-property-ready').parentSpanId, named('async-property-manual').parentSpanId)
			assert.equal(named('broken-property').status, 'error')
			await assert.rejects(object.executeFetch(request('/throw', 'throws')), /handler failed/)
			await until(() => root('throws').endTime !== null)
			assert.equal(root('throws').status, 'error')
			break
		}
		case 'failures': {
			const response = await object.executeFetch(request('/body-error', 'error'))
			await release(object, 'error')
			await assert.rejects(response.text(), /body failed/)
			await until(() => root('error').endTime !== null)
			assert.equal(root('error').status, 'error')
			const locked = await object.executeFetch(request('/locked', 'locked'))
			await assert.rejects(locked.text())
			await until(() => root('locked').endTime !== null)
			assert.equal(root('locked').status, 'error')
			if (mode === 'thread') {
				await assert.rejects(object.executeRpc('uncloneable', []))
				await until(() => named('uncloneable').endTime !== null)
				assert.equal(named('uncloneable').status, 'error')
			}
			break
		}
		case 'constructor-failure': {
			const broken = new DurableObjectNamespaceImpl(
				db,
				'BrokenObject',
				process.cwd(),
				{ evictionTimeoutMs: 0 },
				mode === 'thread' ? workerFactory : new InProcessExecutorFactory(),
			)
			try {
				if (mode === 'thread') {
					broken._setExternalClass('BrokenObject', {})
					const id = broken.idFromName('broken')
					broken.get(id)
					const executor = broken._getExecutor(id.toString())
					assert.ok(executor)
					await assert.rejects(executor.executeFetch(request('/', 'broken')), /constructor failed/)
					assert.equal(executor.isDisposed?.(), true)
				} else {
					const { BrokenObject } = await import('./tracing-do-worker')
					broken._setClass(BrokenObject, {})
					assert.throws(() => broken.get(broken.idFromName('broken')), /constructor failed/)
				}
				assert.notEqual(named('broken-constructor').endTime, null)
				assert.equal(named('broken-constructor').status, 'error')
			} finally {
				broken.destroy({ force: true })
			}
			break
		}
		case 'runtime-isolation': {
			const context = new ExecutionContext({ 'caller-only': true })
			await runWithExecutionContext(context, async () => {
				const response = await object.executeFetch(request('/cancel', 'runtime'))
				assert.equal(getActiveExecutionContext(), context)
				assert.ok(response.body)
				const cancelled = response.body.cancel()
				await until(() => named('manual:runtime').attributes['cancel-started'] === true)
				await release(object, 'runtime:cancel')
				await cancelled
				await until(() => root('runtime').endTime !== null)
				assert.equal(named('manual:runtime').attributes['cancel-finished'], true)
				assert.equal(getActiveExecutionContext(), context)
			})
			assert.equal(getActiveExecutionContext(), undefined)
			break
		}
		case 'late-messages': {
			const unsubscribe = store.subscribe(event => {
				if (event.type === 'span.start' && event.span.name === 'burst:0') void object.dispose()
			})
			try {
				await assert.rejects(object.executeFetch(request('/burst', 'burst')), /terminated/)
				await Bun.sleep(50)
				assert.ok(spans().some(span => span.name === 'burst:0'))
				for (const span of spans().filter(span => span.name.startsWith('burst:') || span.name === 'manual:burst')) {
					assert.notEqual(span.endTime, null, `Unfinished late span ${span.name}`)
					assert.equal(span.status, 'error')
					assert.equal(span.attributes['before-termination'], undefined)
				}
			} finally {
				unsubscribe()
			}
			break
		}
		case 'parent-worker': {
			caller = new WorkerThreadExecutor({
				modulePath: resolve(import.meta.dir, 'tracing-do-worker.ts'),
				config: { name: 'caller', durable_objects: { bindings: [{ name: 'OBJECTS', class_name: 'TracedObject' }] } },
				workerName: 'caller',
				baseDir: process.cwd(),
				mainEnv: { OBJECTS: ns },
			})
			await caller.ready()
			const response = await caller.executeFetch(request('/body', 'through-worker'))
			const text = response.text()
			await release(object, 'through-worker')
			assert.equal(await text, 'through-worker')
			await until(() => root('through-worker').endTime !== null)
			const ancestry = new Set<string>()
			let current = root('through-worker')
			while (current.parentSpanId) {
				const ancestor = spans().find(span => span.spanId === current.parentSpanId)
				assert.ok(ancestor, `Missing parent ${current.parentSpanId}`)
				ancestry.add(ancestor.name)
				current = ancestor
			}
			assert.ok(ancestry.has('caller-span'))
			assert.ok(ancestry.has('fetch default'))
			break
		}
		default:
			throw new Error(`Unknown scenario ${scenario}`)
	}
	assert.equal(tracing.getActiveSpan(), undefined)
} finally {
	caller?.dispose()
	ns.destroy({ force: true })
	await Bun.sleep(30)
	db.close()
	traceDb.close()
}
