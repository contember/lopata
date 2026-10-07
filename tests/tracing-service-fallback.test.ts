import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { RPC_TARGET_BRAND } from '../src/bindings/rpc-stub'
import { ServiceBinding } from '../src/bindings/service-binding'
import { WorkerDispatcher } from '../src/bindings/worker-dispatcher'
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

function activeOwner(): InvocationTrace {
	const owner = getActiveInvocation()
	if (!owner) throw new Error('Missing invocation')
	owners.push(owner)
	return owner
}

function binding(module: Record<string, unknown>, entrypoint?: string): ServiceBinding {
	const result = new ServiceBinding('backend', entrypoint, undefined, { tenant: 'target' })
	result._wire(module, { marker: 'environment' })
	return result
}

async function call(target: unknown, method: string, ...args: unknown[]): Promise<unknown> {
	if (!target || (typeof target !== 'object' && typeof target !== 'function')) throw new Error('Missing RPC target')
	const member: unknown = Reflect.get(target, method)
	if (typeof member !== 'function') throw new Error('Missing RPC method')
	return Reflect.apply(member, target, args)
}

async function invoke(fn: unknown): Promise<unknown> {
	if (typeof fn !== 'function') throw new Error('Missing returned function')
	return Reflect.apply(fn, undefined, [])
}

function dispose(stub: unknown): void {
	if (!stub || (typeof stub !== 'object' && typeof stub !== 'function')) throw new Error('Missing disposable stub')
	const method: unknown = Reflect.get(stub, Symbol.dispose)
	if (typeof method !== 'function') throw new Error('Missing disposer')
	Reflect.apply(method, stub, [])
}

function property(target: unknown, name: string): unknown {
	if (!target || (typeof target !== 'object' && typeof target !== 'function')) throw new Error('Missing property target')
	return Reflect.get(target, name)
}

function span(name: string) {
	const row = store.listAllSpans({}).items.find(item => item.name === name)
	if (!row) throw new Error(`Missing span ${name}`)
	const result = store.getTrace(row.traceId).spans.find(item => item.spanId === row.spanId)
	if (!result) throw new Error(`Missing trace span ${name}`)
	return result
}

test('legacy fallback fetch, RPC and property reads establish target roots without an outer invocation', async () => {
	class Target {
		constructor(readonly ctx: ExecutionContext) {
			activeOwner()
			expect(getActiveExecutionContext()).toBe(ctx)
			tracing.enterSpan('constructor', () => {})
		}
		fetch() {
			return new Response(null, { status: 204 })
		}
		method() {
			return this.ctx.tracing.getActiveSpan()?.isTraced
		}
		get value() {
			return this.ctx.tracing.getActiveSpan()?.isTraced
		}
	}
	const target = binding({ Target }, 'Target')
	expect((await target.fetch('http://test/direct')).status).toBe(204)
	expect(await call(target.toProxy(), 'method')).toBe(true)
	expect(await target.toProxy().value).toBe(true)
	for (const name of ['GET /direct', 'rpc Target.method', 'rpc Target.value']) {
		expect(span(name).parentSpanId).toBeNull()
		expect(span(name).endTime).not.toBeNull()
	}
	expect(owners.every(owner => owner.closed)).toBe(true)
})

test('nested fallback background ownership survives deferred registration under an unrelated invocation', async () => {
	const parent = createInvocationTrace({ name: 'caller' })
	const unrelated = createInvocationTrace({ name: 'unrelated' })
	owners.push(parent, unrelated)
	const initial = Promise.withResolvers<void>()
	const nested = Promise.withResolvers<void>()
	let captured: ExecutionContext | undefined
	let targetOwner: InvocationTrace | undefined
	const target = binding({
		default: {
			fetch(_request: Request, env: unknown, ctx: ExecutionContext) {
				expect(env).toEqual({ marker: 'environment' })
				captured = ctx
				targetOwner = activeOwner()
				ctx.waitUntil(initial.promise)
				return new Response(null, { status: 204 })
			},
		},
	})
	await parent.run(() => target.fetch('http://test/nested'))
	parent.finishHandler()
	if (!captured || !targetOwner) throw new Error('Missing captured context')
	const ctx = captured
	unrelated.run(() => ctx.waitUntil(Promise.resolve().then(() => ctx.waitUntil(nested.promise))))
	unrelated.finishHandler()
	initial.resolve()
	await Promise.resolve()
	expect(parent.closed).toBe(true)
	expect(unrelated.closed).toBe(true)
	expect(targetOwner.closed).toBe(false)
	expect(span('GET /nested').parentSpanId).toBe(span('caller').spanId)
	nested.resolve()
	await targetOwner.completed
	expect(targetOwner.closed).toBe(true)
})

for (const failure of ['constructor', 'getter', 'method']) {
	test(`${failure} failure rejects promptly but retains registered background work`, async () => {
		const gate = Promise.withResolvers<void>()
		let owner: InvocationTrace | undefined
		class Target {
			constructor(readonly ctx: ExecutionContext) {
				owner = activeOwner()
				ctx.waitUntil(gate.promise)
				if (failure === 'constructor') throw new Error('constructor failed')
			}
			get value() {
				throw new Error('getter failed')
			}
			method() {
				throw new Error('method failed')
			}
		}
		const proxy = binding({ default: Target }).toProxy()
		const result = failure === 'getter' ? Promise.resolve(proxy.value) : call(proxy, 'method')
		await expect(result).rejects.toThrow(`${failure} failed`)
		if (!owner) throw new Error('Missing target owner')
		expect(owner.closed).toBe(false)
		gate.resolve()
		await owner.completed
		expect(span(`rpc default.${failure === 'getter' ? 'value' : 'method'}`).status).toBe('error')
	})
}

test('RPC result arrives before background rejection, which logs once and fails the target root', async () => {
	const log = spyOn(console, 'error').mockImplementation(() => {})
	try {
		const gate = Promise.withResolvers<void>()
		let owner: InvocationTrace | undefined
		class Target {
			constructor(readonly ctx: ExecutionContext) {}
			method() {
				owner = activeOwner()
				this.ctx.waitUntil(gate.promise)
				return 'ready'
			}
		}
		expect(await call(binding({ default: Target }).toProxy(), 'method')).toBe('ready')
		if (!owner) throw new Error('Missing target owner')
		expect(owner.closed).toBe(false)
		gate.reject(new Error('background failed'))
		await owner.completed
		expect(log).toHaveBeenCalledTimes(1)
		expect(span('rpc default.method').status).toBe('error')
	} finally {
		log.mockRestore()
	}
})

test('fetch headers stay immediate and body pulls remain lazy in target scope through EOF', async () => {
	const gate = Promise.withResolvers<void>()
	let owner: InvocationTrace | undefined
	let pulls = 0
	const target = binding({
		default: {
			fetch(_request: Request, _env: unknown, ctx: ExecutionContext) {
				owner = activeOwner()
				ctx.waitUntil(gate.promise)
				return new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							pulls++
							expect(getActiveExecutionContext()).toBe(ctx)
							tracing.enterSpan('body-pull', () => {})
							controller.enqueue(new TextEncoder().encode('body'))
							controller.close()
						},
					}, { highWaterMark: 0 }),
				)
			},
		},
	})
	const response = await target.fetch('http://test/body')
	if (!owner) throw new Error('Missing target owner')
	expect(pulls).toBe(0)
	expect(await response.text()).toBe('body')
	expect(owner.closed).toBe(false)
	expect(span('body-pull').parentSpanId).toBe(span('GET /body').spanId)
	gate.resolve()
	await owner.completed
})

test('body cancellation retains target ownership until asynchronous source cleanup settles', async () => {
	const cleanup = Promise.withResolvers<void>()
	const started = Promise.withResolvers<void>()
	let owner: InvocationTrace | undefined
	const target = binding({
		default: {
			fetch(_request: Request, _env: unknown, ctx: ExecutionContext) {
				owner = activeOwner()
				return new Response(
					new ReadableStream<Uint8Array>({
						pull() {
							started.resolve()
						},
						async cancel() {
							await cleanup.promise
							expect(getActiveExecutionContext()).toBe(ctx)
							tracing.enterSpan('cancel-cleanup', () => {})
						},
					}, { highWaterMark: 0 }),
				)
			},
		},
	})
	const response = await target.fetch('http://test/cancel')
	if (!owner || !response.body) throw new Error('Missing body owner')
	const reader = response.body.getReader()
	const reading = reader.read()
	await started.promise
	const cancelled = reader.cancel('stop')
	await reading
	expect(owner.closed).toBe(false)
	cleanup.resolve()
	await cancelled
	await owner.completed
	expect(span('GET /cancel').status).toBe('error')
	expect(span('cancel-cleanup').parentSpanId).toBe(span('GET /cancel').spanId)
})

test('returned function and target descendants keep session A and captured waitUntil while B is active', async () => {
	const caller = createInvocationTrace({ name: 'caller-A' })
	const unrelated = createInvocationTrace({ name: 'caller-B' })
	owners.push(caller, unrelated)
	const background = Promise.withResolvers<void>()
	let owner: InvocationTrace | undefined
	class Capability {
		[RPC_TARGET_BRAND] = true
		constructor(readonly ctx: ExecutionContext) {}
		get child() {
			tracing.enterSpan('capability-getter', () => {})
			return () => {
				expect(getActiveExecutionContext()).toBe(this.ctx)
				expect(getActiveInvocation()).toBe(owner)
				this.ctx.waitUntil(background.promise.then(() => tracing.enterSpan('session-background', () => {})))
				return tracing.getActiveSpan()?.isTraced
			}
		}
	}
	class Target {
		constructor(readonly ctx: ExecutionContext) {
			owner = activeOwner()
		}
		method() {
			return () => new Capability(this.ctx)
		}
	}
	const proxy = binding({ default: Target }).toProxy()
	const fn = await caller.run(() => call(proxy, 'method'))
	if (!owner) throw new Error('Missing session owner')
	expect(owner.closed).toBe(false)
	const unrelatedCtx = unrelated.run(() => new ExecutionContext({ tenant: 'other' }))
	await unrelated.run(() =>
		runWithExecutionContext(unrelatedCtx, async () => {
			const cap = await invoke(fn)
			const child = await property(cap, 'child')
			dispose(fn)
			dispose(cap)
			expect(await invoke(child)).toBe(true)
			dispose(child)
			expect(getActiveExecutionContext()).toBe(unrelatedCtx)
			expect(getActiveInvocation()).toBe(unrelated)
		})
	)
	unrelated.finishHandler()
	caller.finishHandler()
	expect(unrelated.closed).toBe(true)
	expect(owner.closed).toBe(false)
	expect(span('capability-getter').parentSpanId).toBe(span('rpc default.method').spanId)
	expect(span('rpc default.method').parentSpanId).toBe(span('caller-A').spanId)
	background.resolve()
	await owner.completed
	expect(span('session-background').parentSpanId).toBe(span('rpc default.method').spanId)
	expect(store.listAllSpans({}).items.filter(row => row.name.startsWith('rpc '))).toHaveLength(1)
})

test('programmatic awaited function member and its duplicate retain the original session until disposal', async () => {
	let owner: InvocationTrace | undefined
	class Target {
		constructor(readonly ctx: ExecutionContext) {
			owner = activeOwner()
		}
		method() {
			expect(getActiveExecutionContext()).toBe(this.ctx)
			expect(getActiveInvocation()).toBe(owner)
			return tracing.getActiveSpan()?.isTraced
		}
	}
	const fn = await binding({ default: Target }).toProxy().method
	if (!owner) throw new Error('Missing session owner')
	const duplicate = await call(fn, 'dup')
	dispose(fn)
	await expect(invoke(fn)).rejects.toThrow('disposed')
	expect(owner.closed).toBe(false)
	expect(await invoke(duplicate)).toBe(true)
	dispose(duplicate)
	await owner.completed
	expect(owner.root.isTraced).toBe(false)
	await expect(invoke(duplicate)).rejects.toThrow('disposed')
})

test('target duplicates, concurrent calls and getter/call errors drain the same session after disposal', async () => {
	const first = Promise.withResolvers<void>()
	const second = Promise.withResolvers<void>()
	let owner: InvocationTrace | undefined
	class Capability {
		[RPC_TARGET_BRAND] = true
		get broken() {
			expect(getActiveInvocation()).toBe(owner)
			throw new Error('getter failed')
		}
		async wait(which: number) {
			await (which === 1 ? first.promise : second.promise)
			expect(getActiveInvocation()).toBe(owner)
			tracing.enterSpan(`call-${which}`, () => {})
			if (which === 2) throw new Error('call failed')
			return 'done'
		}
	}
	const proxy = binding({
		default: {
			method() {
				owner = activeOwner()
				return new Capability()
			},
		},
	}).toProxy()
	const cap = await call(proxy, 'method')
	if (!owner) throw new Error('Missing session owner')
	const duplicate = await call(cap, 'dup')
	expect(() => property(cap, 'broken')).toThrow('getter failed')
	const pendingFirst = call(cap, 'wait', 1)
	const pendingSecond = call(duplicate, 'wait', 2)
	const rejection = pendingSecond.catch((error: unknown) => error)
	dispose(cap)
	dispose(duplicate)
	expect(owner.closed).toBe(false)
	first.resolve()
	expect(await pendingFirst).toBe('done')
	expect(owner.closed).toBe(false)
	second.resolve()
	expect(await rejection).toEqual(new Error('call failed'))
	await owner.completed
	expect(span('call-1').parentSpanId).toBe(span('rpc default.method').spanId)
	expect(span('call-2').parentSpanId).toBe(span('rpc default.method').spanId)
})

for (const ending of ['caller', 'target']) {
	test(`${ending} termination fences capabilities synchronously and rejects in-flight returned capabilities`, async () => {
		const caller = createInvocationTrace({ name: 'caller' })
		owners.push(caller)
		const gate = Promise.withResolvers<void>()
		let owner: InvocationTrace | undefined
		let invoked = 0
		class Capability {
			[RPC_TARGET_BRAND] = true
			async delayed() {
				await gate.promise
				return () => 'late'
			}
			get value() {
				invoked++
				return true
			}
		}
		const proxy = binding({
			default: {
				method() {
					owner = activeOwner()
					return new Capability()
				},
			},
		}).toProxy()
		const cap = await caller.run(() => call(proxy, 'method'))
		if (!owner) throw new Error('Missing session owner')
		const pending = call(cap, 'delayed')
		const rejection = pending.catch((error: unknown) => error)
		if (ending === 'caller') caller.finishHandler()
		else owner.terminate('generation ended')
		expect(() => property(cap, 'value')).toThrow('session is closed')
		expect(invoked).toBe(0)
		gate.resolve()
		expect(await rejection).toEqual(new Error('RPC session is closed'))
		await owner.completed
		expect(owner.root.isTraced).toBe(false)
		dispose(cap)
	})
}

test('async entrypoint property capabilities are wrapped before the initial session share is finished', async () => {
	let owner: InvocationTrace | undefined
	const proxy = binding({
		default: {
			get delayed() {
				owner = activeOwner()
				return Promise.resolve(() => tracing.getActiveSpan()?.isTraced)
			},
		},
	}).toProxy()
	const fn = await proxy.delayed
	if (!owner) throw new Error('Missing session owner')
	expect(owner.closed).toBe(false)
	expect(await invoke(fn)).toBe(true)
	dispose(fn)
	await owner.completed
})

test('caller completion closes an undisposed idle session without another capability access', async () => {
	const caller = createInvocationTrace({ name: 'caller' })
	owners.push(caller)
	let owner: InvocationTrace | undefined
	const proxy = binding({
		default: {
			method() {
				owner = activeOwner()
				return () => 'alive'
			},
		},
	}).toProxy()
	const fn = await caller.run(() => call(proxy, 'method'))
	if (!owner) throw new Error('Missing session owner')
	expect(owner.closed).toBe(false)
	caller.finishHandler()
	await owner.completed
	expect(owner.root.isTraced).toBe(false)
	await expect(invoke(fn)).rejects.toThrow('session is closed')
	dispose(fn)
})

test('dispatcher-backed fetch, RPC and property reads get one target root each', async () => {
	const module = {
		default: {
			fetch() {
				return new Response(null, { status: 204 })
			},
			method() {
				return true
			},
			get value() {
				return true
			},
		},
	}
	const env = {}
	const dispatcher = new WorkerDispatcher(
		module,
		env,
		props => new ExecutionContext(props),
	)
	try {
		const target = new ServiceBinding('backend')
		target._wire(module, env)
		await target.fetch('http://test/dispatch')
		expect(await call(target.toProxy(), 'method')).toBe(true)
		expect(await target.toProxy().value).toBe(true)
		expect(store.listAllSpans({}).items).toHaveLength(3)
	} finally {
		dispatcher.terminateInvocations('test cleanup')
	}
})

test('assets-only fetch has no script invocation and RPC keeps its explicit rejection', async () => {
	const target = new ServiceBinding('assets')
	target._wire(() => ({ kind: 'assets', env: {}, assets: { fetch: async () => new Response(null, { status: 204 }) } }))
	expect((await target.fetch('http://test/asset')).status).toBe(204)
	await expect(call(target.toProxy(), 'method')).rejects.toThrow('assets-only worker')
	expect(store.listAllSpans({}).items).toHaveLength(0)
})

for (const failure of ['constructor', 'getter']) {
	test(`fetch ${failure} failure retains background work and closes with an error`, async () => {
		const gate = Promise.withResolvers<void>()
		let owner: InvocationTrace | undefined
		class Target {
			constructor(ctx: ExecutionContext) {
				owner = activeOwner()
				ctx.waitUntil(gate.promise)
				if (failure === 'constructor') throw new Error('fetch constructor failed')
			}
			get fetch() {
				throw new Error('fetch getter failed')
			}
		}
		await expect(binding({ default: Target }).fetch('http://test/failure')).rejects.toThrow(`fetch ${failure} failed`)
		if (!owner) throw new Error('Missing fetch owner')
		expect(owner.closed).toBe(false)
		gate.resolve()
		await owner.completed
		expect(span('GET /failure').status).toBe('error')
	})
}

test('a lazy body error closes the target invocation with an error outcome', async () => {
	let owner: InvocationTrace | undefined
	const target = binding({
		default: {
			fetch() {
				owner = activeOwner()
				return new Response(
					new ReadableStream({
						pull(controller) {
							controller.error(new Error('body failed'))
						},
					}, { highWaterMark: 0 }),
				)
			},
		},
	})
	const response = await target.fetch('http://test/body-error')
	if (!owner) throw new Error('Missing fetch owner')
	expect(owner.closed).toBe(false)
	await expect(response.text()).rejects.toThrow('body failed')
	await owner.completed
	expect(span('GET /body-error').status).toBe('error')
})

test('HTTP 500 records failure while background work remains active', async () => {
	const gate = Promise.withResolvers<void>()
	let owner: InvocationTrace | undefined
	const target = binding({
		default: {
			fetch(_request: Request, _env: unknown, ctx: ExecutionContext) {
				owner = activeOwner()
				ctx.waitUntil(gate.promise)
				return new Response(null, { status: 500 })
			},
		},
	})
	expect((await target.fetch('http://test/http-error')).status).toBe(500)
	if (!owner) throw new Error('Missing fetch owner')
	expect(owner.closed).toBe(false)
	gate.resolve()
	await owner.completed
	expect(span('GET /http-error').status).toBe('error')
})
