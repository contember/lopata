import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/thread-stateless-worker')
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

describe('Stateless bindings in worker-isolation=thread mode', () => {
	let proc: Subprocess
	const PORT = 18800
	const base = `http://localhost:${PORT}`

	beforeAll(async () => {
		cleanup()
		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT), '--worker-isolation=thread'], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		await waitForServer(`${base}/vars`, 15_000)
	}, 20_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	test('vars from wrangler config reach the worker', async () => {
		const res = await fetch(`${base}/vars`)
		expect(await res.text()).toBe('hello-from-vars')
	})

	test('KV put/get round-trips through SQLite', async () => {
		expect(await (await fetch(`${base}/kv/put`)).text()).toBe('ok')
		expect(await (await fetch(`${base}/kv/get`)).text()).toBe('kv-value')
	})

	test('R2 put/get round-trips through filesystem', async () => {
		expect(await (await fetch(`${base}/r2/put`)).text()).toBe('ok')
		expect(await (await fetch(`${base}/r2/get`)).text()).toBe('r2-bytes')
	})

	test('D1 prepared statement returns inserted row', async () => {
		const res = await fetch(`${base}/d1`)
		expect(await res.text()).toBe('d1-row')
	})

	test('globalThis.caches.default is wired to the shared SQLite', async () => {
		const res = await fetch(`${base}/cache`)
		expect(await res.text()).toBe('cache-value')
	})

	test('static assets served by main thread (auto-serve)', async () => {
		const res = await fetch(`${base}/static.txt`)
		expect(res.status).toBe(200)
		expect((await res.text()).trim()).toBe('static-asset-content')
	})
})
