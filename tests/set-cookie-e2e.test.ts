import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/set-cookie-worker')
const CLI_PATH = resolve(import.meta.dir, '../src/cli.ts')
const PORT = 8817

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

describe('Multiple Set-Cookie headers (worker-thread runtime)', () => {
	let proc: Subprocess

	beforeAll(async () => {
		cleanup()
		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		await waitForServer(`http://localhost:${PORT}/`, 20_000)
	})

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	test('every Set-Cookie reaches the client as its own header', async () => {
		const res = await fetch(`http://localhost:${PORT}/`)
		const cookies = res.headers.getSetCookie()
		// Without per-cookie handling these fold into one comma-joined header and
		// one of the cookies is lost.
		expect(cookies.length).toBe(2)
		expect(cookies.some(c => c.startsWith('session_token=abc123'))).toBe(true)
		expect(cookies.some(c => c.startsWith('session_data=xyz789'))).toBe(true)
	})
})
