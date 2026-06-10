import { describe, expect, test } from 'bun:test'
import { deserializeError, serializeError } from '../src/worker-thread/protocol'

describe('serializeError / deserializeError', () => {
	test('round-trips message, name and stack', () => {
		const err = new TypeError('boom')
		const out = deserializeError(serializeError(err))
		expect(out.message).toBe('boom')
		expect(out.name).toBe('TypeError')
		expect(out.stack).toBe(err.stack)
	})

	test('preserves enumerable own-properties (code/status/data)', () => {
		const err = Object.assign(new Error('failed'), { code: 'E_NOPE', status: 503, data: { id: 7 } })
		const out = deserializeError(serializeError(err)) as Error & { code?: string; status?: number; data?: { id: number } }
		expect(out.code).toBe('E_NOPE')
		expect(out.status).toBe(503)
		expect(out.data).toEqual({ id: 7 })
	})

	test('preserves the cause chain', () => {
		const root = new Error('root')
		const wrapped = new Error('wrapped', { cause: root })
		const out = deserializeError(serializeError(wrapped))
		expect(out.message).toBe('wrapped')
		expect((out.cause as Error)?.message).toBe('root')
	})

	test('caps cause recursion depth at MAX_CAUSE_DEPTH without throwing', () => {
		let err = new Error('leaf')
		for (let i = 0; i < 50; i++) err = new Error(`level-${i}`, { cause: err })
		// Must not stack-overflow / hang.
		const out = deserializeError(serializeError(err))
		expect(out.message).toBe('level-49')

		// The chain must be truncated at the cap (MAX_CAUSE_DEPTH = 8), not carry
		// all 50 levels — otherwise the depth guard could be removed and this test
		// would still pass. Walk the deserialized cause chain and count the links.
		let links = 0
		let cur: Error | undefined = out
		while (cur?.cause instanceof Error) {
			cur = cur.cause
			links++
		}
		expect(links).toBe(8)
		// level-49 (depth 0) → … → level-41 (depth 8), then capped.
		expect(cur?.message).toBe('level-41')
	})

	test('drops non-cloneable props instead of throwing', () => {
		const err = Object.assign(new Error('fn-prop'), { code: 'OK', handler: () => 42 })
		// Whole serialize must succeed even though `handler` is not cloneable.
		const ser = serializeError(err)
		// posting it (structured clone) must not throw
		expect(() => structuredClone(ser)).not.toThrow()
		const out = deserializeError(ser) as Error & { code?: string; handler?: unknown }
		expect(out.code).toBe('OK')
		expect(out.handler).toBeUndefined()
	})

	test('preserves a thrown plain object (non-Error) payload', () => {
		// Routing libs throw bare objects: `throw { status: 404, message: 'nope' }`.
		const out = deserializeError(serializeError({ status: 404, message: 'nope', detail: { x: 1 } })) as
			& Error
			& { status?: number; detail?: { x: number } }
		expect(out.message).toBe('nope')
		expect(out.status).toBe(404)
		expect(out.detail).toEqual({ x: 1 })
	})

	test('handles thrown primitives without throwing', () => {
		expect(deserializeError(serializeError('boom')).message).toBe('boom')
		expect(deserializeError(serializeError(42)).message).toBe('42')
		expect(deserializeError(serializeError(null)).message).toBe('null')
		expect(deserializeError(serializeError(undefined)).message).toBe('undefined')
	})

	test('is total — a throwing getter / null-proto value never escalates', () => {
		// A throwing getter on the thrown object must not propagate out of serialize
		// (it runs inside a worker catch block; a secondary throw would crash the
		// generation via worker.onerror).
		const evil: Record<string, unknown> = { ok: 1 }
		Object.defineProperty(evil, 'boom', {
			enumerable: true,
			get() {
				throw new Error('getter exploded')
			},
		})
		let ser!: ReturnType<typeof serializeError>
		expect(() => {
			ser = serializeError(evil)
		}).not.toThrow()
		expect((deserializeError(ser) as Error & { ok?: number }).ok).toBe(1)

		// A null-prototype object has no toString — String() of it throws; serialize
		// must still produce a valid envelope.
		expect(() => serializeError(Object.create(null))).not.toThrow()
	})
})
