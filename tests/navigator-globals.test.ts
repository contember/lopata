import { expect, test } from 'bun:test'
import '../src/plugin'

test('performance.now() returns a number', () => {
	const now = performance.now()
	expect(typeof now).toBe('number')
	expect(now).toBeGreaterThanOrEqual(0)
})

test('scheduler.wait resolves after delay', async () => {
	const start = Date.now()
	await (globalThis as unknown as { scheduler: { wait(ms: number): Promise<void> } }).scheduler.wait(50)
	const elapsed = Date.now() - start
	expect(elapsed).toBeGreaterThanOrEqual(40) // allow small timing variance
})

test('scheduler.wait(0) resolves immediately', async () => {
	const start = Date.now()
	await (globalThis as unknown as { scheduler: { wait(ms: number): Promise<void> } }).scheduler.wait(0)
	const elapsed = Date.now() - start
	expect(elapsed).toBeLessThan(50)
})

function schedulerWait(ms: unknown, options?: { signal?: AbortSignal }): Promise<void> {
	const scheduler: unknown = Reflect.get(globalThis, 'scheduler')
	const wait: unknown = typeof scheduler === 'object' && scheduler !== null ? Reflect.get(scheduler, 'wait') : undefined
	if (typeof wait !== 'function') throw new Error('scheduler.wait is missing')
	return Reflect.apply(wait, scheduler, [ms, options])
}

test('scheduler.wait rejects with the reason of an already aborted signal', async () => {
	const reason = new Error('stop')
	await expect(schedulerWait(100_000, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
})

test('scheduler.wait rejects with the signal reason when aborted while waiting', async () => {
	const controller = new AbortController()
	const waiting = schedulerWait(100_000, { signal: controller.signal })
	controller.abort()
	await expect(waiting).rejects.toBe(controller.signal.reason)
})

test('scheduler.wait coerces its delay to a number', async () => {
	const start = Date.now()
	await schedulerWait('foo')
	expect(Date.now() - start).toBeLessThan(50)
})
