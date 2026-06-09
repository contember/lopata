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
})
