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

	test('a caller arriving during a reload gets the follow-up generation, not the previous one', async () => {
		// Two file-watcher events arrive close together. The second caller must
		// resolve with the generation from the reload that ran AFTER it queued —
		// not the previous generation (the CORR-25 stale-`this.active` bug).
		const config = { main: 'index.ts' } as unknown as WranglerConfig
		const manager = new GenerationManager(config, '/tmp', {})

		const gens = [{ id: 1 }, { id: 2 }] as unknown as import('../src/generation').Generation[]
		let call = 0
		;(manager as unknown as { _doReload: () => Promise<unknown> })._doReload = async () => {
			const g = gens[call++]
			await new Promise<void>(r => setTimeout(r, 10))
			return g
		}

		const p1 = manager.reload()
		await new Promise<void>(r => setTimeout(r, 1)) // let reload #1 start
		const p2 = manager.reload() // queued → must run reload #2

		expect(await p1).toBe(gens[0])
		expect(await p2).toBe(gens[1])
		expect(call).toBe(2)
	})

	test('a queued reload rejection propagates to its caller (no unhandled rejection)', async () => {
		// If the queued reload fails (user saved a syntax error), the queued caller
		// must observe that rejection — and it must not leak as an unhandledRejection.
		const config = { main: 'index.ts' } as unknown as WranglerConfig
		const manager = new GenerationManager(config, '/tmp', {})

		let call = 0
		const mockGen = { id: 1 } as unknown as import('../src/generation').Generation
		;(manager as unknown as { _doReload: () => Promise<unknown> })._doReload = async () => {
			call++
			await new Promise<void>(r => setTimeout(r, 10))
			if (call === 1) return mockGen
			throw new Error('queued boom')
		}

		const p1 = manager.reload()
		await new Promise<void>(r => setTimeout(r, 1))
		const p2 = manager.reload() // queued, will reject

		await expect(p1).resolves.toBe(mockGen)
		await expect(p2).rejects.toThrow('queued boom')

		await new Promise<void>(r => setTimeout(r, 30))
		expect(call).toBe(2)
		expect(unhandledRejections).toEqual([])
	})
})
