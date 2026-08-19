import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The dashboard's manual cron trigger under the Vite plugin.
 *
 * Under the `lopata dev` CLI the dashboard talks to a real `Generation`, which has
 * `callScheduled`. In Vite mode the generation is a small adapter around the SSR-loaded
 * worker module, and it used to expose only `callFetch` — so every Trigger button in the
 * dashboard's Scheduled page died with `gen.callScheduled is not a function`.
 */

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/scheduled-vite-worker')
const VITE_BIN = resolve(import.meta.dir, '../node_modules/.bin/vite')
const PORT = 18860
const CRON = '0 0 1 1 *'

/**
 * Drains the dev server's stdout+stderr. Piped output that nobody reads eventually
 * fills the OS pipe buffer and blocks the server, and keeping the text around makes a
 * boot failure debuggable instead of a bare readiness timeout.
 */
class OutputLog {
	private text = ''

	constructor(proc: Subprocess) {
		void this.drain(proc.stdout as ReadableStream<Uint8Array>)
		void this.drain(proc.stderr as ReadableStream<Uint8Array>)
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

/**
 * Wait for the dashboard API, deliberately without touching the worker's own routes:
 * the first test asserts the cold path, where nothing has imported the worker module yet.
 */
async function waitForDashboard(timeoutMs: number, log: OutputLog): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			const { status, body } = await rpc('scheduled.listTriggers', {})
			if (status === 200 && Array.isArray(body)) return
		} catch {
			// server not listening yet
		}
		await new Promise(r => setTimeout(r, 250))
	}
	throw new Error(`Dashboard API on :${PORT} did not become ready within ${timeoutMs}ms\n--- server output ---\n${log.get()}`)
}

async function rpc(procedure: string, input: unknown): Promise<{ status: number; body: any }> {
	const res = await fetch(`http://localhost:${PORT}/__api/rpc`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ procedure, input }),
	})
	return { status: res.status, body: await res.json() }
}

async function ticks(): Promise<{ ticks: number; lastCron: string | null; waitUntilRan: boolean }> {
	const res = await fetch(`http://localhost:${PORT}/ticks`)
	return await res.json() as { ticks: number; lastCron: string | null; waitUntilRan: boolean }
}

function cleanup() {
	rmSync(resolve(FIXTURE_DIR, '.lopata'), { recursive: true, force: true })
}

describe('Scheduled trigger E2E — vite', () => {
	let proc: Subprocess
	let log: OutputLog

	beforeAll(async () => {
		cleanup()
		proc = Bun.spawn(['bun', '--bun', VITE_BIN, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		log = new OutputLog(proc)
		await waitForDashboard(60_000, log)
	}, 90_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	test('the dashboard lists the configured cron', async () => {
		const { body } = await rpc('scheduled.listTriggers', {})
		expect(body).toMatchObject([{ expression: CRON, workerName: null }])
	})

	// Runs first, and nothing above it requests a worker route: on a fresh dev server the
	// worker module has not been imported yet, which is exactly when someone opens the
	// dashboard and hits Trigger. The generation adapter has to be live already.
	test("triggering the cron runs the worker's scheduled() handler, with no prior app request", async () => {
		const { status, body } = await rpc('scheduled.trigger', { cron: CRON })
		expect(status).toBe(200)
		expect(body).toEqual({ ok: true })

		expect(await ticks()).toEqual({ ticks: 1, lastCron: CRON, waitUntilRan: true })
	}, 15_000)

	test('triggering again ticks the same module instance', async () => {
		const { body } = await rpc('scheduled.trigger', { cron: CRON })
		expect(body).toEqual({ ok: true })
		expect((await ticks()).ticks).toBe(2)
	}, 15_000)

	// CLI parity: `bunx lopata dev` exposes the same URL for scripted triggers.
	test('GET /cdn-cgi/handler/scheduled triggers the handler too', async () => {
		const res = await fetch(`http://localhost:${PORT}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(CRON)}`)
		expect(res.status).toBe(200)

		expect(await ticks()).toEqual({ ticks: 3, lastCron: CRON, waitUntilRan: true })
	}, 15_000)

	// This fixture is single-worker, so there is no auxiliary registry to look a name up
	// in. `resolveWorkerParam` in the CLI warns and uses the main worker; dereferencing the
	// absent registry instead would 500 on every `?worker=` request here.
	test('an unknown ?worker= falls back to the main worker rather than failing', async () => {
		const res = await fetch(
			`http://localhost:${PORT}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(CRON)}&worker=does-not-exist`,
		)
		expect(res.status).toBe(200)

		expect((await ticks()).ticks).toBe(4)
	}, 15_000)

	// This fixture has no email() handler, and Generation.callEmail persists the message
	// before it discovers that — so the dashboard's Email list shows the attempt either way.
	test('an email with no handler is still persisted for the dashboard', async () => {
		const { status } = await rpc('email.trigger', { from: 'a@example.com', to: 'b@example.com', subject: 'x', body: 'y' })
		expect(status).not.toBe(200)

		const { body: messages } = await rpc('email.list', {})
		expect(messages).toMatchObject([{ from_addr: 'a@example.com', to_addr: 'b@example.com', status: 'received' }])
	}, 15_000)
})
