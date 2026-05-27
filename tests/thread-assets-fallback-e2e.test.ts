import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/thread-assets-fallback')
const CLI_PATH = resolve(import.meta.dir, '../src/cli.ts')

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			await fetch(url)
			return
		} catch {
			await new Promise((r) => setTimeout(r, 200))
		}
	}
	throw new Error(`Server ${url} did not become ready in ${timeoutMs}ms`)
}

function cleanup() {
	try {
		rmSync(resolve(FIXTURE_DIR, '.lopata'), { recursive: true, force: true })
	} catch {}
}

function spawnDev(port: number): Subprocess {
	return Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(port)], {
		cwd: FIXTURE_DIR,
		stdout: 'pipe',
		stderr: 'pipe',
	})
}

describe('worker 404 → assets fallback cancels worker response body', () => {
	let proc: Subprocess
	const PORT = 18840
	const base = `http://localhost:${PORT}`

	beforeAll(async () => {
		cleanup()
		proc = spawnDev(PORT)
		await waitForServer(`${base}/counter`, 15_000)
	}, 20_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	test('streaming 404 body is cancelled — source pump stops, assets serve the request', async () => {
		// Counter starts at 0 — worker's slow 404 body has never run to completion.
		const before = await fetch(`${base}/counter`)
		expect(await before.text()).toBe('0')

		// Hit the asset path: worker runs first, returns 404 with a slow streaming
		// body, dev server falls back to static asset content. The worker's body
		// MUST be cancelled — otherwise the source pump would eventually tick the
		// drainedCount counter.
		const res = await fetch(`${base}/hello.txt`)
		expect(res.status).toBe(200)
		expect((await res.text()).trim()).toBe('asset-from-disk')

		// Wait longer than the source's 50*10ms = 500ms total emit window so we
		// would observe the leak if it existed. Then check the counter remains 0.
		await new Promise((r) => setTimeout(r, 700))
		const after = await fetch(`${base}/counter`)
		expect(await after.text()).toBe('0')
	}, 15_000)
})
