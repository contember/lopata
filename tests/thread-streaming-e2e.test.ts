import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/thread-streaming-worker')
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

/** Read a response body to completion, recording the wall-clock arrival time of
 *  each chunk so tests can prove delivery was incremental (not buffered). */
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

describe('Response streaming (worker-thread runtime)', () => {
	let proc: Subprocess
	const PORT = 18810
	const base = `http://localhost:${PORT}`

	beforeAll(async () => {
		cleanup()
		proc = spawnDev(PORT)
		await waitForServer(`${base}/sse?count=1&delay=0`, 15_000)
	}, 20_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	test('SSE events are delivered incrementally, not buffered', async () => {
		const count = 5
		const delay = 80
		const res = await fetch(`${base}/sse?count=${count}&delay=${delay}`)
		expect(res.headers.get('content-type')).toContain('text/event-stream')

		const { text, arrivals } = await readChunks(res)

		// All events present and the stream closed cleanly.
		for (let i = 0; i < count; i++) {
			expect(text).toContain(`data: event-${i}`)
		}
		// Delivered over time: if the bridge buffered the whole body, every chunk
		// would land in one burst. Require the spread to cover a meaningful
		// fraction of the expected total emit time.
		expect(arrivals.length).toBeGreaterThan(1)
		const spread = arrivals[arrivals.length - 1]! - arrivals[0]!
		expect(spread).toBeGreaterThan((count - 1) * delay * 0.4)
	}, 15_000)

	test('large streamed body round-trips intact', async () => {
		const size = 8 * 1024 * 1024
		const res = await fetch(`${base}/large?size=${size}`)
		const buf = await res.arrayBuffer()
		expect(buf.byteLength).toBe(size)
		const bytes = new Uint8Array(buf)
		expect(bytes[0]).toBe(65)
		expect(bytes[bytes.length - 1]).toBe(65)
	}, 20_000)

	test('request body round-trips through the worker boundary', async () => {
		const payload = new Uint8Array(256 * 1024).fill(66)
		const res = await fetch(`${base}/echo`, { method: 'POST', body: payload })
		const buf = new Uint8Array(await res.arrayBuffer())
		expect(buf.byteLength).toBe(payload.byteLength)
		expect(buf[0]).toBe(66)
		expect(buf[buf.length - 1]).toBe(66)
	}, 15_000)

	test('aborting an unbounded stream leaves the server responsive', async () => {
		const ac = new AbortController()
		const res = await fetch(`${base}/infinite`, { signal: ac.signal })
		const reader = res.body!.getReader()
		// Consume a few chunks then abort — should propagate a cancel to the worker.
		await reader.read()
		await reader.read()
		ac.abort()
		await reader.cancel().catch(() => {})

		// A subsequent request must still succeed (no deadlock / wedged worker).
		const after = await fetch(`${base}/sse?count=2&delay=0`)
		const text = await after.text()
		expect(text).toContain('data: event-0')
		expect(text).toContain('data: event-1')
	}, 15_000)
})

describe('Worker crash handling (worker-thread runtime)', () => {
	let proc: Subprocess
	const PORT = 18811
	const base = `http://localhost:${PORT}`

	beforeAll(async () => {
		cleanup()
		proc = spawnDev(PORT)
		await waitForServer(`${base}/sse?count=1&delay=0`, 15_000)
	}, 20_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	test('in-flight request rejects (does not hang) when the worker thread crashes', async () => {
		// Without the executor's onerror -> reject-pending fix this never settles.
		const started = Date.now()
		let settled = false
		try {
			const res = await fetch(`${base}/crash`)
			settled = true
			// dev server surfaces the dead worker as a 5xx
			expect(res.status).toBeGreaterThanOrEqual(500)
		} catch {
			// connection reset is also an acceptable "settled, not hung" outcome
			settled = true
		}
		expect(settled).toBe(true)
		expect(Date.now() - started).toBeLessThan(5_000)
	}, 10_000)
})
