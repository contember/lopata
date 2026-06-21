import { describe, expect, test } from 'bun:test'
// Side-effect import: installs the global `Request` shim for this process.
import '../src/worker-thread/request-clone-fix'

function streamBodyReq(init?: RequestInit): Request {
	return new Request('http://example.test/', {
		method: 'POST',
		duplex: 'half',
		headers: { 'content-type': 'application/json' },
		body: new ReadableStream({
			start(c) {
				c.enqueue(new TextEncoder().encode('{"a":1}'))
				c.close()
			},
		}),
		...init,
	} as RequestInit)
}

describe('request-clone-fix (Bun stream-body re-wrap shim)', () => {
	test('re-wrapping a stream-bodied request stays readable (would hang natively)', async () => {
		const rewrapped = new Request(streamBodyReq(), { headers: { 'x-add': '1' } })
		// merged headers: original preserved, new one added
		expect(rewrapped.headers.get('content-type')).toBe('application/json')
		expect(rewrapped.headers.get('x-add')).toBe('1')
		// the forwarded body is consumable rather than deadlocking
		expect(await rewrapped.json()).toEqual({ a: 1 })
	})

	test('explicit { body: null } drops the body (matches native semantics)', () => {
		const rewrapped = new Request(streamBodyReq(), { body: null } as RequestInit)
		expect(rewrapped.body).toBeNull()
	})

	test('preserves the cache directive across the re-wrap', () => {
		const rewrapped = new Request(streamBodyReq({ cache: 'no-store' }), { headers: { x: '1' } })
		expect(rewrapped.cache).toBe('no-store')
	})

	test('non-stream / string-body construction is unaffected', async () => {
		const r = new Request('http://example.test/', { method: 'POST', body: '{"b":2}' })
		expect(await r.json()).toEqual({ b: 2 })
	})

	test('instanceof Request still holds for the subclass', () => {
		expect(new Request('http://example.test/') instanceof Request).toBe(true)
	})
})
