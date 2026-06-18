import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WranglerConfig } from '../src/config'
import { WorkerThreadExecutor } from '../src/worker-thread/executor'

/**
 * Drives `executeFetch` directly (no HTTP in front) so the test can hand it a
 * Request whose signal is ALREADY aborted — the pre-dispatch client-disconnect
 * race that can't be produced deterministically through a real socket.
 */

let executor: WorkerThreadExecutor
let tempDir: string

beforeAll(async () => {
	tempDir = mkdtempSync(join(tmpdir(), 'lopata-abort-'))
	const modulePath = join(tempDir, 'worker.ts')
	writeFileSync(
		modulePath,
		`
		export default {
			async fetch(request) {
				const outcome = await new Promise(resolve => {
					if (request.signal.aborted) return resolve('already-aborted')
					request.signal.addEventListener('abort', () => resolve('abort-fired'), { once: true })
					setTimeout(() => resolve('no-abort'), 400)
				})
				return new Response(outcome)
			},
		}
	`,
	)
	executor = new WorkerThreadExecutor({
		modulePath,
		config: { name: 'abort-test', main: 'worker.ts' } as unknown as WranglerConfig,
		baseDir: tempDir,
		mainEnv: {},
	})
	await executor.ready()
}, 15_000)

afterAll(() => {
	executor?.dispose()
})

describe('request.signal across the thread boundary', () => {
	test('an already-aborted signal still reaches the worker-side request', async () => {
		// fetch-abort must be posted AFTER the fetch command (FIFO) — posting it
		// first no-ops in the worker (no controller registered for the id yet)
		// and the rebuilt Request's signal would never fire.
		const request = new Request('http://localhost/pre-aborted', { signal: AbortSignal.abort() })
		const res = await executor.executeFetch(request)
		expect(['already-aborted', 'abort-fired']).toContain(await res.text())
	}, 10_000)

	test('a request without abort completes normally', async () => {
		const res = await executor.executeFetch(new Request('http://localhost/normal'))
		expect(await res.text()).toBe('no-abort')
	}, 10_000)
})
