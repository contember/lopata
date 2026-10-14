import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/thread-loopback-loader-worker')
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

describe('ctx.exports, Worker Loader env and DO transactions (worker-thread runtime)', () => {
	let proc: Subprocess
	const PORT = 18864
	const base = `http://localhost:${PORT}`

	beforeAll(async () => {
		cleanup()
		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		await waitForServer(base, 20_000)
	}, 25_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	test('worker reaches its own entrypoints through ctx.exports and the imported exports', async () => {
		const res = await fetch(`${base}/exports`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			viaCtx: 'ctx:a',
			viaImport: 'import:b',
			withoutProps: 'none:/plain',
			defaultIsLoopback: true,
			hostIsNamespace: true,
		})
	}, 10_000)

	test('a Durable Object calls a loopback with props', async () => {
		const res = await fetch(`${base}/do-loopback`)
		expect(await res.json()).toBe('do:x')
	}, 10_000)

	test('a dynamic worker calls back into a loopback passed in its env', async () => {
		const res = await fetch(`${base}/do-loader`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			greeting: 'from-do:dynamic',
			fetched: 'from-do:/page',
			config: { tags: {} },
			isMap: true,
		})
	}, 15_000)

	test('nested transactionSync on the DO SQL database rolls back only the failed level', async () => {
		const res = await fetch(`${base}/do-transactions`)
		expect(await res.json()).toEqual(['kept.txt'])
	}, 10_000)
})
