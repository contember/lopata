import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/thread-toplevel-rpc-worker')
const CLI_PATH = resolve(import.meta.dir, '../src/cli.ts')

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url)
			if (res.ok) return
		} catch {}
		await new Promise(r => setTimeout(r, 200))
	}
	throw new Error(`Server ${url} did not become ready in ${timeoutMs}ms`)
}

function cleanup() {
	try {
		rmSync(resolve(FIXTURE_DIR, '.lopata'), { recursive: true, force: true })
	} catch {}
}

describe('Top-level binding RPC during worker init (worker-thread runtime)', () => {
	let proc: Subprocess
	const PORT = 18834
	const base = `http://localhost:${PORT}`

	beforeAll(async () => {
		cleanup()
		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		// If init deadlocked on the top-level RPC the server never comes up and this
		// throws — which is exactly the regression this test guards.
		await waitForServer(base, 20_000)
	}, 25_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	test('a stateful-binding RPC at module top level completes (no init deadlock)', async () => {
		const res = await fetch(base)
		expect(res.status).toBe(200)
		const body = await res.json() as { bootSendOk: boolean }
		expect(body.bootSendOk).toBe(true)
	}, 10_000)
})
