import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Service bindings in the main worker under the Vite plugin. The main worker runs in the dev-server
 * process, where its bindings carry the tracing wrapper; the auxiliary worker runs in its own thread.
 */

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/service-binding-vite')
const VITE_BIN = resolve(import.meta.dir, '../node_modules/.bin/vite')
const PORT = 18893
const base = `http://localhost:${PORT}`

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

async function waitForServer(timeoutMs: number, log: OutputLog): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			// The dashboard API answers without loading the main worker.
			await fetch(`${base}/__api/rpc`)
			return
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

describe('service bindings of the main worker under the Vite plugin', () => {
	let proc: Subprocess<'ignore', 'pipe', 'pipe'>
	let log: OutputLog

	beforeAll(async () => {
		cleanup()
		proc = Bun.spawn(['bun', '--bun', VITE_BIN, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdin: 'ignore',
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

	test('awaiting a member reads the property, and calling it invokes the method', async () => {
		const res = await fetch(`${base}/aux`)
		if (res.status !== 200) throw new Error(`GET /aux returned ${res.status}: ${await res.text()}\n--- server output ---\n${log.get()}`)
		expect(await res.json()).toEqual({ version: '1.2.3', label: 'aux worker', double: 42 })
	}, 30_000)
})
