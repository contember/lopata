import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/assets-method-gate')
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

describe('assets-first routing gates on method (GET/HEAD only)', () => {
	let proc: Subprocess
	const PORT = 18841
	const base = `http://localhost:${PORT}`

	beforeAll(async () => {
		cleanup()
		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		await waitForServer(`${base}/account/`, 15_000)
	}, 20_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	test('GET to an asset path is served the asset, not the worker', async () => {
		const res = await fetch(`${base}/account/`)
		expect(res.status).toBe(200)
		expect(await res.text()).toContain('asset-account-index')
	})

	test('POST to the same asset path reaches the worker, not the asset', async () => {
		const res = await fetch(`${base}/account/`, { method: 'POST' })
		expect(res.status).toBe(201)
		expect(await res.text()).toBe('worker-handled POST')
	})

	test('PUT to the same asset path reaches the worker', async () => {
		const res = await fetch(`${base}/account/`, { method: 'PUT' })
		expect(res.status).toBe(201)
		expect(await res.text()).toBe('worker-handled PUT')
	})
})
