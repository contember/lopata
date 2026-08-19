import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The dashboard's manual email trigger under the Vite plugin.
 *
 * Same gap the cron trigger had: `callEmail` lives on the real `Generation` the CLI
 * dashboard talks to, and the Vite generation adapter simply did not have it, so every
 * Send button died with `gen.callEmail is not a function`.
 */

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/email-vite-worker')
const VITE_BIN = resolve(import.meta.dir, '../node_modules/.bin/vite')
const PORT = 18797

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

/** Waits on the dashboard API, deliberately without touching a worker route — the first
 *  test asserts the cold path, where nothing has imported the worker module yet. */
async function waitForDashboard(timeoutMs: number, log: OutputLog): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			const { status, body } = await rpc('email.list', {})
			if (status === 200 && Array.isArray(body)) return
		} catch {
			// server not listening yet
		}
		await new Promise(r => setTimeout(r, 250))
	}
	throw new Error(`Dashboard API on :${PORT} did not become ready within ${timeoutMs}ms\n--- server output ---\n${log.get()}`)
}

async function received(): Promise<any[]> {
	const res = await fetch(`http://localhost:${PORT}/received`)
	return await res.json() as any[]
}

function cleanup() {
	rmSync(resolve(FIXTURE_DIR, '.lopata'), { recursive: true, force: true })
}

describe('Email trigger E2E — vite', () => {
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

	// Runs first, with no worker route requested above it: on a fresh dev server the
	// module has not been imported yet, which is when someone opens the dashboard and
	// sends a test mail.
	test("triggering an email runs the worker's email() handler, with no prior app request", async () => {
		const { status, body } = await rpc('email.trigger', {
			from: 'sender@example.com',
			to: 'inbox@example.com',
			subject: 'Hello',
			body: 'hello from the dashboard',
		})
		expect(status).toBe(200)
		expect(body).toEqual({ ok: true })

		const messages = await received()
		expect(messages).toHaveLength(1)
		expect(messages[0]).toMatchObject({
			from: 'sender@example.com',
			to: 'inbox@example.com',
			subject: 'Hello',
			body: 'hello from the dashboard',
		})
		expect(messages[0].rawSize).toBeGreaterThan(0)
	}, 15_000)

	// setReject()/forward() look the message up by id, so the row has to exist before the
	// handler runs — same ordering as Generation.callEmail.
	test('the delivered message is persisted for the dashboard to list', async () => {
		const { body } = await rpc('email.list', {})
		expect(body).toHaveLength(1)
		expect(body[0]).toMatchObject({
			from_addr: 'sender@example.com',
			to_addr: 'inbox@example.com',
			status: 'received',
		})
	})

	// CLI parity: `bunx lopata dev` exposes the same URL.
	test('POST /cdn-cgi/handler/email delivers a raw message', async () => {
		const raw = 'From: cli@example.com\r\nTo: inbox@example.com\r\nSubject: Raw\r\n\r\nstraight from curl'
		const res = await fetch(
			`http://localhost:${PORT}/cdn-cgi/handler/email?from=cli@example.com&to=inbox@example.com`,
			{ method: 'POST', body: raw },
		)
		expect(res.status).toBe(200)

		const messages = await received()
		expect(messages).toHaveLength(2)
		expect(messages[1]).toMatchObject({
			from: 'cli@example.com',
			to: 'inbox@example.com',
			subject: 'Raw',
			body: 'straight from curl',
		})
	}, 15_000)
})
