import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import puppeteer from 'puppeteer'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/browser-run-worker')
const CLI_PATH = resolve(import.meta.dir, '../src/cli.ts')
const hasChrome = existsSync(puppeteer.executablePath())

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

/** Fetch a fixture route; a failure reports the worker's error page instead of a bare status code. */
async function get(url: string): Promise<Response> {
	const res = await fetch(url)
	if (res.status !== 200) throw new Error(`GET ${url} returned ${res.status}: ${await res.text()}`)
	return res
}

function cleanup() {
	rmSync(resolve(FIXTURE_DIR, '.lopata'), { recursive: true, force: true })
}

describe.skipIf(!hasChrome)('Browser Run binding over raw CDP (worker-thread runtime)', () => {
	let proc: Subprocess
	const PORT = 18870
	const base = `http://localhost:${PORT}`

	beforeAll(async () => {
		cleanup()
		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		await waitForServer(`${base}/page`, 15_000)
	}, 20_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	test('launch() opens a browser-level CDP socket that drives a page; getSession() is null after closeSession()', async () => {
		const res = await get(`${base}/cdp`)
		expect(await res.json()).toEqual({
			product: expect.stringContaining('Chrome'),
			title: 'Hello from lopata',
			activeBeforeClose: true,
			closeStatus: 'closed',
			afterClose: null,
			closeReasonText: 'NormalClosure',
		})
	}, 30_000)

	test('connectSession() with a targetId opens that page target', async () => {
		const res = await get(`${base}/cdp-target`)
		expect(await res.json()).toEqual({ targetsListed: true, title: 'Hello from lopata', listed: true })
	}, 30_000)

	test('a Durable Object thread sees and connects to a session the worker acquired', async () => {
		const res = await get(`${base}/do-shared`)
		expect(await res.json()).toEqual({ found: true, product: expect.stringContaining('Chrome') })
	}, 30_000)

	test('the legacy @cloudflare/puppeteer shim still launches a puppeteer Browser', async () => {
		const res = await get(`${base}/puppeteer`)
		expect(await res.text()).toBe('Hello from lopata')
	}, 30_000)
})
