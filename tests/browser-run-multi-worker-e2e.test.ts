import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import puppeteer, { type Browser } from 'puppeteer'

/**
 * The `browser` option of lopata.config.ts reaches an auxiliary worker's Browser Run binding.
 * Chrome is an external browser the binding reaches through `browser.httpEndpoint`.
 */

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/browser-run-multi-worker')
const CLI_PATH = resolve(import.meta.dir, '../src/cli.ts')
const PORT = 18882
const base = `http://localhost:${PORT}`
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

function cleanup() {
	rmSync(resolve(FIXTURE_DIR, '.lopata'), { recursive: true, force: true })
}

describe.skipIf(!hasChrome)('Browser Run binding of an auxiliary worker (lopata.config.ts)', () => {
	let chrome: Browser
	let proc: Subprocess
	/** Targets opened in the external Chrome: proves the `browser` config reached the auxiliary worker. */
	const createdTargets: string[] = []

	beforeAll(async () => {
		cleanup()
		chrome = await puppeteer.launch({ headless: true })
		chrome.on('targetcreated', target => createdTargets.push(target.url()))
		const chromePort = new URL(chrome.wsEndpoint()).port
		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			env: { ...process.env, LOPATA_TEST_CHROME_URL: `http://127.0.0.1:${chromePort}` },
			stdout: 'pipe',
			stderr: 'pipe',
		})
		await waitForServer(base, 20_000)
	}, 40_000)

	afterAll(async () => {
		proc?.kill()
		await chrome?.close()
		cleanup()
	})

	test('the auxiliary worker drives the configured external Chrome over CDP', async () => {
		const res = await fetch(`${base}/aux/round-trip`)
		if (res.status !== 200) throw new Error(`GET /aux/round-trip returned ${res.status}: ${await res.text()}`)
		expect(await res.json()).toEqual({ product: expect.stringContaining('Chrome'), afterClose: null })
		expect(createdTargets).toContain('about:blank#round-trip')
	}, 30_000)
})
