import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/thread-multi-worker')
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
	for (const dir of [FIXTURE_DIR, `${FIXTURE_DIR}/main`, `${FIXTURE_DIR}/aux`]) {
		try {
			rmSync(`${dir}/.lopata`, { recursive: true, force: true })
		} catch {}
	}
}

describe('Multi-worker thread mode + cross-thread service bindings', () => {
	let proc: Subprocess
	const PORT = 18803
	const base = `http://localhost:${PORT}`

	beforeAll(async () => {
		cleanup()
		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		// Aux loads first, then main; wait until main is reachable.
		await waitForServer(`${base}/local`, 20_000)
	}, 25_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	test('each worker runs in its own thread (main responds locally)', async () => {
		const res = await fetch(`${base}/local`)
		expect(await res.text()).toBe('main says hi')
	})

	test('main fetches aux through env.AUX.fetch() (thread → main → aux thread)', async () => {
		const res = await fetch(`${base}/via-aux/ping`)
		expect(await res.text()).toBe('main->aux: aux pong')
	})

	test('service binding preserves the URL across the bridge', async () => {
		const res = await fetch(`${base}/via-aux/echo?msg=hello`)
		expect(await res.text()).toBe('main->aux: aux echo ?msg=hello')
	})

	test('RPC method with a primitive return crosses the thread boundary', async () => {
		const res = await fetch(`${base}/aux-rpc/double?n=21`)
		expect(await res.text()).toBe('42')
	})

	test('RPC method with an object return is structured-cloned across the bridge', async () => {
		const res = await fetch(`${base}/aux-rpc/greet?name=alice`)
		expect(await res.json()).toEqual({ greeting: 'aux greets alice' })
	})
})
