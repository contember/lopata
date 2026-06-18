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

		const gen1 = { id: 1 } as unknown as import('../src/generation').Generation
		const gen2 = { id: 2 } as unknown as import('../src/generation').Generation
		let call = 0
		;(manager as unknown as { _doReload: () => Promise<unknown> })._doReload = async () => {
			call++
			const g = call === 1 ? gen1 : gen2
			await new Promise<void>(r => setTimeout(r, 10))
			return g
		}

		const p1 = manager.reload()
		await new Promise<void>(r => setTimeout(r, 1)) // let reload #1 start
		const p2 = manager.reload() // queued → must run reload #2

		expect(await p1).toBe(gen1)
		expect(await p2).toBe(gen2)
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

	test('workflow resume waits until every older generation is stopped', () => {
		// Rapid reloads leave several older generations in overlapping grace
		// windows. Resuming when the FIRST of them finishes would re-execute
		// instances another older generation is still running (their DB rows
		// stay 'running' mid-step) — one workflow in two threads at once.
		const config = { main: 'index.ts' } as unknown as WranglerConfig
		const manager = new GenerationManager(config, '/tmp', {})

		type FakeGen = { id: number; state: string; isIdle: () => boolean; drain: () => void; stop: () => void }
		const makeGen = (id: number, state: string): FakeGen => ({
			id,
			state,
			isIdle: () => true,
			drain: () => {},
			stop() {
				this.state = 'stopped'
			},
		})
		const gen1 = makeGen(1, 'draining')
		const gen2 = makeGen(2, 'draining')
		const gen3 = makeGen(3, 'active')

		const m = manager as unknown as {
			generations: Map<number, FakeGen>
			_activeGenId: number | null
			_resumeWorkflows: (gen: FakeGen) => void
			_scheduleDrainAndStop: (genId: number, gen: FakeGen) => void
		}
		m.generations.set(1, gen1)
		m.generations.set(2, gen2)
		m.generations.set(3, gen3)
		m._activeGenId = 3
		const resumed: number[] = []
		m._resumeWorkflows = gen => resumed.push(gen.id)

		// gen1's grace window elapses first — gen2 is still alive, so no resume yet
		m._scheduleDrainAndStop(1, gen1)
		expect(gen1.state).toBe('stopped')
		expect(resumed).toEqual([])

		// gen2 finishes — every older generation is stopped → resume on the active gen
		m._scheduleDrainAndStop(2, gen2)
		expect(resumed).toEqual([3])
	})
})
