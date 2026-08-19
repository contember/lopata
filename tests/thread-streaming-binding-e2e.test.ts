import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/thread-streaming-binding')
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

async function readChunks(res: Response): Promise<string> {
	const reader = res.body!.getReader()
	const decoder = new TextDecoder()
	let text = ''
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		if (value?.length) text += decoder.decode(value, { stream: true })
	}
	return text + decoder.decode()
}

describe('Response streaming through service-binding (cross-thread)', () => {
	let proc: Subprocess
	const PORT = 18820
	const base = `http://localhost:${PORT}`

	beforeAll(async () => {
		cleanup()
		proc = spawnDev(PORT)
		await waitForServer(`${base}/sse?count=1`, 15_000)
	}, 20_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	// Ack-gated rather than timed: aux withholds event i+1 until this reader has
	// acked event i, so seeing all `count` events *is* the proof that nothing
	// buffered the body — a buffering hop would starve the acks and aux would
	// emit `stalled-waiting-ack-*` instead. There is deliberately no wall-clock
	// threshold: a loaded runner that reads a healthy stream in one burst is
	// indistinguishable from a buffered one by arrival times, which is exactly
	// how the previous spread assertion failed a release.
	test('SSE through a service binding arrives incrementally, not buffered', async () => {
		const count = 5
		const res = await fetch(`${base}/sse?count=${count}`)
		expect(res.headers.get('content-type')).toContain('text/event-stream')

		const reader = res.body!.getReader()
		const decoder = new TextDecoder()
		let text = ''
		const acked = new Set<number>()
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			if (!value?.length) continue
			text += decoder.decode(value, { stream: true })
			for (const m of text.matchAll(/data: event-(\d+)/g)) {
				const n = Number(m[1]!)
				if (acked.has(n)) continue
				acked.add(n)
				await fetch(`${base}/sse-ack?n=${n}`)
			}
		}
		text += decoder.decode()

		expect(text).not.toContain('stalled-waiting-ack')
		for (let i = 0; i < count; i++) {
			expect(text).toContain(`data: event-${i}`)
		}
		expect(acked.size).toBe(count)
	}, 15_000)

	test('large body through a service binding round-trips intact', async () => {
		const size = 4 * 1024 * 1024
		const res = await fetch(`${base}/large?size=${size}`)
		const buf = await res.arrayBuffer()
		expect(buf.byteLength).toBe(size)
		const bytes = new Uint8Array(buf)
		expect(bytes[0]).toBe(67) // 'C'
		expect(bytes[bytes.length - 1]).toBe(67)
	}, 20_000)

	test('request body chunks reach the bound worker incrementally', async () => {
		const count = 5
		const delay = 80
		const encoder = new TextEncoder()
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				for (let i = 0; i < count; i++) {
					controller.enqueue(encoder.encode(`x-${i}\n`))
					if (i < count - 1) await new Promise(r => setTimeout(r, delay))
				}
				controller.close()
			},
		})
		const res = await fetch(`${base}/echo-incremental`, {
			method: 'POST',
			body: stream,
			duplex: 'half',
		})
		const text = await readChunks(res)
		for (let i = 0; i < count; i++) {
			expect(text).toContain(`chunk-${i}-`)
		}
		// Timing is read from the `-at-<ms>` stamps aux writes into each echoed
		// line, i.e. when the *bound worker* received each chunk. Client-side
		// arrival times cannot be used here: if this process is descheduled the
		// whole response piles up in the socket and is read in one burst, which is
		// indistinguishable from a buffering bridge. Measuring at the far end is
		// load-proof — a slow runner can only stretch the gaps aux observes, never
		// compress them below the producer's own delays.
		const stamps = [...text.matchAll(/-at-(\d+)/g)].map(m => Number(m[1]!))
		expect(stamps.length).toBe(count)
		const spread = stamps[stamps.length - 1]! - stamps[0]!
		expect(spread).toBeGreaterThan((count - 1) * delay * 0.4)
	}, 15_000)

	test('large request body through a service binding round-trips intact', async () => {
		const size = 4 * 1024 * 1024
		const chunk = new Uint8Array(64 * 1024).fill(69) // 'E'
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
		expect(buf[0]).toBe(69)
		expect(buf[buf.length - 1]).toBe(69)
	}, 20_000)

	test('cancel propagates: dropping the response body cancels the source', async () => {
		// Baseline: how many times has the source been cancelled so far?
		const before = Number(await (await fetch(`${base}/cancel-count`)).text())

		const ac = new AbortController()
		const res = await fetch(`${base}/infinite`, { signal: ac.signal })
		const reader = res.body!.getReader()
		// Pull a few chunks so we know the stream is actually flowing.
		await reader.read()
		await reader.read()
		ac.abort()
		await reader.cancel().catch(() => {})

		// Give the cancel a moment to propagate through worker → main → aux's
		// ReadableStream cancel callback.
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
