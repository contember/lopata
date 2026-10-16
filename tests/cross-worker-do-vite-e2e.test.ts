import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Durable Object bindings with `script_name` under the Vite plugin: the main worker and its
 * Durable Objects run in the dev-server process, the auxiliary worker and its Durable Objects
 * in their own threads. The workers are those of the `cross-worker-do` CLI fixture.
 */

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/cross-worker-do-vite')
const VITE_BIN = resolve(import.meta.dir, '../node_modules/.bin/vite')
const PORT = 18881
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
}

describe('Durable Objects shared across workers under the Vite plugin', () => {
	let proc: Subprocess<'ignore', 'pipe', 'pipe'>
	let log: OutputLog

	async function getJson(path: string): Promise<unknown> {
		const res = await fetch(`${base}${path}`)
		if (res.status !== 200) throw new Error(`GET ${path} returned ${res.status}: ${await res.text()}\n--- server output ---\n${log.get()}`)
		return res.json()
	}

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

	const receipt = (total: number) => ({ total, atIsDate: true, tagsIsSet: true, tags: ['a', 'b'] })

	test("the auxiliary worker reaches the main worker's class before any request reached the main worker", async () => {
		expect(await getJson('/mailbox/call-ledger/rpc')).toEqual(receipt(5))
	}, 30_000)

	test("the main worker calls the auxiliary worker's class, and both reach the same instances", async () => {
		expect(await getJson('/call-mailbox/rpc')).toEqual(receipt(5))
		expect(await getJson('/mailbox/own/total')).toBe(5)
		expect(await getJson('/own/total')).toBe(5)
		expect(await getJson('/call-mailbox/id')).toBe(await getJson('/mailbox/own/id'))
	}, 30_000)

	test('errors, fetch() and streamed responses cross in both directions', async () => {
		expect(await getJson('/call-mailbox/error')).toEqual({ threw: true, name: 'TypeError', message: 'mailbox is full' })
		expect(await getJson('/mailbox/call-ledger/error')).toEqual({ threw: true, name: 'RangeError', message: 'ledger is closed' })
		expect(await getJson('/call-mailbox/fetch')).toEqual({ status: 200, host: 'mailbox', text: 'mailbox:POST:payload' })
		expect(await getJson('/mailbox/call-ledger/fetch')).toEqual({ status: 200, host: 'ledger', text: 'ledger:POST:payload' })
		expect(await (await fetch(`${base}/mailbox/call-ledger/stream`)).text()).toBe('ledger:GET:')
	}, 30_000)

	test("a Durable Object of the auxiliary worker calls the main worker's class", async () => {
		expect(await getJson('/call-mailbox/ledger-from-do')).toBe(5)
	}, 30_000)

	test('the auxiliary worker applies its wrangler rules', async () => {
		expect(await getJson('/mailbox/modules')).toEqual({ prompt: '# Welcome\n\nThis prompt is a Text module.\n', sum: 5 })
	}, 30_000)
})
