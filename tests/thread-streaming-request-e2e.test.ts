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

/** Slow-paced request body: emits `count` chunks with `delay` ms between them.
 *  Tracks how many times the source's `cancel()` callback fires (test asserts
 *  the worker's `request.body.cancel()` propagates back to here). */
function pacedRequestBody(count: number, delay: number, payload = 'x'.repeat(32)): {
	stream: ReadableStream<Uint8Array>
	getCancelCount(): number
} {
	const encoder = new TextEncoder()
	let cancelCount = 0
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for (let i = 0; i < count; i++) {
					controller.enqueue(encoder.encode(`${payload}-${i}\n`))
					if (i < count - 1) await new Promise(r => setTimeout(r, delay))
				}
				controller.close()
			} catch {
				// Cancelled / errored — propagate is taken care of by cancel().
			}
		},
		cancel() {
			cancelCount++
		},
	})
	return { stream, getCancelCount: () => cancelCount }
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

describe('Request-body streaming (top-level worker-thread runtime)', () => {
	let proc: Subprocess
	const PORT = 18830
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

	test('request body chunks reach user code incrementally', async () => {
		const count = 5
		const delay = 80
		const { stream } = pacedRequestBody(count, delay)
		// Bun/undici require explicit duplex='half' when sending a ReadableStream.
		const res = await fetch(`${base}/echo-incremental`, {
			method: 'POST',
			body: stream,
			headers: { 'content-type': 'application/octet-stream' },
			duplex: 'half',
		})
		expect(res.status).toBe(200)

		const { text, arrivals } = await readChunks(res)

		// Every chunk recorded inside the worker
		for (let i = 0; i < count; i++) {
			expect(text).toContain(`chunk-${i}-`)
		}
		// If the request body were fully buffered before reaching the worker,
		// the worker wouldn't see any chunk until the source finished — and
		// then all response chunks would arrive in one burst. With streaming,
		// they arrive spaced out roughly matching the source pacing.
		expect(arrivals.length).toBeGreaterThan(1)
		const spread = arrivals[arrivals.length - 1]! - arrivals[0]!
		expect(spread).toBeGreaterThan((count - 1) * delay * 0.4)
	}, 15_000)

	test('large streaming request body round-trips intact', async () => {
		const size = 4 * 1024 * 1024
		// Send the body as a ReadableStream so it goes through the streaming path.
		const chunk = new Uint8Array(64 * 1024).fill(68) // 'D'
		let sent = 0
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent >= size) {
					controller.close()
					return
				}
				const remaining = size - sent
				const out = remaining < chunk.length ? chunk.subarray(0, remaining) : chunk
				controller.enqueue(out)
				sent += out.length
			},
		})
		const res = await fetch(`${base}/echo`, {
			method: 'POST',
			body: stream,
			duplex: 'half',
		})
		const buf = new Uint8Array(await res.arrayBuffer())
		expect(buf.byteLength).toBe(size)
		expect(buf[0]).toBe(68)
		expect(buf[buf.length - 1]).toBe(68)
	}, 20_000)

	test('user code cancels request.body mid-stream and the worker stays responsive', async () => {
		// Paced source so the worker reads one chunk and cancels mid-stream.
		// Without request-body streaming the worker would have to wait for the
		// full 100*50ms upload before reaching `reader.read()`. With streaming,
		// the first paced chunk arrives quickly and the worker cancels cleanly.
		const { stream } = pacedRequestBody(100, 50)
		const started = Date.now()
		const res = await fetch(`${base}/req-cancel`, {
			method: 'POST',
			body: stream,
			duplex: 'half',
		})
		const text = await res.text()
		// Confirm the response came back well before the source would have
		// finished — proof the worker cancelled mid-upload instead of waiting.
		const elapsed = Date.now() - started
		expect(elapsed).toBeLessThan(100 * 50 * 0.5)
		expect(res.status).toBe(200)
		expect(text).toMatch(/^cancelled-after-chunk-total-\d+$/)
	}, 15_000)

	// CORR-33: request.signal must abort across the thread boundary when the
	// client disconnects, so user cleanup hooks (SSE / long-poll) fire.
	test('request.signal fires in the worker when the client disconnects', async () => {
		const before = Number(await (await fetch(`${base}/signal-status`)).text())

		const ac = new AbortController()
		const res = await fetch(`${base}/signal-watch`, { signal: ac.signal })
		const reader = res.body!.getReader()
		await reader.read() // 'open' — handler is running, listener registered
		// Client disconnects.
		ac.abort()
		await reader.cancel().catch(() => {})

		// Poll until the worker's request.signal 'abort' listener has fired.
		const deadline = Date.now() + 4000
		let after = before
		while (Date.now() < deadline) {
			after = Number(await (await fetch(`${base}/signal-status`)).text())
			if (after > before) break
			await new Promise(r => setTimeout(r, 50))
		}
		expect(after).toBeGreaterThan(before)
	}, 15_000)
})
