import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/do-reload-worker')
const WORKER_SRC = resolve(FIXTURE_DIR, 'src/index.ts')
const CLI_PATH = resolve(import.meta.dir, '../src/cli.ts')
const PORT = 18850
const BASE = `http://localhost:${PORT}`

// Minimal stdout/stderr reader with position-scoped marker waits (see hmr-e2e).
class OutputReader {
	private output = ''
	private markPos = 0
	private waiters: Array<{ check: () => boolean; resolve: () => void }> = []

	constructor(proc: Subprocess) {
		this.read(proc.stdout as ReadableStream<Uint8Array>)
		this.read(proc.stderr as ReadableStream<Uint8Array>)
	}

	private async read(stream: ReadableStream<Uint8Array>) {
		const decoder = new TextDecoder()
		const reader = stream.getReader()
		try {
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				if (value) {
					this.output += decoder.decode(value)
					this.waiters = this.waiters.filter(w => {
						if (!w.check()) return true
						w.resolve()
						return false
					})
				}
			}
		} finally {
			reader.releaseLock()
		}
	}

	async waitFor(marker: string, timeoutMs: number): Promise<void> {
		if (this.output.includes(marker)) return
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${marker}"\n${this.output}`)), timeoutMs)
			this.waiters.push({
				check: () => this.output.includes(marker),
				resolve: () => {
					clearTimeout(timer)
					resolve()
				},
			})
		})
	}

	mark(): void {
		this.markPos = this.output.length
	}

	async waitForNew(marker: string, timeoutMs: number): Promise<void> {
		const check = () => this.output.indexOf(marker, this.markPos) !== -1
		if (check()) return
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`Timeout waiting for new "${marker}"\n${this.output.slice(this.markPos)}`)),
				timeoutMs,
			)
			this.waiters.push({
				check,
				resolve: () => {
					clearTimeout(timer)
					resolve()
				},
			})
		})
	}
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Reload resilience for Durable Objects. Reload terminates + respawns the user
// worker; these two behaviors regressed silently before — a failed reload tore
// down live DOs, and a pending alarm got wiped by the old generation's drain.
describe('DO reload resilience E2E', () => {
	let proc: Subprocess
	let output: OutputReader
	const original = readFileSync(WORKER_SRC, 'utf-8')
	const restoreSrc = () => writeFileSync(WORKER_SRC, original)

	beforeAll(async () => {
		rmSync(resolve(FIXTURE_DIR, '.lopata'), { recursive: true, force: true })
		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		output = new OutputReader(proc)
		await output.waitFor('Server running', 15_000)
	}, 20_000)

	afterAll(() => {
		proc?.kill()
		restoreSrc()
		rmSync(resolve(FIXTURE_DIR, '.lopata'), { recursive: true, force: true })
	})

	// A syntax error mid-edit must not take down the running app: the worker
	// thread fails to load, but the previous generation keeps serving — including
	// Durable Object routes, which must not 500.
	test('a failed reload keeps Durable Objects serving last-good code', async () => {
		await fetch(`${BASE}/inc`)
		expect(await (await fetch(`${BASE}/inc`)).text()).toBe('2')

		// Break the source → reload attempt fails.
		output.mark()
		writeFileSync(WORKER_SRC, `${original}\nthis is !!! not valid typescript (((\n`)
		await output.waitForNew('Reload failed', 10_000)

		// Old generation still serves: plain fetch AND DO state, no 500s.
		expect(await (await fetch(`${BASE}/ping`)).text()).toBe('pong')
		const get = await fetch(`${BASE}/get`)
		expect(get.status).toBe(200)
		expect(await get.text()).toBe('2')
		expect(await (await fetch(`${BASE}/inc`)).text()).toBe('3')

		// Fixing the source recovers cleanly with state carried over.
		output.mark()
		restoreSrc()
		await output.waitForNew('Reloaded', 10_000)
		expect(await (await fetch(`${BASE}/get`)).text()).toBe('3')
	}, 30_000)

	// An alarm scheduled before a reload must still fire afterwards. The new
	// generation restores it from the DB; the old generation's drain must not
	// clear the timer it just restored on the shared namespace.
	test('a Durable Object alarm survives a reload', async () => {
		expect(await (await fetch(`${BASE}/set-alarm`)).text()).toBe('set')

		// Trigger a successful reload before the 1.5s alarm fires.
		output.mark()
		const src = readFileSync(WORKER_SRC, 'utf-8')
		writeFileSync(WORKER_SRC, src.replace('force a (successful) reload: vA', 'force a (successful) reload: vB'))
		await output.waitForNew('Reloaded', 10_000)

		// Wait past the deadline, then confirm the alarm handler ran.
		await sleep(2500)
		expect(await (await fetch(`${BASE}/fired`)).text()).toBe('true')
	}, 30_000)
})
