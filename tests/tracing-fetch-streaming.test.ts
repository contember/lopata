import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import '../src/plugin'
import { runTracingMigrations } from '../src/tracing/db'
import { createInvocationTrace, type InvocationTrace } from '../src/tracing/invocation'
import { setTraceStore, TraceStore } from '../src/tracing/store'

let store: TraceStore
let invocation: InvocationTrace

beforeEach(() => {
	const db = new Database(':memory:')
	runTracingMigrations(db)
	store = new TraceStore(db)
	setTraceStore(store)
	invocation = createInvocationTrace({ name: 'streaming fetch' })
})

afterEach(() => {
	invocation.terminate('test cleanup')
	setTraceStore(null)
	store.close()
})

function fetchSpan(name: string) {
	const row = store.listAllSpans({}).items.find(span => span.name === name)
	if (!row) throw new Error(`Missing span ${name}`)
	const span = store.getTrace(row.traceId).spans.find(span => span.spanId === row.spanId)
	if (!span) throw new Error(`Missing span details ${name}`)
	return span
}

test('traced upload reaches the origin before EOF and retains HTTP metadata without body previews', async () => {
	const received = Promise.withResolvers<string>()
	const gate = Promise.withResolvers<void>()
	const origin = Bun.serve({
		port: 0,
		async fetch(request) {
			const reader = request.body?.getReader()
			if (!reader) throw new Error('Missing upload')
			const first = await reader.read()
			received.resolve(new TextDecoder().decode(first.value))
			let rest = ''
			while (true) {
				const chunk = await reader.read()
				if (chunk.done) break
				rest += new TextDecoder().decode(chunk.value)
			}
			return new Response(rest, { status: 201, headers: { 'x-origin': 'stream' } })
		},
	})
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('first'))
		},
		async pull(controller) {
			await gate.promise
			controller.enqueue(new TextEncoder().encode('last'))
			controller.close()
		},
	})
	try {
		const pending = invocation.run(() =>
			fetch(new URL('/upload', origin.url), {
				method: 'POST',
				headers: { 'content-type': 'text/plain', 'x-upload': 'stream' },
				body,
			})
		)
		expect(await received.promise).toBe('first')
		gate.resolve()
		const response = await pending
		expect(await response.text()).toBe('last')
		const span = fetchSpan('fetch POST /upload')
		expect(span.attributes).toMatchObject({
			'http.method': 'POST',
			'http.url': new URL('/upload', origin.url).href,
			'http.status_code': 201,
			'http.request.headers': { 'x-upload': 'stream' },
			'http.response.headers': { 'x-origin': 'stream' },
		})
		expect(span.attributes).not.toHaveProperty('http.request.body')
		expect(span.attributes).not.toHaveProperty('http.response.body')
	} finally {
		gate.resolve()
		await origin.stop(true)
	}
})

test('traced response returns headers before EOF and cancellation reaches the sole source branch', async () => {
	const cancelled = Promise.withResolvers<void>()
	let cancelCount = 0
	const origin = Bun.serve({
		port: 0,
		fetch() {
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('first'))
					},
					cancel() {
						cancelCount++
						cancelled.resolve()
					},
				}),
				{ headers: { 'content-type': 'text/plain' } },
			)
		},
	})
	try {
		const response = await invocation.run(() => fetch(new URL('/download', origin.url)))
		expect(response.status).toBe(200)
		expect(response.bodyUsed).toBe(false)
		const reader = response.body?.getReader()
		if (!reader) throw new Error('Missing response body')
		expect(new TextDecoder().decode((await reader.read()).value)).toBe('first')
		await reader.cancel('caller finished')
		await cancelled.promise
		expect(cancelCount).toBe(1)
		expect(fetchSpan('fetch GET /download').attributes).not.toHaveProperty('http.response.body')
		invocation.finishHandler()
		await invocation.completed
	} finally {
		await origin.stop(true)
	}
})

test('traced fetch preserves abort rejection and records the client error', async () => {
	const controller = new AbortController()
	controller.abort()
	await expect(invocation.run(() => fetch('http://localhost:1/aborted', { signal: controller.signal }))).rejects.toThrow()
	expect(fetchSpan('fetch GET /aborted').status).toBe('error')
})
