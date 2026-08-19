import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Class-based entrypoints under the Vite plugin.
 *
 * `export default class extends WorkerEntrypoint` puts fetch/scheduled/email on the
 * prototype, with env and ctx supplied to the constructor. The Vite plugin used to look
 * for own properties on the default export only, so a class entrypoint appeared to have
 * no handlers at all: fetch fell through to Vite's 404 and the dashboard's triggers
 * reported "No scheduled handler defined". src/worker-thread/entry.ts has always
 * resolved both shapes for the CLI — this asserts the Vite path agrees.
 */

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/class-entrypoint-vite-worker')
const VITE_BIN = resolve(import.meta.dir, '../node_modules/.bin/vite')
const PORT = 18862
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

async function rpc(procedure: string, input: unknown): Promise<{ status: number; body: any }> {
	const res = await fetch(`http://localhost:${PORT}/__api/rpc`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ procedure, input }),
	})
	return { status: res.status, body: await res.json() }
}

async function waitForServer(timeoutMs: number, log: OutputLog): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://localhost:${PORT}/state`)
			if (res.ok) return
			await res.text()
		} catch {
			// server not listening yet
		}
		await new Promise(r => setTimeout(r, 250))
	}
	throw new Error(`Server on :${PORT} did not become ready within ${timeoutMs}ms\n--- server output ---\n${log.get()}`)
}

async function state(): Promise<{ greeting: string; ticks: number; mails: any[]; waitUntilRan: boolean }> {
	const res = await fetch(`http://localhost:${PORT}/state`)
	return await res.json() as { greeting: string; ticks: number; mails: any[]; waitUntilRan: boolean }
}

function cleanup() {
	rmSync(resolve(FIXTURE_DIR, '.lopata'), { recursive: true, force: true })
}

describe('Class-based entrypoint E2E — vite', () => {
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
		await waitForServer(60_000, log)
	}, 90_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	// `this.env` resolving proves the class was instantiated with (ctx, env) rather than
	// its prototype method being called with a bare `this`.
	test('fetch() on the prototype serves requests, with env from the constructor', async () => {
		expect(await state()).toMatchObject({ greeting: 'ahoj', ticks: 0 })
	})

	test('the dashboard cron trigger reaches scheduled() on the prototype', async () => {
		const { status, body } = await rpc('scheduled.trigger', { cron: CRON })
		expect(status).toBe(200)
		expect(body).toEqual({ ok: true })

		const after = await state()
		expect(after.ticks).toBe(1)
		// `this.ctx.waitUntil` only exists if the constructor received the ExecutionContext.
		expect(after.waitUntilRan).toBe(true)
	}, 15_000)

	test('the dashboard email trigger reaches an email() declared as a class field', async () => {
		const { status, body } = await rpc('email.trigger', {
			from: 'sender@example.com',
			to: 'inbox@example.com',
			subject: 'Hello',
			body: 'hi',
		})
		expect(status).toBe(200)
		expect(body).toEqual({ ok: true })

		expect((await state()).mails).toEqual([
			{ from: 'sender@example.com', to: 'inbox@example.com', greeting: 'ahoj' },
		])
	}, 15_000)

	// Constructing the entrypoint is user code, so a throwing constructor has to land in the
	// same place a throwing fetch() does — the lopata error page, not the middleware's bare
	// catch-all. `Accept: text/html` is what tells the two apart: renderErrorPage honors it,
	// while writeRequestError always answers text/plain. Last test in the file — every
	// construction fails after this, so nothing can run behind it.
	test('a throwing constructor renders the lopata error page', async () => {
		expect((await fetch(`http://localhost:${PORT}/arm-constructor-throw`)).status).toBe(200)

		const res = await fetch(`http://localhost:${PORT}/state`, { headers: { Accept: 'text/html' } })
		expect(res.status).toBe(500)
		expect(res.headers.get('content-type')).toContain('text/html')
		expect(await res.text()).toContain('constructor blew up')
	}, 15_000)
})
