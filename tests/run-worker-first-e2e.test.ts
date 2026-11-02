import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURES_DIR = resolve(import.meta.dir, 'fixtures')
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

function cleanup(fixture: string) {
	try {
		rmSync(resolve(FIXTURES_DIR, fixture, '.lopata'), { recursive: true, force: true })
	} catch {}
}

function spawnDev(fixture: string, port: number): Subprocess {
	return Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(port)], {
		cwd: resolve(FIXTURES_DIR, fixture),
		stdout: 'pipe',
		stderr: 'pipe',
	})
}

describe('run_worker_first: true makes the worker response final', () => {
	let proc: Subprocess
	const PORT = 18840
	const base = `http://localhost:${PORT}`

	beforeAll(async () => {
		cleanup('run-worker-first')
		proc = spawnDev('run-worker-first', PORT)
		await waitForServer(`${base}/hello.txt`, 15_000)
	}, 20_000)

	afterAll(() => {
		proc?.kill()
		cleanup('run-worker-first')
	})

	test('a worker 404 reaches the client instead of the SPA fallback', async () => {
		const res = await fetch(`${base}/f/unknown`)
		expect(res.status).toBe(404)
		expect(await res.text()).toBe('worker-not-found')
	})

	test('the worker still reaches assets through env.ASSETS.fetch()', async () => {
		const asset = await fetch(`${base}/hello.txt`)
		expect(asset.status).toBe(200)
		expect((await asset.text()).trim()).toBe('asset-from-disk')

		const spaRoute = await fetch(`${base}/some/client-route`)
		expect(spaRoute.status).toBe(200)
		expect(await spaRoute.text()).toContain('spa-shell')
	})
})

describe('run_worker_first rules route matched paths to the worker and negated ones to assets', () => {
	let proc: Subprocess
	const PORT = 18842
	const base = `http://localhost:${PORT}`

	beforeAll(async () => {
		cleanup('run-worker-first-rules')
		proc = spawnDev('run-worker-first-rules', PORT)
		await waitForServer(`${base}/static/hello.txt`, 15_000)
	}, 20_000)

	afterAll(() => {
		proc?.kill()
		cleanup('run-worker-first-rules')
	})

	test('a path matched by a positive rule keeps the worker 404', async () => {
		const res = await fetch(`${base}/f/unknown`)
		expect(res.status).toBe(404)
		expect(await res.text()).toBe('worker-not-found')
	})

	test('a path matched by a negative rule is answered by assets without the worker', async () => {
		const asset = await fetch(`${base}/static/hello.txt`)
		expect(asset.status).toBe(200)
		expect((await asset.text()).trim()).toBe('static-asset')

		const missing = await fetch(`${base}/static/missing.js`)
		expect(missing.status).toBe(200)
		expect(await missing.text()).toContain('spa-shell')

		const post = await fetch(`${base}/static/hello.txt`, { method: 'POST' })
		expect(post.status).toBe(405)
	})
})
