import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/thread-ae-worker')
const CLI_PATH = resolve(import.meta.dir, '../src/cli.ts')

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			await fetch(url)
			return
		} catch {
			await new Promise(r => setTimeout(r, 200))
		}
	}
	throw new Error(`Server ${url} did not become ready in ${timeoutMs}ms`)
}

function cleanup() {
	try {
		rmSync(resolve(FIXTURE_DIR, '.lopata'), { recursive: true, force: true })
	} catch {}
}

describe('Analytics Engine SQL API (worker-thread runtime)', () => {
	let proc: Subprocess
	const PORT = 18801
	const base = `http://localhost:${PORT}`

	beforeAll(async () => {
		cleanup()
		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		await waitForServer(`${base}/health`, 15_000)
	}, 20_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	test('writeDataPoint + intercepted SQL API query round-trips through SQLite', async () => {
		expect(await (await fetch(`${base}/write`)).text()).toBe('ok')

		const res = await fetch(`${base}/query`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toContain('application/json')

		const body = (await res.json()) as {
			meta: { name: string; type: string }[]
			data: { method: string; n: number; p50: number }[]
			rows: number
		}
		expect(body.data).toEqual([
			{ method: 'GET', n: 2, p50: 15 }, // quantile(0.5) interpolates [10,20] at pos 0.5 → 15
			{ method: 'POST', n: 1, p50: 100 },
		])
		expect(body.rows).toBe(2)
		expect(body.meta.map(m => m.name)).toEqual(['method', 'n', 'p50'])
	})
})
