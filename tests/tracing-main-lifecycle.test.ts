import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { QueueConsumer, SqliteQueueProducer } from '../src/bindings/queue'
import { WorkerDispatcher } from '../src/bindings/worker-dispatcher'
import { SqliteWorkflowBinding, WorkflowEntrypointBase } from '../src/bindings/workflow'
import { runMigrations } from '../src/db'
import { ExecutionContext, runWithExecutionContext } from '../src/execution-context'
import { createTestEnv, type TestEnv } from '../src/testing'
import { runTracingMigrations } from '../src/tracing/db'
import { createInvocationTrace, getActiveInvocation, type InvocationTrace } from '../src/tracing/invocation'
import { type SpanHandle, tracing } from '../src/tracing/span'
import { setTraceStore, TraceStore } from '../src/tracing/store'

let store: TraceStore
let db: Database
let environments: TestEnv[]
let dispatchers: WorkerDispatcher[]
let invocations: InvocationTrace[]

beforeEach(() => {
	db = new Database(':memory:')
	runMigrations(db)
	const traces = new Database(':memory:')
	runTracingMigrations(traces)
	store = new TraceStore(traces)
	setTraceStore(store)
	environments = []
	dispatchers = []
	invocations = []
})

afterEach(() => {
	for (const env of environments) env.dispose()
	for (const dispatcher of dispatchers) dispatcher.terminateInvocations('test cleanup')
	for (const invocation of invocations) invocation.terminate('test cleanup')
	store.close()
	setTraceStore(null)
	db.close()
})

function dispatcher(module: Record<string, unknown>): WorkerDispatcher {
	const result = new WorkerDispatcher(module, {}, props => new ExecutionContext(props))
	dispatchers.push(result)
	return result
}

function invocation(name: string): InvocationTrace {
	const result = createInvocationTrace({ name })
	invocations.push(result)
	return result
}

function span(name: string) {
	const result = store.listAllSpans({}).items.find(row => row.name === name)
	if (!result) throw new Error(`Missing span ${name}`)
	return store.getTrace(result.traceId).spans.find(row => row.spanId === result.spanId)!
}

test('redirect metadata survives testing dispatch and native-branded clones without changing body consumption', async () => {
	const gate = Promise.withResolvers<void>()
	const origin = Bun.serve({
		port: 0,
		fetch(request) {
			if (new URL(request.url).pathname === '/redirect') return Response.redirect(new URL('/final', request.url).href)
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('first'))
					},
					async pull(controller) {
						await gate.promise
						controller.enqueue(new TextEncoder().encode('last'))
						controller.close()
					},
				}),
			)
		},
	})
	try {
		const env = await createTestEnv({ worker: { fetch: () => fetch(new URL('/redirect', origin.url)) } })
		environments.push(env)
		const response = await env.fetch('/redirect-metadata')
		const clone = response.clone()
		const secondClone = clone.clone()
		for (const value of [response, clone, secondClone]) {
			expect(value.url).toBe(new URL('/final', origin.url).href)
			expect(value.redirected).toBe(true)
			expect(value.type).toBe('default')
			expect(value.status).toBe(200)
			expect(value.bodyUsed).toBe(false)
		}
		expect(span('GET /redirect-metadata').endTime).toBeNull()
		const reading = Response.prototype.text.call(response)
		expect(response.bodyUsed).toBe(true)
		expect(() => response.clone()).toThrow()
		gate.resolve()
		expect(await Promise.all([reading, clone.text(), secondClone.text()])).toEqual(['firstlast', 'firstlast', 'firstlast'])
		for (const value of [response, clone, secondClone]) expect(value.bodyUsed).toBe(true)
		expect(span('GET /redirect-metadata').endTime).not.toBeNull()
	} finally {
		gate.resolve()
		await origin.stop(true)
	}
})

test('status-zero error responses pass through unchanged and remain natively cloneable', async () => {
	const original = Response.error()
	const env = await createTestEnv({ worker: { fetch: () => original } })
	environments.push(env)
	const response = await env.fetch('/error-response')
	expect(response).toBe(original)
	const clone = response.clone()
	for (const value of [response, clone]) {
		expect(value.status).toBe(0)
		expect(value.type).toBe('error')
		expect(value.url).toBe('')
		expect(value.redirected).toBe(false)
		expect(value.bodyUsed).toBe(false)
	}
	expect(await response.text()).toBe('')
	expect(await clone.text()).toBe('')
	expect(span('GET /error-response').endTime).not.toBeNull()
})

test('test-env disposal closes completed Workflow engines with live callbacks without closing another environment', async () => {
	const releaseA = Promise.withResolvers<void>()
	const releaseB = Promise.withResolvers<void>()
	const finishedA = Promise.withResolvers<void>()
	const finishedB = Promise.withResolvers<void>()
	function workflow(name: string, release: Promise<void>, finished: () => void) {
		return class extends WorkflowEntrypointBase {
			override async run() {
				const manual = this.ctx.tracing.startSpan(`workflow-manual-${name}`)
				this.ctx.waitUntil(release.then(() => {
					manual.setAttribute('late', true)
					this.ctx.tracing.enterSpan(`workflow-late-${name}`, () => {})
					finished()
				}))
			}
		}
	}
	const a = await createTestEnv({
		worker: { Pending: workflow('A', releaseA.promise, finishedA.resolve) },
		bindings: { A: { type: 'workflow', className: 'Pending' } },
	})
	const b = await createTestEnv({
		worker: { Pending: workflow('B', releaseB.promise, finishedB.resolve) },
		bindings: { B: { type: 'workflow', className: 'Pending' } },
	})
	environments.push(b)
	if (!(a.env.A instanceof SqliteWorkflowBinding) || !(b.env.B instanceof SqliteWorkflowBinding)) throw new Error('Missing workflow binding')
	const first = await a.env.A.create({ id: 'first' })
	const second = await b.env.B.create({ id: 'second' })
	const deadline = Date.now() + 3000
	while ((await first.status()).status !== 'complete' || (await second.status()).status !== 'complete') {
		if (Date.now() > deadline) throw new Error('Workflow engines did not finish')
		await Bun.sleep(1)
	}
	expect(span('workflow A').endTime).toBeNull()
	expect(span('workflow B').endTime).toBeNull()
	a.dispose()
	expect(span('workflow A').statusMessage).toBe('Test environment disposed')
	expect(span('workflow-manual-A').endTime).not.toBeNull()
	expect(span('workflow B').endTime).toBeNull()
	const query = spyOn(a.db, 'query')
	const run = spyOn(a.db, 'run')
	const insert = spyOn(store, 'insertSpan')
	const end = spyOn(store, 'endSpan')
	try {
		releaseA.resolve()
		await finishedA.promise
		await Promise.resolve()
		expect(query).not.toHaveBeenCalled()
		expect(run).not.toHaveBeenCalled()
		expect(insert).not.toHaveBeenCalled()
		expect(end).not.toHaveBeenCalled()
	} finally {
		query.mockRestore()
		run.mockRestore()
		insert.mockRestore()
		end.mockRestore()
	}
	releaseB.resolve()
	await finishedB.promise
	while (span('workflow B').endTime === null) {
		if (Date.now() > deadline) throw new Error('Other workflow tracing did not drain')
		await Bun.sleep(1)
	}
	expect(span('workflow-late-B').endTime).not.toBeNull()
	expect(span('workflow B').status).toBe('ok')
})

test('cloned responses share one body hold and await the single source cancellation cleanup', async () => {
	const cleanup = Promise.withResolvers<void>()
	const cancelling = Promise.withResolvers<void>()
	let cancellations = 0
	let completions = 0
	const unsubscribe = store.subscribe(event => {
		if (event.type === 'span.end' && event.span.name === 'GET /cloned-cancel') completions++
	})
	const target = dispatcher({
		default: {
			fetch() {
				return new Response(
					new ReadableStream<Uint8Array>({
						async cancel() {
							cancellations++
							cancelling.resolve()
							await cleanup.promise
						},
					}, { highWaterMark: 0 }),
				)
			},
		},
	})
	try {
		const response = await target.fetch(new Request('http://test/cloned-cancel'))
		const clone = response.clone()
		const cancelled = Promise.all([response.body!.cancel('first'), clone.body!.cancel('second')])
		await cancelling.promise
		expect(cancellations).toBe(1)
		expect(completions).toBe(0)
		expect(span('GET /cloned-cancel').endTime).toBeNull()
		cleanup.resolve()
		await cancelled
		expect(completions).toBe(1)
		expect(span('GET /cloned-cancel').status).toBe('error')
	} finally {
		cleanup.resolve()
		unsubscribe()
	}
})

test('ExecutionContext captures ownership and drains nested waitUntil registrations', async () => {
	const first = invocation('first')
	const second = invocation('second')
	const ctx = first.run(() => new ExecutionContext())
	const gate = Promise.withResolvers<void>()
	const nested = Promise.withResolvers<void>()
	second.run(() => ctx.waitUntil(gate.promise.then(() => ctx.waitUntil(nested.promise))))
	first.finishHandler()
	second.finishHandler()
	expect(first.closed).toBe(false)
	expect(second.closed).toBe(true)
	let drained = false
	const drain = ctx._awaitAll().then(() => drained = true)
	gate.resolve()
	await Promise.resolve()
	expect(first.closed).toBe(false)
	expect(drained).toBe(false)
	nested.resolve()
	await drain
	expect(first.closed).toBe(true)
})

test('nested target background rejection is logged once and finishes its own invocation with error', async () => {
	const log = spyOn(console, 'error').mockImplementation(() => {})
	try {
		const parent = invocation('caller')
		const ctx = parent.run(() => new ExecutionContext())
		const gate = Promise.withResolvers<void>()
		const target = dispatcher({
			default: {
				fetch(_request: Request, _env: unknown, targetCtx: ExecutionContext) {
					targetCtx.waitUntil(gate.promise)
					return new Response(null, { status: 204 })
				},
			},
		})
		await parent.run(() => runWithExecutionContext(ctx, () => target.fetch(new Request('http://test/target'))))
		parent.finishHandler()
		expect(parent.closed).toBe(false)
		gate.reject(new Error('background failed'))
		await ctx._awaitAll()
		expect(log).toHaveBeenCalledTimes(1)
		expect(span('GET /target').status).toBe('error')
		expect(parent.closed).toBe(true)
	} finally {
		log.mockRestore()
	}
})

test('target response stays lazy and has its own invocation under the caller', async () => {
	const parent = invocation('caller')
	let targetInvocation: InvocationTrace | undefined
	let pulls = 0
	let manual: SpanHandle | undefined
	const target = dispatcher({
		default: {
			fetch() {
				targetInvocation = getActiveInvocation()
				manual = tracing.startSpan('manual')
				return new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							pulls++
							tracing.enterSpan('body-pull', () => {})
							controller.enqueue(new TextEncoder().encode('body'))
							controller.close()
						},
					}, { highWaterMark: 0 }),
				)
			},
		},
	})
	const response = await parent.run(() => target.fetch(new Request('http://test/stream')))
	parent.finishHandler()
	expect(pulls).toBe(0)
	expect(targetInvocation).not.toBe(parent)
	expect(targetInvocation?.closed).toBe(false)
	expect(span('GET /stream').parentSpanId).toBe(span('caller').spanId)
	expect(manual?.isTraced).toBe(true)
	expect(await response.text()).toBe('body')
	expect(targetInvocation?.closed).toBe(true)
	expect(manual?.isTraced).toBe(false)
	expect(span('body-pull').parentSpanId).toBe(span('GET /stream').spanId)
})

test('body cancellation awaits asynchronous source cleanup even with a pending pull', async () => {
	const started = Promise.withResolvers<void>()
	const cleanup = Promise.withResolvers<void>()
	let active: InvocationTrace | undefined
	const target = dispatcher({
		default: {
			fetch() {
				active = getActiveInvocation()
				return new Response(
					new ReadableStream<Uint8Array>({
						pull() {
							started.resolve()
						},
						async cancel() {
							await cleanup.promise
							tracing.enterSpan('cancel-cleanup', () => {})
						},
					}, { highWaterMark: 0 }),
				)
			},
		},
	})
	const response = await target.fetch(new Request('http://test/cancel'))
	const reader = response.body!.getReader()
	const reading = reader.read()
	await started.promise
	const cancellation = reader.cancel('stop')
	await reading
	expect(active?.closed).toBe(false)
	cleanup.resolve()
	await cancellation
	expect(active?.closed).toBe(true)
	expect(span('GET /cancel').status).toBe('error')
	expect(span('cancel-cleanup').parentSpanId).toBe(span('GET /cancel').spanId)
})

test('supplied event context reuses the event invocation and leaves body ownership to its adapter', async () => {
	const event = invocation('event')
	let active: InvocationTrace | undefined
	const target = dispatcher({
		default: {
			fetch() {
				active = getActiveInvocation()
				return new Response(null, { status: 204 })
			},
		},
	})
	await event.run(() => target.fetch(new Request('http://test/'), 'default', undefined, new ExecutionContext()))
	expect(active).toBe(event)
	expect(event.closed).toBe(false)
	expect(store.listAllSpans({}).items).toHaveLength(1)
	event.finishHandler()
})

test('RPC and property construction are actual target invocations, including constructor failures', async () => {
	const parent = invocation('caller')
	class Target {
		constructor(readonly ctx: ExecutionContext) {
			ctx.tracing.enterSpan('construct', () => {})
		}
		method() {
			return this.ctx.tracing.getActiveSpan()?.isTraced
		}
		get value() {
			return this.ctx.tracing.getActiveSpan()?.isTraced
		}
	}
	class Broken {
		constructor() {
			throw new Error('constructor failed')
		}
	}
	const target = dispatcher({ Target, Broken })
	expect(await parent.run(() => target.rpc('Target', 'method', []))).toBe(true)
	expect(await parent.run(() => target.property('Target', 'value'))).toBe(true)
	await expect(parent.run(() => target.rpc('Broken', 'method', []))).rejects.toThrow('constructor failed')
	expect(span('rpc Target.method').parentSpanId).toBe(span('caller').spanId)
	expect(span('rpc Target.value').endTime).not.toBeNull()
	expect(span('rpc Broken.method').status).toBe('error')
})

test('queue consumer retains its root for background work and still acknowledges after drain', async () => {
	const gate = Promise.withResolvers<void>()
	const started = Promise.withResolvers<void>()
	let active: InvocationTrace | undefined
	const consumer = new QueueConsumer(
		db,
		{ queue: 'jobs', maxBatchSize: 10, maxBatchTimeout: 0, maxRetries: 3, deadLetterQueue: null },
		async (_batch, _env, ctx) => {
			active = getActiveInvocation()
			ctx.waitUntil(gate.promise.then(() => {
				tracing.startSpan('queue-background')
			}))
			started.resolve()
		},
		{},
	)
	await new SqliteQueueProducer(db, 'jobs').send({ work: true })
	const delivery = consumer.poll()
	await started.promise
	expect(active?.closed).toBe(false)
	gate.resolve()
	await delivery
	expect(active?.closed).toBe(true)
	expect(span('queue-background').endTime).not.toBeNull()
	expect(db.query<{ status: string }, []>('SELECT status FROM queue_messages').get()?.status).toBe('acked')
})

test('queue deserialization failure finalizes the event before user code runs', async () => {
	await new SqliteQueueProducer(db, 'broken').send({ valid: true })
	db.run('UPDATE queue_messages SET body = ?', [new TextEncoder().encode('{')])
	let called = false
	const consumer = new QueueConsumer(db, { queue: 'broken', maxBatchSize: 10, maxBatchTimeout: 0, maxRetries: 3, deadLetterQueue: null }, async () => {
		called = true
	}, {})
	await expect(consumer.poll()).rejects.toThrow()
	expect(called).toBe(false)
	expect(span('queue broken').status).toBe('error')
	expect(span('queue broken').endTime).not.toBeNull()
})

test('testing constructor failures drain already registered background work and finalize manual spans', async () => {
	const gate = Promise.withResolvers<void>()
	const started = Promise.withResolvers<void>()
	class Broken {
		constructor(ctx: unknown) {
			if (!(ctx instanceof ExecutionContext)) throw new Error('Missing context')
			ctx.waitUntil(gate.promise)
			ctx.tracing.startSpan('constructor-manual')
			started.resolve()
			throw new Error('constructor failed')
		}
		fetch() {
			return new Response(null, { status: 204 })
		}
	}
	const env = await createTestEnv({ worker: { default: Broken } })
	environments.push(env)
	const response = env.fetch('/constructor')
	await started.promise
	expect(span('GET /constructor').endTime).toBeNull()
	gate.resolve()
	await expect(response).rejects.toThrow('constructor failed')
	expect(span('GET /constructor').status).toBe('error')
	expect(span('constructor-manual').endTime).not.toBeNull()
})

test('in-process body errors release their hold with an error outcome', async () => {
	const target = dispatcher({
		default: {
			fetch() {
				return new Response(
					new ReadableStream({
						pull(controller) {
							controller.error(new Error('source failed'))
						},
					}, { highWaterMark: 0 }),
				)
			},
		},
	})
	const response = await target.fetch(new Request('http://test/body-error'))
	await expect(response.text()).rejects.toThrow('source failed')
	expect(span('GET /body-error').status).toBe('error')
	expect(span('GET /body-error').endTime).not.toBeNull()
})

test('testing dispatches all event types inside invocations and disposal closes unread bodies', async () => {
	const seen: string[] = []
	const event = (name: string) => {
		if (!tracing.getActiveSpan()?.isTraced) throw new Error(`Missing invocation for ${name}`)
		seen.push(name)
		tracing.startSpan(`${name}-manual`)
	}
	const env = await createTestEnv({
		worker: {
			fetch() {
				event('fetch')
				return new Response('unread')
			},
			queue() {
				event('queue')
			},
			scheduled() {
				event('scheduled')
			},
			email() {
				event('email')
			},
		},
	})
	await env.queue('jobs', [{ body: 1 }])
	await env.scheduled()
	await env.email({ from: 'a@example.com', to: 'b@example.com', raw: 'Subject: Test\r\n\r\nHello' })
	const response = await env.fetch('/unread')
	expect(span('GET /unread').endTime).toBeNull()
	expect(span('queue-manual').endTime).not.toBeNull()
	env.dispose()
	expect(span('GET /unread').endTime).not.toBeNull()
	expect(span('fetch-manual').endTime).not.toBeNull()
	expect(seen).toEqual(['queue', 'scheduled', 'email', 'fetch'])
	await response.body?.cancel()
})
