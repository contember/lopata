import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { WranglerConfig } from '../src/config'
import { GenerationManager } from '../src/generation-manager'

describe('GenerationManager.reload()', () => {
	let unhandledRejections: unknown[] = []
	let onUnhandled: (err: unknown) => void

	beforeEach(() => {
		unhandledRejections = []
		onUnhandled = (err) => {
			unhandledRejections.push(err)
		}
		process.on('unhandledRejection', onUnhandled)
	})

	afterEach(() => {
		process.off('unhandledRejection', onUnhandled)
	})

	test('queued reload rejection from finally fire-and-forget is caught', async () => {
		// Two file-watcher events arrive close together. First reload completes;
		// in the finally, the queued reload is fired-and-forgotten. If it rejects
		// (user saved a syntax error), it must not surface as an unhandled rejection.
		const config = { main: 'index.ts' } as unknown as WranglerConfig
		const manager = new GenerationManager(config, '/tmp', {})

		let call = 0
		const mockGen = { id: 1 } as unknown as import('../src/generation').Generation
		// Override the private `_doReload` to control success/failure deterministically.
		;(manager as unknown as { _doReload: () => Promise<unknown> })._doReload = async () => {
			call++
			if (call === 1) {
				await new Promise<void>(r => setTimeout(r, 10))
				return mockGen
			}
			throw new Error('queued boom')
		}

		const p1 = manager.reload()
		// Simulate a second file-watcher event arriving while reload 1 is in flight,
		// but after any concurrent awaiter would have consumed _pendingReload itself —
		// so the fire-and-forget path in finally fires.
		await new Promise<void>(r => setTimeout(r, 1))
		;(manager as unknown as { _pendingReload: boolean })._pendingReload = true

		await expect(p1).resolves.toBe(mockGen)

		// Wait for the fire-and-forget reload to settle and any unhandledRejection
		// events to be delivered.
		await new Promise<void>(r => setTimeout(r, 30))

		expect(call).toBe(2)
		expect(unhandledRejections).toEqual([])
	})
})
