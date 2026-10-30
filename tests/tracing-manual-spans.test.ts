import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { runWithParentContext } from '../src/tracing/context'
import { runTracingMigrations } from '../src/tracing/db'
import { setSpanAttribute, type SpanHandle, startSpan, startSyncSpan, tracing } from '../src/tracing/span'
import { setTraceStore, setTraceStoreOverride, TraceStore } from '../src/tracing/store'
import type { WorkerMessage } from '../src/worker-thread/protocol'
import { RemoteTraceStore } from '../src/worker-thread/remote-trace-store'

let db: Database
let store: TraceStore

function request<T>(callback: () => T): T {
	return startSyncSpan({ name: 'request', kind: 'server' }, callback)
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
})

afterEach(() => {
	setTraceStoreOverride(null)
	store.close()
	setTraceStore(null)
})

describe('public spans', () => {
	test('outside any active span public spans start their own traces', () => {
		expect(tracing.getActiveSpan()).toBeUndefined()
		const orphan = tracing.startSpan('orphan')
		expect(orphan.isTraced).toBe(true)
		expect(tracing.enterSpan('auto', (handle, n: number) => {
			expect(tracing.getActiveSpan()).toBe(handle)
			return n * 2
		}, 21)).toBe(42)
		orphan.end()
		expect(span('orphan').parentSpanId).toBeNull()
		expect(span('auto').parentSpanId).toBeNull()
		expect(span('auto').traceId).not.toBe(span('orphan').traceId)
	})

	test('manual spans are siblings and captured handles annotate their original span without ALS', () => {
		const handle = request(() => {
			const root = tracing.getActiveSpan()
			const manual = tracing.startSpan('manual')
			expect(tracing.getActiveSpan()).toBe(root)
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
		expect(span('manual').parentSpanId).toBe(span('request').spanId)
		expect(span('sibling').parentSpanId).toBe(span('request').spanId)
		expect(store.getTrace(span('manual').traceId).events).toMatchObject([
			{ spanId: span('manual').spanId, name: 'exception', attributes: { code: 500, name: 'Upstream', message: 'retry', stack: 'at upstream' } },
		])
	})

	test('active callback scope propagates across awaits but restores its caller', async () => {
		const gate = Promise.withResolvers<void>()
		let root: SpanHandle | undefined
		const pending = request(() => {
			root = tracing.getActiveSpan()
			const result = tracing.startActiveSpan('active', async (handle, value: number) => {
				expect(tracing.getActiveSpan()).toBe(handle)
				await gate.promise
				expect(tracing.getActiveSpan()).toBe(handle)
				tracing.enterSpan('nested', () => {})
				return { handle, value }
			}, 7)
			expect(tracing.getActiveSpan()).toBe(root)
			tracing.enterSpan('outside', () => {})
			return result
		})
		gate.resolve()
		const { handle, value } = await pending
		expect(value).toBe(7)
		expect(span('active').endTime).toBeNull()
		expect(span('nested').parentSpanId).toBe(span('active').spanId)
		expect(span('outside').parentSpanId).toBe(span('request').spanId)
		handle.end()
		expect(span('active').endTime).not.toBeNull()
	})

	test('manual active spans survive callback throws and rejections', async () => {
		let captured: SpanHandle | undefined
		expect(() =>
			tracing.startActiveSpan('throw', handle => {
				captured = handle
				throw new Error('sync')
			})
		).toThrow('sync')
		expect(captured?.isTraced).toBe(true)
		captured?.end()
		expect(captured?.isTraced).toBe(false)
		await expect(tracing.startActiveSpan('reject', async handle => {
			captured = handle
			throw new Error('async')
		})).rejects.toThrow('async')
		expect(captured?.isTraced).toBe(true)
		expect(span('reject').endTime).toBeNull()
		captured?.end()
	})

	test('auto spans forward arguments and explicit early end suppresses subsequent writes', async () => {
		await tracing.enterSpan(
			'early',
			async (handle, value: number, label: string) => {
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
		expect(span('early').attributes).toEqual({ before: true })
		expect(store.getTrace(span('early').traceId).events).toHaveLength(0)
	})

	test('runtime-owned handles cannot be ended publicly', async () => {
		let platform: SpanHandle | undefined
		await startSpan({ name: 'platform' }, async () => {
			platform = tracing.getActiveSpan()
			platform?.end()
			expect(platform?.isTraced).toBe(true)
			platform?.setAttribute('platform', true)
			await Promise.resolve()
		})
		expect(platform?.isTraced).toBe(false)
		platform?.setAttribute('late', true)
		expect(span('platform').attributes).toEqual({ platform: true })
	})

	test('a parent adopted across a thread boundary is annotated in place and parents new spans', () => {
		const messages: WorkerMessage[] = []
		setTraceStoreOverride(new RemoteTraceStore(message => messages.push(message)))
		runWithParentContext({ traceId: 'remote-trace', spanId: 'remote-span' }, () => {
			const remote = tracing.getActiveSpan()
			remote?.setAttribute('owner', 'thread').end()
			expect(remote?.isTraced).toBe(true)
			tracing.enterSpan('local', () => {})
		})
		expect(messages).toContainEqual({ type: 'trace-span-attrs', spanId: 'remote-span', attrs: { owner: 'thread' } })
		expect(messages.some(message => message.type === 'trace-span-end' && message.spanId === 'remote-span')).toBe(false)
		const local = messages.find(message => message.type === 'trace-span-insert' && message.span.name === 'local')
		if (local?.type !== 'trace-span-insert') throw new Error('Missing local span')
		expect(local.span.traceId).toBe('remote-trace')
		expect(local.span.parentSpanId).toBe('remote-span')
	})

	test('public names truncate at a complete UTF-8 character, internal names remain intact', () => {
		tracing.startSpan(`${'a'.repeat(63)}é`).end()
		tracing.startSpan('🙂'.repeat(17)).end()
		startSyncSpan({ name: 'i'.repeat(80) }, () => {})
		expect(rows().map(row => row.name)).toEqual(expect.arrayContaining(['a'.repeat(63), '🙂'.repeat(16), 'i'.repeat(80)]))
	})

	test('exception inputs accept Error and strings, ignore empty objects, and validate fields', () => {
		const handle = tracing.startSpan('exceptions')
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
		const handle = tracing.startSpan('budget')
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
		const overwrite = tracing.startSpan('overwrite')
		overwrite.setAttribute('x', 'a'.repeat(32767))
		overwrite.setAttribute('x', 'b'.repeat(32767))
		expect(span('overwrite').attributes.x).toBe('b'.repeat(32767))
		overwrite.setAttribute('x', 'c')
		expect(span('overwrite').attributes.x).toBe('b'.repeat(32767))
		expect(span('overwrite').attributes['cloudflare.warning.type']).toBe('span_data_limit_exceeded')
	})

	test('exceptions share the annotation budget and internal diagnostics bypass it', () => {
		const handle = tracing.startSpan('exception-budget')
		handle.setAttribute('pad', 'x'.repeat(65536 - 3 - 10))
		handle.recordException({ code: 1, name: 'é' })
		handle.recordException('over')
		expect(store.getTrace(span('exception-budget').traceId).events).toHaveLength(1)
		expect(span('exception-budget').attributes['cloudflare.warning.type']).toBe('span_data_limit_exceeded')
		startSyncSpan({ name: 'diagnostics' }, () => setSpanAttribute('large', 'x'.repeat(70000)))
		expect(span('diagnostics').attributes.large).toBe('x'.repeat(70000))
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
		const root = tracing.startSpan('request')
		const traceId = span('request').traceId
		const start = Date.now() - 11 * 60 * 1000
		db.prepare(`INSERT INTO spans (span_id, trace_id, name, kind, status, start_time, attributes)
			VALUES (?, ?, ?, ?, ?, ?, ?)`)
			.run('uncached', traceId, 'old stream', 'internal', 'unset', start, '{}')
		let ends = 0
		store.subscribe(event => {
			if (event.type === 'span.end' && event.span.spanId === 'uncached') ends++
		})
		store.endSpan('uncached', start + 12 * 60 * 1000, 'ok')
		store.endSpan('uncached', start + 13 * 60 * 1000, 'error')
		expect(span('old stream').durationMs).toBe(12 * 60 * 1000)
		expect(span('old stream').status).toBe('ok')
		expect(ends).toBe(1)
		root.end()
	})

	test('a span older than ten minutes stays endable', () => {
		const now = spyOn(Date, 'now')
		const oldDb = new Database(':memory:')
		runTracingMigrations(oldDb)
		const oldStore = new TraceStore(oldDb)
		try {
			setTraceStoreOverride(oldStore)
			now.mockReturnValue(1000)
			const parent = tracing.startSpan('long-request')
			const child = tracing.startSpan('long-child')
			now.mockReturnValue(1000 + 11 * 60 * 1000)
			child.end()
			parent.end()
			const ended = oldStore.listAllSpans({}).items
			expect(ended).toHaveLength(2)
			for (const row of ended) {
				expect(row.durationMs).toBe(11 * 60 * 1000)
				expect(row.status).toBe('ok')
			}
		} finally {
			now.mockRestore()
			setTraceStoreOverride(null)
			oldStore.close()
		}
	})
})
