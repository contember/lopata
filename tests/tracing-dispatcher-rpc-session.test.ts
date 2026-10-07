import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { WorkerDispatcher } from '../src/bindings/worker-dispatcher'
import { ExecutionContext, getActiveExecutionContext, runWithExecutionContext } from '../src/execution-context'
import { runTracingMigrations } from '../src/tracing/db'
import { createInvocationTrace, getActiveInvocation, type InvocationTrace } from '../src/tracing/invocation'
import { tracing } from '../src/tracing/span'
import { setTraceStore, TraceStore } from '../src/tracing/store'

let store: TraceStore
let dispatcher: WorkerDispatcher
let owners: InvocationTrace[]
let targetInvocation: InvocationTrace | undefined
let background: ReturnType<typeof Promise.withResolvers<void>>
let pendingCall: ReturnType<typeof Promise.withResolvers<void>>
let callStarted: ReturnType<typeof Promise.withResolvers<void>>
let backgroundFinished: boolean

function owner(name: string): InvocationTrace {
	const invocation = createInvocationTrace({ name })
	owners.push(invocation)
	return invocation
}

function requireObject(value: unknown): object {
	if (value === null || (typeof value !== 'object' && typeof value !== 'function')) throw new Error('Expected RPC capability')
	return value
}

function member(value: unknown, key: PropertyKey): unknown {
	return Reflect.get(requireObject(value), key)
}

async function call(value: unknown, key: PropertyKey, ...args: unknown[]): Promise<unknown> {
	const fn = member(value, key)
	if (typeof fn !== 'function') throw new Error('Expected RPC method')
	return Reflect.apply(fn, value, args)
}

async function invoke(value: unknown): Promise<unknown> {
	if (typeof value !== 'function') throw new Error('Expected RPC function')
	return value()
}

function dispose(value: unknown): void {
	const fn = member(value, Symbol.dispose)
	if (typeof fn !== 'function') throw new Error('Expected disposable RPC capability')
	Reflect.apply(fn, value, [])
}

beforeEach(() => {
	const traces = new Database(':memory:')
	runTracingMigrations(traces)
	store = new TraceStore(traces)
	setTraceStore(store)
	owners = []
	targetInvocation = undefined
	background = Promise.withResolvers<void>()
	pendingCall = Promise.withResolvers<void>()
	callStarted = Promise.withResolvers<void>()
	backgroundFinished = false
	class Capability {
		get [Symbol.for('lopata.RpcTarget')]() {
			return true
		}
		constructor(readonly ctx: ExecutionContext, readonly invocation: InvocationTrace | undefined) {}
		snapshot() {
			return {
				invocation: getActiveInvocation() === this.invocation,
				context: getActiveExecutionContext() === this.ctx,
				tenant: this.ctx.props.tenant,
				traced: tracing.getActiveSpan()?.isTraced,
			}
		}
		child() {
			return new Capability(this.ctx, this.invocation)
		}
		get childValue() {
			return new Capability(this.ctx, this.invocation)
		}
		get snapshotValue() {
			return this.snapshot()
		}
		function() {
			return () => this.snapshot()
		}
		wait() {
			this.ctx.waitUntil(background.promise.then(() => {
				tracing.enterSpan('session-background', () => {
					backgroundFinished = true
				})
			}))
			return this.snapshot()
		}
		async slowChild() {
			callStarted.resolve()
			await pendingCall.promise
			return this.child()
		}
	}
	class Target {
		get [Symbol.for('lopata.WorkerEntrypoint')]() {
			return true
		}
		readonly capability: Capability
		constructor(ctx: ExecutionContext) {
			targetInvocation = getActiveInvocation()
			this.capability = new Capability(ctx, targetInvocation)
		}
		open() {
			return this.capability
		}
		get openProperty() {
			return this.capability
		}
		get asyncProperty() {
			return Promise.resolve(this.capability)
		}
		openFunction() {
			return () => this.capability.wait()
		}
		plain() {
			return 'value'
		}
		broken() {
			throw new Error('initial RPC failed')
		}
	}
	dispatcher = new WorkerDispatcher(
		{ Target },
		{},
		props => new ExecutionContext(props),
	)
})

afterEach(() => {
	dispatcher.terminateInvocations('test cleanup')
	for (const invocation of owners) invocation.terminate('test cleanup')
	background.resolve()
	pendingCall.resolve()
	store.close()
	setTraceStore(null)
})

test('returned function invoked under B keeps A target context and captured waitUntil ownership', async () => {
	const a = owner('A')
	const b = owner('B')
	const fn = await a.run(() => dispatcher.rpc('Target', 'openFunction', [], { tenant: 'A' }))
	const target = targetInvocation
	expect(target?.closed).toBe(false)
	expect(await b.run(() => invoke(fn))).toEqual({ invocation: true, context: true, tenant: 'A', traced: true })
	dispose(fn)
	b.finishHandler()
	expect(b.closed).toBe(true)
	expect(target?.closed).toBe(false)
	background.resolve()
	await target?.completed
	expect(backgroundFinished).toBe(true)
	expect(target?.closed).toBe(true)
	a.finishHandler()
})

test('descendants, dup, getters and returned functions share the original session until final disposal', async () => {
	const a = owner('A')
	const b = owner('B')
	const capability = await a.run(() => dispatcher.rpc('Target', 'open', [], { tenant: 'original' }))
	const target = targetInvocation
	const duplicate = await b.run(() => call(capability, 'dup'))
	const child = await b.run(() => call(capability, 'child'))
	const getterChild = await b.run(async () => member(capability, 'childValue'))
	const fn = await b.run(() => call(child, 'function'))
	dispose(capability)
	expect(() => member(capability, 'snapshot')).toThrow('disposed')
	for (const value of [duplicate, child, getterChild]) {
		expect(await b.run(() => call(value, 'snapshot'))).toEqual({ invocation: true, context: true, tenant: 'original', traced: true })
	}
	expect(await b.run(async () => member(getterChild, 'snapshotValue'))).toEqual({ invocation: true, context: true, tenant: 'original', traced: true })
	expect(await b.run(() => invoke(fn))).toEqual({ invocation: true, context: true, tenant: 'original', traced: true })
	for (const value of [duplicate, child, getterChild]) dispose(value)
	expect(target?.closed).toBe(false)
	dispose(fn)
	expect(target?.closed).toBe(true)
})

test('property dispatch wraps methods, capabilities and asynchronous getters in sessions', async () => {
	for (const property of ['open', 'openProperty', 'asyncProperty']) {
		const value = await dispatcher.property('Target', property, { tenant: property })
		const target = targetInvocation
		expect(target?.closed).toBe(false)
		const capability = property === 'open' ? await invoke(value) : value
		expect(await call(capability, 'snapshot')).toEqual({ invocation: true, context: true, tenant: property, traced: true })
		if (capability !== value) dispose(capability)
		dispose(value)
		expect(target?.closed).toBe(true)
	}
})

test('disposing during an active call keeps the session alive for its returned descendant', async () => {
	const capability = await dispatcher.rpc('Target', 'open', [])
	const target = targetInvocation
	const pending = call(capability, 'slowChild')
	await callStarted.promise
	dispose(capability)
	expect(target?.closed).toBe(false)
	pendingCall.resolve()
	const descendant = await pending
	expect(await call(descendant, 'snapshot')).toEqual({ invocation: true, context: true, tenant: undefined, traced: true })
	dispose(descendant)
	expect(target?.closed).toBe(true)
})

test('caller completion synchronously fences escaped capabilities before its completion callback runs', async () => {
	const a = owner('A')
	const capability = await a.run(() => dispatcher.rpc('Target', 'open', []))
	const target = targetInvocation
	a.finishHandler()
	expect(() => member(capability, 'snapshot')).toThrow('RPC session is closed')
	expect(target?.closed).toBe(true)
	dispose(capability)
})

test('caller completion releases abandoned sessions without a later stub access', async () => {
	const a = owner('A')
	await a.run(() => dispatcher.rpc('Target', 'open', []))
	const target = targetInvocation
	expect(target?.closed).toBe(false)
	a.finishHandler()
	await a.completed
	expect(target?.closed).toBe(true)
})

test('repeated sessions attach only one completion listener to a long-lived caller', async () => {
	const a = owner('long-lived caller')
	const then = spyOn(a.completed, 'then')
	try {
		for (let index = 0; index < 25; index++) {
			expect(await a.run(() => dispatcher.rpc('Target', 'plain', []))).toBe('value')
			expect(targetInvocation?.closed).toBe(true)
		}
		expect(then).toHaveBeenCalledTimes(1)
	} finally {
		then.mockRestore()
	}
})

test('target termination closes escaped capabilities and fences pending descendant returns', async () => {
	const capability = await dispatcher.rpc('Target', 'open', [])
	const pending = call(capability, 'slowChild')
	await callStarted.promise
	dispatcher.terminateInvocations('owner stopped')
	expect(() => member(capability, 'snapshot')).toThrow('RPC session is closed')
	pendingCall.resolve()
	await expect(pending).rejects.toThrow('RPC session is closed')
	dispose(capability)
})

test('explicit event contexts retain sessions without finishing the event owner', async () => {
	const event = owner('event')
	const ctx = event.run(() => new ExecutionContext({ tenant: 'event' }))
	const capability = await event.run(() => dispatcher.rpc('Target', 'open', [], undefined, ctx))
	expect(targetInvocation).toBe(event)
	dispose(capability)
	expect(event.closed).toBe(false)
	event.finishHandler()
	expect(event.closed).toBe(true)
})

test('ctx.exports loopbacks establish sessions and preserve entrypoint props', async () => {
	const caller = owner('loopback-caller')
	const ctx = caller.run(() => dispatcher.context())
	const factory = ctx.exports.Target
	if (typeof factory !== 'function') throw new Error('Missing loopback factory')
	const binding: unknown = factory({ props: { tenant: 'loopback' } })
	const capability = await caller.run(() => runWithExecutionContext(ctx, () => call(binding, 'open')))
	expect(await call(capability, 'snapshot')).toEqual({ invocation: true, context: true, tenant: 'loopback', traced: true })
	dispose(capability)
	expect(targetInvocation?.closed).toBe(true)
})

test('plain returns and initial failures release their initial session share', async () => {
	expect(await dispatcher.rpc('Target', 'plain', [])).toBe('value')
	expect(targetInvocation?.closed).toBe(true)
	await expect(dispatcher.rpc('Target', 'broken', [])).rejects.toThrow('initial RPC failed')
	expect(targetInvocation?.closed).toBe(true)
})

function forwardingDispatcher() {
	const roots = new Map<string, InvocationTrace>()
	function capture(name: string): InvocationTrace {
		const invocation = getActiveInvocation()
		if (!invocation) throw new Error(`Missing ${name} invocation`)
		roots.set(name, invocation)
		return invocation
	}
	class Capability {
		get [Symbol.for('lopata.RpcTarget')]() {
			return true
		}
		constructor(readonly ctx: ExecutionContext, readonly invocation: InvocationTrace) {}
		ping() {
			const tenant = this.ctx.props.tenant
			if (typeof tenant !== 'string') throw new Error('Missing inner tenant')
			tracing.getActiveSpan()?.setAttribute('rpc.origin', tenant)
			return {
				invocation: getActiveInvocation() === this.invocation,
				context: getActiveExecutionContext() === this.ctx,
				tenant,
			}
		}
	}
	class Inner {
		get [Symbol.for('lopata.WorkerEntrypoint')]() {
			return true
		}
		readonly capability: Capability
		constructor(ctx: ExecutionContext) {
			this.capability = new Capability(ctx, capture('Inner'))
		}
		open(kind: string) {
			if (kind === 'function') return () => this.capability.ping()
			if (kind === 'aggregate') return { capability: this.capability, nested: { fn: () => this.capability.ping() } }
			return this.capability
		}
	}
	class Outer {
		get [Symbol.for('lopata.WorkerEntrypoint')]() {
			return true
		}
		constructor(readonly ctx: ExecutionContext) {
			capture('Outer')
		}
		async open(kind: string) {
			const factory = this.ctx.exports.Inner
			if (typeof factory !== 'function') throw new Error('Missing Inner loopback factory')
			const inner: unknown = factory({ props: { tenant: 'inner' } })
			return await call(inner, 'open', kind)
		}
	}
	dispatcher = new WorkerDispatcher(
		{ Outer, Inner },
		{},
		props => new ExecutionContext(props),
	)
	return roots
}

for (const kind of ['target', 'function', 'aggregate']) {
	test(`Outer.open forwards an Inner ${kind} capability with both lifetimes and original context`, async () => {
		const roots = forwardingDispatcher()
		const a = owner('forwarding-caller-A')
		const b = owner('unrelated-caller-B')
		const ended = new Map<string, number>()
		const unsubscribe = store.subscribe(event => {
			if (event.type === 'span.end') ended.set(event.span.name, (ended.get(event.span.name) ?? 0) + 1)
		})
		try {
			const forwarded = await a.run(() => dispatcher.rpc('Outer', 'open', [kind], { tenant: 'outer' }))
			await Promise.resolve()
			const inner = roots.get('Inner')
			const outer = roots.get('Outer')
			if (!inner || !outer) throw new Error('Missing forwarded invocation roots')
			expect(inner.closed).toBe(false)
			expect(outer.closed).toBe(false)
			const expected = { invocation: true, context: true, tenant: 'inner' }
			if (kind === 'target') expect(await b.run(() => call(forwarded, 'ping'))).toEqual(expected)
			else if (kind === 'function') expect(await b.run(() => invoke(forwarded))).toEqual(expected)
			else {
				expect(await b.run(() => call(member(forwarded, 'capability'), 'ping'))).toEqual(expected)
				expect(await b.run(() => invoke(member(member(forwarded, 'nested'), 'fn')))).toEqual(expected)
			}
			const trace = store.listAllSpans({}).items.find(span => span.name === 'rpc Inner.open')
			if (!trace) throw new Error('Missing inner trace')
			const spans = store.getTrace(trace.traceId).spans
			expect(spans.find(span => span.name === 'rpc Inner.open')?.attributes['rpc.origin']).toBe('inner')
			expect(spans.find(span => span.name === 'rpc Outer.open')?.attributes['rpc.origin']).toBeUndefined()
			b.run(() => expect(tracing.getActiveSpan()).toBe(b.root))
			dispose(forwarded)
			expect(inner.closed).toBe(true)
			expect(outer.closed).toBe(true)
			expect(ended.get('rpc Inner.open')).toBe(1)
			expect(ended.get('rpc Outer.open')).toBe(1)
			expect(a.closed).toBe(false)
			expect(b.closed).toBe(false)
		} finally {
			unsubscribe()
		}
	})
}
