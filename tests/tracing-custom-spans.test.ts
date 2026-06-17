import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { runTracingMigrations } from '../src/tracing/db'
import { enterSpan, tracing } from '../src/tracing/span'
import { setTraceStore, TraceStore } from '../src/tracing/store'

let db: Database

beforeEach(() => {
	db = new Database(':memory:')
	runTracingMigrations(db)
	setTraceStore(new TraceStore(db))
})

afterEach(() => {
	setTraceStore(null)
})

interface SpanRow {
	span_id: string
	trace_id: string
	parent_span_id: string | null
	name: string
	kind: string
	status: string
	status_message: string | null
	end_time: number | null
	attributes: string | null
}

const spans = () => db.query<SpanRow, []>('SELECT * FROM spans ORDER BY start_time').all()
const events = () => db.query<{ name: string; level: string | null; message: string | null }, []>('SELECT * FROM span_events').all()
const firstSpan = () => spans()[0]!
const firstEvent = () => events()[0]!

describe('tracing.enterSpan (Cloudflare custom spans)', () => {
	test('records a finished span with the given name', () => {
		const result = enterSpan('parse', () => 42)

		expect(result).toBe(42)
		const span = firstSpan()
		expect(span.name).toBe('parse')
		expect(span.kind).toBe('internal')
		expect(span.status).toBe('ok')
		expect(span.end_time).not.toBeNull()
	})

	test('synchronous callback returns its value synchronously', () => {
		// Not a promise — must be the raw value, matching Cloudflare semantics.
		const result = enterSpan('compute', () => ({ ok: true }))
		expect(result).toEqual({ ok: true })
	})

	test('async callback returns a promise and ends the span after it settles', async () => {
		let settled = false
		const promise = enterSpan('fetchData', async () => {
			await Promise.resolve()
			settled = true
			return 'done'
		})
		expect(promise).toBeInstanceOf(Promise)
		// Span is still open until the promise settles.
		expect(firstSpan().end_time).toBeNull()

		const value = await promise
		expect(value).toBe('done')
		expect(settled).toBe(true)
		expect(firstSpan().status).toBe('ok')
		expect(firstSpan().end_time).not.toBeNull()
	})

	test('setAttribute persists attributes', async () => {
		await enterSpan('handleRequest', span => {
			span.setAttribute('url.path', '/users')
			span.setAttribute('http.response.status_code', 200)
			span.setAttribute('cache.hit', true)
		})

		const attrs = JSON.parse(firstSpan().attributes ?? '{}')
		expect(attrs['url.path']).toBe('/users')
		expect(attrs['http.response.status_code']).toBe(200)
		expect(attrs['cache.hit']).toBe(true)
	})

	test('isTraced is true inside a span', () => {
		let traced: boolean | undefined
		enterSpan('check', span => {
			traced = span.isTraced
		})
		expect(traced).toBe(true)
	})

	test('forwards extra arguments to the callback', () => {
		const doubled = enterSpan('compute', (_span, x: number) => x * 2, 21)
		expect(doubled).toBe(42)
	})

	test('nests child spans under the active span in the same trace', () => {
		enterSpan('outer', () => {
			enterSpan('inner', () => {})
		})

		const all = spans()
		const outer = all.find(s => s.name === 'outer')!
		const inner = all.find(s => s.name === 'inner')!
		expect(inner.parent_span_id).toBe(outer.span_id)
		expect(inner.trace_id).toBe(outer.trace_id)
		expect(outer.parent_span_id).toBeNull()
	})

	test('marks the span errored and records an exception event on a synchronous throw', () => {
		expect(() => enterSpan('boom', () => { throw new Error('kaboom') })).toThrow('kaboom')

		const span = firstSpan()
		expect(span.status).toBe('error')
		expect(span.status_message).toBe('kaboom')
		const event = firstEvent()
		expect(event.name).toBe('exception')
		expect(event.message).toBe('kaboom')
	})

	test('marks the span errored on an async rejection and rethrows', async () => {
		await expect(
			enterSpan('boom-async', async () => {
				await Promise.resolve()
				throw new Error('later')
			}),
		).rejects.toThrow('later')

		const span = firstSpan()
		expect(span.status).toBe('error')
		expect(span.status_message).toBe('later')
		expect(firstEvent().name).toBe('exception')
	})

	test('tracing namespace exposes enterSpan', () => {
		expect(tracing.enterSpan).toBe(enterSpan)
	})
})
