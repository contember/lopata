import { describe, expect, test } from 'bun:test'
import { ExecutionContext } from '../src/execution-context'
import { addCfProperty } from '../src/request-cf'
import { trackBackgroundWork, WorkerExecutionContext } from '../src/worker-thread/execution-context'
import type { WorkerMessage } from '../src/worker-thread/protocol'

describe('ExecutionContext', () => {
	test('waitUntil tracks and awaits promises', async () => {
		const ctx = new ExecutionContext()
		let ran = false
		ctx.waitUntil(
			new Promise<void>(resolve => {
				setTimeout(() => {
					ran = true
					resolve()
				}, 10)
			}),
		)
		expect(ran).toBe(false)
		await ctx._awaitAll()
		expect(ran).toBe(true)
	})

	test('rejected promises do not throw from _awaitAll', async () => {
		const ctx = new ExecutionContext()
		ctx.waitUntil(Promise.reject(new Error('fail')))
		// Should not throw
		await ctx._awaitAll()
	})

	test('multiple promises all execute', async () => {
		const ctx = new ExecutionContext()
		const results: number[] = []
		ctx.waitUntil(
			new Promise<void>(resolve => {
				results.push(1)
				resolve()
			}),
		)
		ctx.waitUntil(
			new Promise<void>(resolve => {
				results.push(2)
				resolve()
			}),
		)
		ctx.waitUntil(
			new Promise<void>(resolve => {
				results.push(3)
				resolve()
			}),
		)
		await ctx._awaitAll()
		expect(results).toEqual([1, 2, 3])
	})
})

describe('WorkerExecutionContext waitUntil accounting', () => {
	const ids = (posted: WorkerMessage[], type: 'wait-until-add' | 'wait-until-settle') =>
		posted.flatMap(m => m.type === type ? [m.id] : [])
	// logIfRejected chains microtask hops (resolve coercion + catch)
	const settle = () => new Promise(resolve => setTimeout(resolve, 0))

	test('settles the wait-until id for resolved and rejected promises', async () => {
		const posted: WorkerMessage[] = []
		const ctx = new WorkerExecutionContext(msg => posted.push(msg))
		ctx.waitUntil(Promise.resolve('ok'))
		ctx.waitUntil(Promise.reject(new Error('boom')))
		await settle()
		expect(ids(posted, 'wait-until-add')).toEqual(ids(posted, 'wait-until-settle'))
		expect(ids(posted, 'wait-until-add')).toHaveLength(2)
	})

	test('a non-thenable does not leak the wait-until id (would pin the generation non-idle)', async () => {
		const posted: WorkerMessage[] = []
		const ctx = new WorkerExecutionContext(msg => posted.push(msg))
		// CF tolerates ctx.waitUntil(undefined); Reflect.apply bypasses the
		// Promise param type the way untyped user code does. Must not throw.
		Reflect.apply(ctx.waitUntil, ctx, [undefined])
		Reflect.apply(ctx.waitUntil, ctx, [42])
		await settle()
		expect(ids(posted, 'wait-until-add')).toEqual(ids(posted, 'wait-until-settle'))
		expect(ids(posted, 'wait-until-add')).toHaveLength(2)
	})

	test('trackBackgroundWork settles for non-thenables too', async () => {
		const posted: WorkerMessage[] = []
		Reflect.apply(trackBackgroundWork, undefined, [(msg: WorkerMessage) => posted.push(msg), null])
		await settle()
		expect(ids(posted, 'wait-until-add')).toEqual(ids(posted, 'wait-until-settle'))
		expect(ids(posted, 'wait-until-add')).toHaveLength(1)
	})
})

describe('addCfProperty', () => {
	test('sets expected cf fields on request', () => {
		const req = new Request('http://localhost/test')
		addCfProperty(req)
		const cf = (req as any).cf
		expect(cf).toBeDefined()
		expect(cf.country).toBe('US')
		expect(cf.city).toBe('San Francisco')
		expect(cf.colo).toBe('SFO')
		expect(cf.asn).toBe(13335)
		expect(cf.httpProtocol).toBe('HTTP/2')
		expect(cf.tlsVersion).toBe('TLSv1.3')
		expect(cf.timezone).toBe('America/Los_Angeles')
	})
})
