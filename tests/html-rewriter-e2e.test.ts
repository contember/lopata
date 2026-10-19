import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The global HTMLRewriter in every place lopata runs Worker code: the CLI runs the worker
 * in a worker thread, the Vite plugin runs it in the dev server's own thread, and both run
 * Durable Objects in their own threads. Each route reads a page streamed from a JS
 * ReadableStream, so the handlers only fire if the rewrite really runs.
 */

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/html-rewriter-worker')
const CLI_PATH = resolve(import.meta.dir, '../src/cli.ts')
const VITE_BIN = resolve(import.meta.dir, '../node_modules/.bin/vite')

/** Drains the dev server's output, so a full pipe cannot block it and a boot failure is readable. */
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

async function waitForServer(base: string, timeoutMs: number, log: OutputLog): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${base}/rewrite`)
			await res.text()
			if (res.ok) return
		} catch {
			// server not listening yet
		}
		await Bun.sleep(250)
	}
	throw new Error(`Server ${base} did not become ready within ${timeoutMs}ms\n--- server output ---\n${log.get()}`)
}

function cleanup() {
	rmSync(resolve(FIXTURE_DIR, '.lopata'), { recursive: true, force: true })
}

const modes = [
	{ name: 'CLI', port: 18890, command: (port: number) => ['bun', CLI_PATH, 'dev', '--port', String(port)] },
	{ name: 'Vite plugin', port: 18891, command: (port: number) => ['bun', '--bun', VITE_BIN, 'dev', '--port', String(port)] },
]

for (const mode of modes) {
	describe(`HTMLRewriter E2E — ${mode.name}`, () => {
		const base = `http://localhost:${mode.port}`
		let proc: Subprocess<'ignore', 'pipe', 'pipe'>

		beforeAll(async () => {
			cleanup()
			proc = Bun.spawn(mode.command(mode.port), { cwd: FIXTURE_DIR, stdout: 'pipe', stderr: 'pipe' })
			await waitForServer(base, 60_000, new OutputLog(proc))
		}, 90_000)

		afterAll(() => {
			proc?.kill()
			cleanup()
		})

		test('handlers read the page in the worker, awaiting a Durable Object call', async () => {
			const res = await fetch(`${base}/read`)
			expect(await res.json()).toEqual({
				title: 'Docs &amp; guides',
				links: ['link:/a?x=1&amp;y=2', 'link:/b'],
			})
		})

		test('handlers read the page inside a Durable Object', async () => {
			const res = await fetch(`${base}/read-in-do`)
			expect(await res.json()).toEqual({
				title: 'Docs &amp; guides',
				links: ['do:/a?x=1&amp;y=2', 'do:/b'],
			})
		})

		test('a transformed response is served with the rewritten body', async () => {
			const res = await fetch(`${base}/rewrite`)
			expect(res.headers.get('content-type')).toBe('text/html')
			expect(await res.text()).toBe(
				'<!DOCTYPE html><html><head><title>Docs &amp; guides</title></head>'
					+ '<body><a href="/a?x=1&amp;y=2" rel="nofollow">A</a>[draft]<a href="/b" rel="nofollow">B</a></body></html>',
			)
		})
	})
}
