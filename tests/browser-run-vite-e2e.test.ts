import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import puppeteer, { type Browser } from 'puppeteer'

/**
 * The Browser Run binding under the Vite plugin: the main worker and its Durable Objects run
 * in the dev-server process, an auxiliary worker runs in its own thread. Chrome is an external
 * browser the plugin reaches through `browser.httpEndpoint`.
 */

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/browser-run-vite')
const VITE_BIN = resolve(import.meta.dir, '../node_modules/.bin/vite')
const PORT = 18872
const base = `http://localhost:${PORT}`
const hasChrome = existsSync(puppeteer.executablePath())

/** Drains the dev server's output so the pipe never blocks it, and keeps it for failure messages. */
class OutputLog {
	private text = ''

	constructor(proc: Subprocess<'ignore', 'pipe', 'pipe'>) {
		void this.drain(proc.stdout)
		void this.drain(proc.stderr)
	}

	private async drain(stream: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder()
		for await (const chunk of stream) {
			this.text += decoder.decode(chunk, { stream: true })
		}
	}

	get(): string {
		return this.text
	}
}

async function waitForServer(url: string, timeoutMs: number, log: OutputLog): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			if ((await fetch(url)).ok) return
		} catch {
			// not listening yet
		}
		await new Promise(r => setTimeout(r, 250))
	}
	throw new Error(`Vite dev server on :${PORT} did not become ready within ${timeoutMs}ms\n--- server output ---\n${log.get()}`)
}

function cleanup() {
	rmSync(resolve(FIXTURE_DIR, '.lopata'), { recursive: true, force: true })
	rmSync(resolve(FIXTURE_DIR, 'aux/.lopata'), { recursive: true, force: true })
}

describe.skipIf(!hasChrome)('Browser Run binding under the Vite plugin', () => {
	let chrome: Browser
	let proc: Subprocess<'ignore', 'pipe', 'pipe'>
	let log: OutputLog
	/** Targets opened in the external Chrome: proves the plugin's `browser` config reached the binding. */
	const createdTargets: string[] = []

	async function getJson(path: string): Promise<unknown> {
		const res = await fetch(`${base}${path}`)
		if (res.status !== 200) throw new Error(`GET ${path} returned ${res.status}: ${await res.text()}\n--- server output ---\n${log.get()}`)
		return res.json()
	}

	beforeAll(async () => {
		cleanup()
		chrome = await puppeteer.launch({ headless: true })
		chrome.on('targetcreated', target => createdTargets.push(target.url()))
		const chromePort = new URL(chrome.wsEndpoint()).port
		proc = Bun.spawn(['bun', '--bun', VITE_BIN, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			env: { ...process.env, LOPATA_TEST_CHROME_URL: `http://127.0.0.1:${chromePort}` },
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
		})
		log = new OutputLog(proc)
		await waitForServer(`${base}/page`, 60_000, log)
	}, 90_000)

	afterAll(async () => {
		proc?.kill()
		await chrome?.close()
		cleanup()
	})

	test('the in-process main worker drives a page over CDP; getSession() is null after closeSession()', async () => {
		expect(await getJson('/drive-page')).toEqual({ product: expect.stringContaining('Chrome'), title: 'Hello from vite', afterClose: null })
		expect(createdTargets).toContain('about:blank')
	}, 30_000)

	test('a Durable Object sees and connects to a session the main worker acquired', async () => {
		expect(await getJson('/do-shared')).toEqual({ found: true, product: expect.stringContaining('Chrome') })
	}, 30_000)

	test('an auxiliary worker thread reaches the sessions over RPC', async () => {
		expect(await getJson('/aux')).toEqual({ product: expect.stringContaining('Chrome'), afterClose: null })
		expect(createdTargets).toContain('about:blank#round-trip')
	}, 30_000)
})
