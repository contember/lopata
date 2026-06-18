import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { runTracingMigrations } from '../src/tracing/db'
import { safeStringify, TraceStore } from '../src/tracing/store'
import type { SpanData, SpanEventData } from '../src/tracing/types'
import type { WorkerMessage } from '../src/worker-thread/protocol'
import { RemoteTraceStore } from '../src/worker-thread/remote-trace-store'

function makeStore(): TraceStore {
	const db = new Database(':memory:')
	runTracingMigrations(db)
	return new TraceStore(db)
}

function span(over: Partial<SpanData> = {}): SpanData {
	return {
		spanId: 's1',
		traceId: 't1',
		parentSpanId: null,
		name: 'test',
		kind: 'internal',
		status: 'unset',
		statusMessage: null,
		startTime: Date.now(),
		endTime: null,
		durationMs: null,
		attributes: {},
		workerName: null,
		...over,
	}
}

function event(over: Partial<Omit<SpanEventData, 'id'>> = {}): Omit<SpanEventData, 'id'> {
	return {
		spanId: 's1',
		traceId: 't1',
		timestamp: Date.now(),
		name: 'log',
		level: 'info',
		message: 'hi',
		attributes: {},
		...over,
	}
}

describe('safeStringify', () => {
	test('coerces BigInt instead of throwing', () => {
		expect(safeStringify({ a: 1n })).toBe('{"a":"1"}')
	})

	test('breaks circular references instead of throwing', () => {
		const o: Record<string, unknown> = { name: 'x' }
		o.self = o
		expect(() => safeStringify(o)).not.toThrow()
		expect(safeStringify(o)).toContain('[Circular]')
	})
})

// SEC-1: trace-store writes run inside `worker.onmessage` on main; a user
// attribute that `JSON.stringify` can't serialize must not crash the process.
describe('TraceStore tolerates non-serializable user attributes (main side)', () => {
	test('insertSpan / updateAttributes / addEvent with BigInt + circular do not throw', () => {
		const store = makeStore()
		const circular: Record<string, unknown> = {}
		circular.self = circular

		expect(() => store.insertSpan(span({ attributes: { big: 1n, circular } }))).not.toThrow()
		expect(() => store.updateAttributes('s1', { big: 2n })).not.toThrow()
		expect(() => store.addEvent(event({ attributes: { circular } }))).not.toThrow()

		const trace = store.getTrace('t1')
		expect(trace.spans).toHaveLength(1)
		// 1n from insertSpan, then 2n from updateAttributes — both coerced to string and persisted.
		expect(trace.spans[0]!.attributes.big).toBe('2')
		expect(trace.events).toHaveLength(1)
	})
})

// CORR-RPC-1: the worker forwards trace ops via postMessage (structured clone).
// A non-cloneable attribute value (function, class instance) must be dropped,
// not thrown out of the user's handler as a DataCloneError.
describe('RemoteTraceStore survives non-cloneable user attributes (worker side)', () => {
	// Mimic postMessage: structured-clone the message, which throws on a
	// non-cloneable value exactly like the real worker boundary does.
	function makeRemote(): { remote: RemoteTraceStore; received: WorkerMessage[] } {
		const received: WorkerMessage[] = []
		const remote = new RemoteTraceStore((msg) => {
			received.push(structuredClone(msg))
		})
		return { remote, received }
	}

	test('updateAttributes drops a function value and posts the rest', () => {
		const { remote, received } = makeRemote()
		expect(() => remote.updateAttributes('s1', { fn: () => {}, ok: 'kept' })).not.toThrow()
		const msg = received.find((m) => m.type === 'trace-span-attrs') as Extract<WorkerMessage, { type: 'trace-span-attrs' }>
		expect(msg.attrs).toEqual({ ok: 'kept' })
		expect('fn' in msg.attrs).toBe(false)
	})

	test('addEvent with a non-cloneable attribute does not throw', () => {
		const { remote, received } = makeRemote()
		expect(() => remote.addEvent(event({ attributes: { fn: () => {}, ok: 'kept' } }))).not.toThrow()
		const msg = received.find((m) => m.type === 'trace-span-event') as Extract<WorkerMessage, { type: 'trace-span-event' }>
		expect(msg.event.attributes).toEqual({ ok: 'kept' })
	})

	test('clean attributes are posted as-is (no needless copy)', () => {
		const { remote, received } = makeRemote()
		const attrs = { a: 1, b: 'two' }
		remote.updateAttributes('s1', attrs)
		const msg = received.find((m) => m.type === 'trace-span-attrs') as Extract<WorkerMessage, { type: 'trace-span-attrs' }>
		expect(msg.attrs).toEqual(attrs)
	})
})
