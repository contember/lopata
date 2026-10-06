import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { getActiveContext, runWithContext, runWithParentContext } from '../src/tracing/context'
import { runTracingMigrations } from '../src/tracing/db'
import { createInvocationTrace, getActiveInvocation, type InvocationTrace } from '../src/tracing/invocation'
import { addSpanEvent, setSpanAttribute, setSpanStatus, type SpanHandle, startSpan, startSyncSpan, tracing } from '../src/tracing/span'
import { setTraceStore, setTraceStoreOverride, TraceStore } from '../src/tracing/store'
import type { WorkerMessage } from '../src/worker-thread/protocol'
import { RemoteTraceStore } from '../src/worker-thread/remote-trace-store'

let db: Database
let store: TraceStore
let invocations: InvocationTrace[]

function invocation(name = 'request'): InvocationTrace {
	const scope = createInvocationTrace({ name, kind: 'server' })
	invocations.push(scope)
	return scope
}

function rows() {
	return store.listAllSpans({}).items
}

function span(name: string) {
	const row = rows().find(item => item.name === name)
	if (!row) throw new Error(`Missing span ${name}`)
	const result = store.getTrace(row.traceId).spans.find(item => item.spanId === row.spanId)
	if (!result) throw new Error(`Missing span data ${name}`)
	return result
}

beforeEach(() => {
	db = new Database(':memory:')
	runTracingMigrations(db)
	store = new TraceStore(db)
	setTraceStore(store)
	invocations = []
})

afterEach(() => {
	for (const scope of invocations) scope.terminate('test cleanup')
	setTraceStoreOverride(null)
	store.close()
	setTraceStore(null)
})

describe('captured public spans', () => {
	test('outside an invocation public creation is a no-op, including within internal diagnostic spans', async () => {
		const handle = tracing.startSpan('orphan')
		expect(handle.isTraced).toBe(false)
		expect(tracing.getActiveSpan()).toBeUndefined()
		expect(tracing.enterSpan('noop', (value, n) => {
			value.setAttribute('ignored', true).setAttributes({ ignored: true })
			value.recordException('ignored')
			value.end()
			return n * 2
		}, 21)).toBe(42)
		expect(tracing.startActiveSpan('noop-active', value => value.isTraced)).toBe(false)
		expect(rows()).toHaveLength(0)
		await startSpan({ name: 'diagnostic' }, () => {
			expect(tracing.getActiveSpan()).toBeUndefined()
			expect(tracing.startSpan('orphan-child').isTraced).toBe(false)
		})
		expect(rows().map(row => row.name)).toEqual(['diagnostic'])
	})

	test('manual spans are siblings and captured handles annotate their original span without ALS', () => {
		const scope = invocation()
		const handle = scope.run(() => {
			expect(tracing.getActiveSpan()).toBe(scope.root)
			const manual = tracing.startSpan('manual')
			expect(tracing.getActiveSpan()).toBe(scope.root)
			tracing.enterSpan('sibling', () => {})
			return manual
		})
		handle.setAttributes({ phase: 'after callback', optional: undefined }).setAttribute('count', 2)
		handle.recordException({ code: 500, name: 'Upstream', message: 'retry', stack: 'at upstream' })
		handle.end()
		const firstEnd = span('manual').endTime
		handle.end()
		handle.setAttribute('late', true)
		handle.recordException('late')
		expect(handle.isTraced).toBe(false)
		expect(span('manual').attributes).toEqual({ phase: 'after callback', count: 2 })
		expect(span('manual').status).toBe('ok')
		expect(span('manual').endTime).toBe(firstEnd)
		expect(span('manual').parentSpanId).toBe(span('sibling').parentSpanId)
		expect(store.getTrace(span('manual').traceId).events).toMatchObject([
			{ spanId: span('manual').spanId, name: 'exception', attributes: { code: 500, name: 'Upstream', message: 'retry', stack: 'at upstream' } },
		])
	})

	test('active callback scope propagates across awaits but restores its caller', async () => {
		const scope = invocation()
		const gate = Promise.withResolvers<void>()
		const pending = scope.run(() =>
			tracing.startActiveSpan('active', async (handle, value) => {
				expect(tracing.getActiveSpan()).toBe(handle)
				await gate.promise
				expect(tracing.getActiveSpan()).toBe(handle)
				tracing.enterSpan('nested', () => {})
				return { handle, value }
			}, 7)
		)
		scope.run(() => {
			expect(tracing.getActiveSpan()).toBe(scope.root)
			tracing.enterSpan('outside', () => {})
		})
		gate.resolve()
		const { handle, value } = await pending
		expect(value).toBe(7)
		expect(span('active').endTime).toBeNull()
		expect(span('nested').parentSpanId).toBe(span('active').spanId)
		expect(span('outside').parentSpanId).toBe(span('request').spanId)
		handle.end()
	})

	test('manual active spans survive callback throws and rejections', async () => {
		const scope = invocation()
		let captured: SpanHandle | undefined
		expect(() =>
			scope.run(() =>
				tracing.startActiveSpan('throw', handle => {
					captured = handle
					throw new Error('sync')
				})
			)
		).toThrow('sync')
		expect(captured?.isTraced).toBe(true)
		captured?.end()
		await expect(scope.run(() =>
			tracing.startActiveSpan('reject', async handle => {
				captured = handle
				throw new Error('async')
			})
		)).rejects.toThrow('async')
		expect(captured?.isTraced).toBe(true)
		expect(span('reject').endTime).toBeNull()
		scope.finishHandler()
		expect(captured?.isTraced).toBe(false)
	})

	test('auto spans forward arguments and explicit early end suppresses subsequent writes', async () => {
		const scope = invocation()
		await scope.run(() =>
			tracing.enterSpan(
				'early',
				async (handle, value, label) => {
					expect(value).toBe(3)
					expect(label).toBe('label')
					handle.setAttribute('before', true).end()
					await Promise.resolve()
					expect(tracing.getActiveSpan()).toBe(handle)
					expect(handle.isTraced).toBe(false)
					handle.setAttributes({ after: true })
					handle.recordException('after')
				},
				3,
				'label',
			)
		)
		expect(span('early').attributes).toEqual({ before: true })
		expect(store.getTrace(span('early').traceId).events).toHaveLength(0)
	})

	test('root and internal platform handles cannot be ended publicly', async () => {
		const scope = invocation()
		let platform: SpanHandle | undefined
		await scope.run(() =>
			startSpan({ name: 'platform' }, async () => {
				platform = tracing.getActiveSpan()
				platform?.end()
				expect(platform?.isTraced).toBe(true)
				platform?.setAttribute('platform', true)
				await Promise.resolve()
			})
		)
		expect(platform?.isTraced).toBe(false)
		platform?.setAttribute('late', true)
		scope.root.end()
		expect(scope.root.isTraced).toBe(true)
		scope.root.setAttribute('root', true)
		scope.finishHandler()
		expect(scope.root.isTraced).toBe(false)
		expect(span('platform').attributes).toEqual({ platform: true })
		expect(span('request').attributes).toEqual({ root: true })
	})

	test('handles and internal writes retain their writer when another invocation or override is active', () => {
		const messagesA: WorkerMessage[] = []
		const messagesB: WorkerMessage[] = []
		setTraceStoreOverride(new RemoteTraceStore(message => messagesA.push(message)))
		const first = invocation('first')
		const handle = first.run(() => tracing.startSpan('captured'))
		setTraceStoreOverride(new RemoteTraceStore(message => messagesB.push(message)))
		const second = invocation('second')
		second.run(() =>
			tracing.enterSpan('other', () => {
				handle.setAttribute('owner', 'first')
				handle.recordException('first error')
				handle.end()
			})
		)
		first.run(() =>
			startSyncSpan({ name: 'internal-first' }, () => {
				setSpanAttribute('internal', true)
				setSpanStatus('error', 'internal error')
				addSpanEvent('log', 'info', 'first log')
			})
		)
		first.finishHandler()
		second.finishHandler()
		const captured = messagesA.find(message => message.type === 'trace-span-insert' && message.span.name === 'captured')
		if (captured?.type !== 'trace-span-insert') throw new Error('Missing remote span')
		expect(messagesA.filter(message => message.type === 'trace-span-attrs')).toHaveLength(2)
		expect(messagesA).toContainEqual({ type: 'trace-span-attrs', spanId: captured.span.spanId, attrs: { owner: 'first' } })
		expect(messagesB.filter(message => message.type === 'trace-span-attrs' || message.type === 'trace-span-event')).toHaveLength(0)
		expect(rows()).toHaveLength(0)
	})

	test('public names truncate at a complete UTF-8 character, internal names remain intact', () => {
		const scope = invocation()
		scope.run(() => {
			tracing.startSpan(`${'a'.repeat(63)}é`).end()
			tracing.startSpan('🙂'.repeat(17)).end()
			startSyncSpan({ name: 'i'.repeat(80) }, () => {})
		})
		expect(rows().map(row => row.name)).toEqual(expect.arrayContaining(['a'.repeat(63), '🙂'.repeat(16), 'i'.repeat(80)]))
	})

	test('exception inputs accept Error and strings, ignore empty objects, and validate fields', () => {
		const scope = invocation()
		const handle = scope.run(() => tracing.startSpan('exceptions'))
		handle.recordException(new Error('native'))
		handle.recordException('text')
		Reflect.apply(handle.recordException, handle, [{}])
		Reflect.apply(handle.recordException, handle, [42])
		expect(() => Reflect.apply(handle.recordException, handle, [{ code: true }])).toThrow(TypeError)
		expect(() => Reflect.apply(handle.recordException, handle, [{ message: 42 }])).toThrow(TypeError)
		expect(() => Reflect.apply(handle.setAttribute, handle, ['bad', {}])).toThrow(TypeError)
		expect(store.getTrace(span('exceptions').traceId).events.map(event => event.message)).toEqual(['native', 'text'])
		expect(span('exceptions').status).toBe('unset')
	})

	test('annotation budget counts cumulative overwrites, UTF-8 keys, and eight-byte booleans', () => {
		const scope = invocation()
		const handle = scope.run(() => tracing.startSpan('budget'))
		handle.setAttribute('pad', 'x'.repeat(65536 - 3 - 18))
		handle.setAttribute('é', true)
		handle.setAttribute('n', 1)
		const attrs = span('budget').attributes
		expect(attrs.é).toBe(true)
		expect(attrs.n).toBeUndefined()
		expect(attrs['cloudflare.warning.type']).toBe('span_data_limit_exceeded')
		expect(attrs['cloudflare.warning.message']).toContain('attribute "n" of size 8')
		handle.setAttribute('later', true)
		handle.recordException('ignored')
		expect(span('budget').attributes.later).toBeUndefined()
		expect(store.getTrace(span('budget').traceId).events).toHaveLength(0)
		const overwrite = scope.run(() => tracing.startSpan('overwrite'))
		overwrite.setAttribute('x', 'a'.repeat(32767))
		overwrite.setAttribute('x', 'b'.repeat(32767))
		expect(span('overwrite').attributes.x).toBe('b'.repeat(32767))
		overwrite.setAttribute('x', 'c')
		expect(span('overwrite').attributes.x).toBe('b'.repeat(32767))
		expect(span('overwrite').attributes['cloudflare.warning.type']).toBe('span_data_limit_exceeded')
	})

	test('exceptions share the annotation budget and internal diagnostics bypass it', () => {
		const scope = invocation()
		const handle = scope.run(() => tracing.startSpan('exception-budget'))
		handle.setAttribute('pad', 'x'.repeat(65536 - 3 - 10))
		handle.recordException({ code: 1, name: 'é' })
		handle.recordException('over')
		expect(store.getTrace(span('exception-budget').traceId).events).toHaveLength(1)
		expect(span('exception-budget').attributes['cloudflare.warning.type']).toBe('span_data_limit_exceeded')
		scope.run(() => startSyncSpan({ name: 'diagnostics' }, () => setSpanAttribute('large', 'x'.repeat(70000))))
		expect(span('diagnostics').attributes.large).toBe('x'.repeat(70000))
	})
})

describe('explicit invocation lifetime primitive', () => {
	test('new internal operations in a terminated scope execute callbacks without creating dangling spans', async () => {
		const scope = invocation()
		scope.terminate('stopped')
		let calls = 0
		expect(() =>
			scope.run(() =>
				startSyncSpan({ name: 'late-sync' }, () => {
					calls++
					throw new Error('sync failure')
				})
			)
		).toThrow('sync failure')
		await expect(scope.run(() =>
			startSpan({ name: 'late-async' }, async () => {
				calls++
				throw new Error('async failure')
			})
		)).rejects.toThrow('async failure')
		expect(scope.run(() => startSyncSpan({ name: 'late-value' }, () => 42))).toBe(42)
		expect(calls).toBe(2)
		expect(rows().map(row => row.name)).toEqual(['request'])
	})
	test('forced completion closes an in-flight internal span and late continuation writes stay inert', async () => {
		const scope = invocation()
		const gate = Promise.withResolvers<void>()
		const pending = scope.run(() =>
			startSpan({ name: 'in-flight' }, async () => {
				await gate.promise
				setSpanAttribute('late', true)
				setSpanStatus('ok')
				addSpanEvent('late', 'info', 'late log')
				expect(tracing.startSpan('late-public').isTraced).toBe(false)
				throw new Error('late rejection')
			})
		)
		scope.terminate('stopped')
		const endTime = span('in-flight').endTime
		gate.resolve()
		await expect(pending).rejects.toThrow('late rejection')
		expect(span('in-flight').endTime).toBe(endTime)
		expect(span('in-flight').statusMessage).toBe('stopped')
		expect(span('in-flight').attributes).toEqual({})
		expect(store.getTrace(span('request').traceId).events).toHaveLength(0)
		expect(rows()).toHaveLength(2)
	})

	test('internal callback APIs preserve return values, HTTP failure detection and trace refs', async () => {
		const scope = invocation()
		const response = await scope.run(() =>
			startSpan({ name: 'http' }, () => {
				const parent = getActiveContext()
				if (!parent) throw new Error('Missing parent')
				parent.subrequests.count = 3
				const marker = new Error('fetch stack')
				parent.fetchStack.current = marker
				expect(startSyncSpan({ name: 'sync' }, () => {
					expect(getActiveContext()?.subrequests.count).toBe(3)
					expect(getActiveContext()?.fetchStack.current).toBe(marker)
					return 42
				})).toBe(42)
				startSyncSpan({ name: 'fresh', newTrace: true }, () => {
					expect(getActiveInvocation()).toBeUndefined()
					expect(getActiveContext()?.subrequests.count).toBe(0)
				})
				return new Response('unavailable', { status: 503 })
			})
		)
		expect(response.status).toBe(503)
		expect(span('http').status).toBe('error')
		expect(span('http').statusMessage).toBe('HTTP 503')
		expect(span('fresh').parentSpanId).toBeNull()
		expect(span('sync').parentSpanId).toBe(span('http').spanId)
	})

	test('handler, response body and nested waitUntil holds jointly own completion', async () => {
		const scope = invocation()
		const body = scope.retain('response-body')
		const background = scope.retain('wait-until')
		const handle = scope.run(() => tracing.startSpan('forgotten'))
		scope.finishHandler()
		scope.finishHandler({ kind: 'error', error: new Error('duplicate ignored') })
		expect(scope.closed).toBe(false)
		body()
		body()
		const nested = scope.retain('wait-until')
		background()
		expect(scope.closed).toBe(false)
		handle.setAttribute('background', true)
		nested()
		await scope.completed
		expect(scope.closed).toBe(true)
		expect(handle.isTraced).toBe(false)
		expect(span('forgotten').endTime).not.toBeNull()
		expect(span('request').status).toBe('ok')
		expect(scope.run(() => getActiveInvocation())).toBeUndefined()
		expect(scope.run(() => tracing.getActiveSpan())).toBeUndefined()
		expect(scope.run(() => tracing.startSpan('too-late').isTraced)).toBe(false)
		expect(rows()).toHaveLength(2)
	})

	test('failure remains recorded while other holds drain and termination is owner-local', async () => {
		const first = invocation('first')
		const body = first.retain('response-body')
		const background = first.retain('wait-until')
		first.run(() => tracing.startSpan('first-child'))
		first.finishHandler()
		body({ kind: 'error', error: new Error('stream failed') })
		expect(first.closed).toBe(false)
		background()
		await first.completed
		expect(span('first').statusMessage).toBe('stream failed')
		expect(span('first-child').status).toBe('error')
		const second = invocation('second')
		const third = second.run(() => invocation('third'))
		const secondChild = second.run(() => tracing.startSpan('second-child'))
		const thirdChild = third.run(() => tracing.startSpan('third-child'))
		second.terminate('generation stopped')
		expect(secondChild.isTraced).toBe(false)
		expect(thirdChild.isTraced).toBe(true)
		expect(third.closed).toBe(false)
		expect(span('second').statusMessage).toBe('generation stopped')
		third.finishHandler()
	})

	test('cancellation keeps background work live and finishes with its outcome', () => {
		const scope = invocation()
		const release = scope.retain('wait-until')
		scope.finishHandler({ kind: 'cancelled', reason: 'client disconnected' })
		expect(scope.root.isTraced).toBe(true)
		release()
		expect(span('request').status).toBe('error')
		expect(span('request').statusMessage).toBe('client disconnected')
	})

	test('remote adoption establishes a local root and explicit roots do not inherit another lifetime', () => {
		const scope = runWithParentContext({ traceId: 'remote-trace', spanId: 'remote-span' }, () => invocation('local-root'))
		expect(span('local-root').traceId).toBe('remote-trace')
		expect(span('local-root').parentSpanId).toBe('remote-span')
		scope.run(() => {
			const context = getActiveContext()
			if (!context) throw new Error('Missing scope')
			runWithContext({ ...context, span: undefined }, () => expect(tracing.getActiveSpan()).toBe(scope.root))
			const independent = createInvocationTrace({ name: 'independent', newTrace: true })
			invocations.push(independent)
			expect(span('independent').parentSpanId).toBeNull()
			expect(span('independent').traceId).not.toBe('remote-trace')
			independent.finishHandler()
		})
		expect(scope.closed).toBe(false)
	})
})

describe('long-lived trace storage', () => {
	test('shutdown bookkeeping follows retained rows after trace pruning, not all historical inserts', () => {
		const retainedDb = new Database(':memory:')
		runTracingMigrations(retainedDb)
		const retainedStore = new TraceStore(retainedDb)
		for (let i = 0; i < 10100; i++) {
			retainedStore.insertSpan({
				spanId: `span-${i}`,
				traceId: `trace-${i}`,
				parentSpanId: null,
				name: 'unfinished',
				kind: 'server',
				status: 'unset',
				statusMessage: null,
				startTime: i,
				endTime: null,
				durationMs: null,
				attributes: {},
				workerName: null,
			})
		}
		const remaining = retainedDb.query<{ count: number }, []>('SELECT count(*) AS count FROM spans').get()!.count
		expect(remaining).toBeLessThan(10100)
		const ended = spyOn(retainedStore, 'endSpan')
		retainedStore.close()
		expect(ended).toHaveBeenCalledTimes(remaining)
		ended.mockRestore()
		setTraceStore(store)
	})
	test('ending an uncached old row recovers start time and broadcasts completion only once', () => {
		const scope = invocation()
		const root = span('request')
		const start = Date.now() - 11 * 60 * 1000
		db.prepare(`INSERT INTO spans (span_id, trace_id, name, kind, status, start_time, attributes)
			VALUES (?, ?, ?, ?, ?, ?, ?)`)
			.run('uncached', root.traceId, 'old stream', 'internal', 'unset', start, '{}')
		let ends = 0
		store.subscribe(event => {
			if (event.type === 'span.end' && event.span.spanId === 'uncached') ends++
		})
		store.endSpan('uncached', start + 12 * 60 * 1000, 'ok')
		store.endSpan('uncached', start + 13 * 60 * 1000, 'error')
		expect(span('old stream').durationMs).toBe(12 * 60 * 1000)
		expect(span('old stream').status).toBe('ok')
		expect(ends).toBe(1)
		scope.finishHandler()
	})

	test('an invocation older than ten minutes stays endable after periodic cleanup', () => {
		const now = spyOn(Date, 'now')
		const intervals = spyOn(globalThis, 'setInterval')
		const oldDb = new Database(':memory:')
		runTracingMigrations(oldDb)
		const oldStore = new TraceStore(oldDb)
		try {
			setTraceStoreOverride(oldStore)
			now.mockReturnValue(1000)
			const scope = invocation('long-request')
			const child = scope.run(() => tracing.startSpan('long-child'))
			now.mockReturnValue(1000 + 11 * 60 * 1000)
			for (const [callback] of intervals.mock.calls) {
				if (typeof callback === 'function') callback()
			}
			child.end()
			scope.finishHandler()
			const ended = oldStore.listAllSpans({}).items
			expect(ended).toHaveLength(2)
			for (const row of ended) {
				expect(row.durationMs).toBe(11 * 60 * 1000)
				expect(row.status).toBe('ok')
			}
		} finally {
			now.mockRestore()
			intervals.mockRestore()
			setTraceStoreOverride(null)
			oldStore.close()
		}
	})
})
