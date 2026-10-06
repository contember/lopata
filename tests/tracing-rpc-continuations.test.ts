import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createRpcSession } from '../src/bindings/rpc-session'
import { createRpcFunctionStub, RPC_TARGET_BRAND } from '../src/bindings/rpc-stub'
import { ExecutionContext, getActiveExecutionContext, runWithExecutionContext } from '../src/execution-context'
import { runTracingMigrations } from '../src/tracing/db'
import { createInvocationTrace, getActiveInvocation, type InvocationTrace } from '../src/tracing/invocation'
import { tracing } from '../src/tracing/span'
import { setTraceStore, TraceStore } from '../src/tracing/store'

let store: TraceStore
let owners: InvocationTrace[]

beforeEach(() => {
	const db = new Database(':memory:')
	runTracingMigrations(db)
	store = new TraceStore(db)
	setTraceStore(store)
	owners = []
})

afterEach(() => {
	for (const owner of owners) owner.terminate('test cleanup')
	store.close()
	setTraceStore(null)
})

function owner(name: string) {
	const invocation = createInvocationTrace({ name, newTrace: true })
	owners.push(invocation)
	return invocation
}

function callable(target: unknown, key?: string | symbol): Function {
	if (!target || (typeof target !== 'object' && typeof target !== 'function')) throw new Error('Missing target')
	const value: unknown = key === undefined ? target : Reflect.get(target, key)
	if (typeof value !== 'function') throw new Error('Missing callable')
	return value
}

test('returned capabilities re-enter A while B stays active; captured waitUntil independently retains A', async () => {
	const a = owner('original A')
	const b = owner('caller B')
	const background = Promise.withResolvers<void>()
	const ctx = a.run(() => new ExecutionContext({ tenant: 'A' }))
	const session = createRpcSession({
		run: callback => a.run(() => runWithExecutionContext(ctx, callback)),
		retain: () => a.retain('handler'),
		isClosed: () => a.closed,
	})
	void a.completed.then(() => session.close())
	const observe = (name: string) => {
		expect(getActiveInvocation()).toBe(a)
		expect(getActiveExecutionContext()).toBe(ctx)
		tracing.enterSpan(name, () => {})
	}
	const initial = createRpcFunctionStub(
		() => {
			observe('function A')
			ctx.waitUntil(background.promise)
			return {
				[RPC_TARGET_BRAND]: true,
				get next() {
					observe('getter A')
					return () => {
						observe('nested A')
						return 'done'
					}
				},
			}
		},
		undefined,
		session,
	)
	session.finish()
	a.finishHandler()
	expect(a.closed).toBe(false)
	await b.run(async () => {
		const target = await initial()
		expect(getActiveInvocation()).toBe(b)
		const property = callable(target, 'next')
		const nested = await property
		const duplicate = callable(nested, 'dup')()
		callable(initial, Symbol.dispose)()
		callable(target, Symbol.dispose)()
		callable(nested, Symbol.dispose)()
		expect(await duplicate()).toBe('done')
		expect(getActiveInvocation()).toBe(b)
		callable(duplicate, Symbol.dispose)()
	})
	b.finishHandler()
	expect(b.closed).toBe(true)
	expect(a.closed).toBe(false)
	const rows = store.listAllSpans({}).items
	const original = rows.find(row => row.name === 'original A')
	if (!original) throw new Error('Missing original span')
	const spans = store.getTrace(original.traceId).spans
	for (const name of ['function A', 'getter A', 'nested A']) {
		const row = spans.find(row => row.name === name)
		expect(row?.traceId).toBe(original.traceId)
		expect(row?.parentSpanId).toBe(original.spanId)
	}
	background.resolve()
	await a.completed
	expect(a.closed).toBe(true)
})

test('owner termination rejects late results without reopening A or mutating B', async () => {
	const a = owner('terminated A')
	const b = owner('surviving B')
	const gate = Promise.withResolvers<void>()
	const ctx = a.run(() => new ExecutionContext())
	const session = createRpcSession({
		run: callback => a.run(() => runWithExecutionContext(ctx, callback)),
		retain: () => a.retain('handler'),
		isClosed: () => a.closed,
	})
	void a.completed.then(() => session.close())
	const fn = createRpcFunctionStub(
		async () => {
			await gate.promise
			tracing.enterSpan('late span', () => {})
			return () => 'late capability'
		},
		undefined,
		session,
	)
	session.finish()
	a.finishHandler()
	const pending = b.run(() => fn())
	a.terminate('owner stopped')
	gate.resolve()
	await expect(pending).rejects.toThrow('closed')
	await b.run(async () => {
		await expect(fn()).rejects.toThrow('closed')
		expect(getActiveInvocation()).toBe(b)
	})
	expect(store.listAllSpans({}).items.some(row => row.name === 'late span')).toBe(false)
	expect(b.closed).toBe(false)
	b.finishHandler()
})
