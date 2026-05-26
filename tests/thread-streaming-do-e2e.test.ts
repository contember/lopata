import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/thread-streaming-do')
const CLI_PATH = resolve(import.meta.dir, '../src/cli.ts')

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
	try {
		rmSync(resolve(FIXTURE_DIR, '.lopata'), { recursive: true, force: true })
	} catch {}
}

function spawnDev(port: number): Subprocess {
	return Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(port)], {
		cwd: FIXTURE_DIR,
		stdout: 'pipe',
		stderr: 'pipe',
	})
}

async function readChunks(res: Response): Promise<{ text: string; arrivals: number[] }> {
	const reader = res.body!.getReader()
	const decoder = new TextDecoder()
	let text = ''
	const arrivals: number[] = []
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		if (value?.length) {
			arrivals.push(Date.now())
			text += decoder.decode(value, { stream: true })
		}
	}
	text += decoder.decode()
	return { text, arrivals }
}

describe('Response streaming through DO instance fetch (cross-thread)', () => {
	let proc: Subprocess
	const PORT = 18821
	const base = `http://localhost:${PORT}`

	beforeAll(async () => {
		cleanup()
		proc = spawnDev(PORT)
		await waitForServer(`${base}/sse?count=1&delay=0`, 20_000)
	}, 25_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	test('SSE through a DO arrives incrementally, not buffered', async () => {
		const count = 5
		const delay = 80
		const res = await fetch(`${base}/sse?count=${count}&delay=${delay}`)
		expect(res.headers.get('content-type')).toContain('text/event-stream')

		const { text, arrivals } = await readChunks(res)

		for (let i = 0; i < count; i++) {
			expect(text).toContain(`data: event-${i}`)
		}
		expect(arrivals.length).toBeGreaterThan(1)
		const spread = arrivals[arrivals.length - 1]! - arrivals[0]!
		// If the DOResult had buffered the body, every chunk would land in one burst.
		expect(spread).toBeGreaterThan((count - 1) * delay * 0.4)
	}, 15_000)

	test('large body through a DO round-trips intact', async () => {
		const size = 4 * 1024 * 1024
		const res = await fetch(`${base}/large?size=${size}`)
		const buf = await res.arrayBuffer()
		expect(buf.byteLength).toBe(size)
		const bytes = new Uint8Array(buf)
		expect(bytes[0]).toBe(67) // 'C'
		expect(bytes[bytes.length - 1]).toBe(67)
	}, 20_000)

	test('cancel propagates: dropping the response body cancels the source inside the DO', async () => {
		const before = Number(await (await fetch(`${base}/cancel-count`)).text())

		const ac = new AbortController()
		const res = await fetch(`${base}/infinite`, { signal: ac.signal })
		const reader = res.body!.getReader()
		// Pull a few chunks so we know the stream is actually flowing.
		await reader.read()
		await reader.read()
		ac.abort()
		await reader.cancel().catch(() => {})

		// Give the cancel a moment to propagate: caller → user-worker (rpc-stream-cancel)
		// → main → DO worker (do-stream-cancel) → ReadableStream.cancel callback.
		const deadline = Date.now() + 3000
		let after = before
		while (Date.now() < deadline) {
			after = Number(await (await fetch(`${base}/cancel-count`)).text())
			if (after > before) break
			await new Promise(r => setTimeout(r, 50))
		}
		expect(after).toBeGreaterThan(before)
	}, 15_000)
})
