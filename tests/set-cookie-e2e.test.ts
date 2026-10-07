import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/set-cookie-worker')
const CLI_PATH = resolve(import.meta.dir, '../src/cli.ts')
const VITE_BIN = resolve(import.meta.dir, '../node_modules/.bin/vite')
const PORT = 8817
const VITE_PORT = 18863

/** Poll until the worker itself answers — vite can bind the port before the worker module is loaded. */
async function waitForWorker(url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url)
			if (res.ok && (await res.text()) === 'ok') return
		} catch {}
		await new Promise(r => setTimeout(r, 250))
	}
	throw new Error(`Server ${url} did not become ready in ${timeoutMs}ms`)
}

function cleanup() {
	try {
		rmSync(resolve(FIXTURE_DIR, '.lopata'), { recursive: true, force: true })
	} catch {}
}

function assertBothCookies(res: Response) {
	const cookies = res.headers.getSetCookie()
	// Each cookie must arrive as its own header line. Folding the response
	// headers into a keyed record anywhere along the way leaves only the last
	// one, since `record['set-cookie'] = value` overwrites.
	expect(cookies.length).toBe(2)
	expect(cookies.some(c => c.startsWith('session_token=abc123'))).toBe(true)
	expect(cookies.some(c => c.startsWith('session_data=xyz789'))).toBe(true)
}

describe('Multiple Set-Cookie headers (worker-thread runtime)', () => {
	let proc: Subprocess

	beforeAll(async () => {
		cleanup()
		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		await waitForWorker(`http://localhost:${PORT}/`, 20_000)
	}, 30_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	test('every Set-Cookie reaches the client as its own header', async () => {
		assertBothCookies(await fetch(`http://localhost:${PORT}/`))
	})
})

// The vite dev server is the path that actually regressed: its Node bridge has
// to rebuild the Response headers as a `writeHead` record, and the original
// `record[key] = value` loop dropped every cookie but the last. The Bun.serve
// path above hands the `Headers` over intact and never had the bug, so this
// block is the one that fails without `buildNodeHeaders`.
describe('Multiple Set-Cookie headers — vite', () => {
	let proc: Subprocess

	beforeAll(async () => {
		cleanup()
		proc = Bun.spawn(['bun', '--bun', VITE_BIN, 'dev', '--port', String(VITE_PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		await waitForWorker(`http://localhost:${VITE_PORT}/`, 60_000)
	}, 90_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	test('every Set-Cookie survives the node writeHead bridge', async () => {
		assertBothCookies(await fetch(`http://localhost:${VITE_PORT}/`))
	})
})
