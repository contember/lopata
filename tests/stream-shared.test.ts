import { describe, expect, test } from 'bun:test'
import { OutboundStreamRegistry, pumpStream, StreamReceiver } from '../src/worker-thread/stream-shared'

describe('StreamReceiver', () => {
	test('late chunks after consumer cancel are dropped (no _pending leak)', async () => {
		const cancelled: number[] = []
		const recv = new StreamReceiver((id) => cancelled.push(id))
		const stream = recv.open(7)
		// Consumer cancel (no chunks received yet) — registers id in _cancelled.
		await stream.cancel()
		expect(cancelled).toEqual([7])

		// Late chunks from sender (which hadn't seen the cancel yet) must be
		// dropped silently — they MUST NOT re-create a _pending queue.
		recv.push(7, new Uint8Array([1]))
		recv.push(7, new Uint8Array([2]))
		// Terminator clears the stale id so the Set doesn't grow unbounded.
		recv.end(7)

		// Internal state proof: poke a fresh id and see only that one buffer.
		// (No public introspection — instead, the absence of a leak is shown by
		// observing that a *new* open() works normally with no spillover.)
		const r2 = recv.open(7)
		const reader = r2.getReader()
		recv.push(7, new Uint8Array([99]))
		recv.end(7)
		const first = await reader.read()
		expect(first.done).toBe(false)
		expect(Array.from(first.value!)).toEqual([99])
		const second = await reader.read()
		expect(second.done).toBe(true)
	})

	test('late end/error after consumer cancel are dropped (no _pending leak)', async () => {
		const cancelled: number[] = []
		const recv = new StreamReceiver((id) => cancelled.push(id))
		const stream = recv.open(42)
		await stream.cancel()
		expect(cancelled).toEqual([42])

		// Late error must not buffer or throw.
		recv.error(42, new Error('boom'))
		// After terminator, id is forgotten — a subsequent push to a different id
		// should still buffer normally.
		recv.push(99, new Uint8Array([7]))
		const s99 = recv.open(99)
		const reader = s99.getReader()
		recv.end(99)
		const r1 = await reader.read()
		expect(Array.from(r1.value!)).toEqual([7])
		const r2 = await reader.read()
		expect(r2.done).toBe(true)
	})

	test('explicit cancel(streamId) drops buffered events and signals onCancel', () => {
		const cancelled: number[] = []
		const recv = new StreamReceiver((id) => cancelled.push(id))
		// Sender pumped chunks before the receiver decided to abandon the stream
		// (e.g. dispatcher errored before opening a controller).
		recv.push(11, new Uint8Array([1, 2, 3]))
		recv.push(11, new Uint8Array([4]))
		// Receiver-side decision to cancel — no open() ever called.
		recv.cancel(11)
		expect(cancelled).toEqual([11])

		// Late chunks still get dropped.
		recv.push(11, new Uint8Array([5]))
		recv.end(11) // also clears stale id

		// And opening a fresh id with the same number works clean.
		const s = recv.open(11)
		const reader = s.getReader()
		recv.push(11, new Uint8Array([88]))
		recv.end(11)
		return reader.read().then((r) => {
			expect(Array.from(r.value!)).toEqual([88])
		})
	})

	test('disposeAll clears the _cancelled set', () => {
		const recv = new StreamReceiver(() => {})
		const s = recv.open(1)
		// fire-and-forget cancel — synchronous side effects are what we test
		void s.cancel()
		recv.disposeAll(new Error('teardown'))
		// After dispose, a fresh open() with the same id must accept events as if
		// new — the stale-id Set should be empty.
		const s2 = recv.open(1)
		const reader = s2.getReader()
		recv.push(1, new Uint8Array([9]))
		recv.end(1)
		return reader.read().then((r) => {
			expect(Array.from(r.value!)).toEqual([9])
		})
	})
})

describe('pumpStream', () => {
	test('cancels the source reader when isAlive flips false', async () => {
		let sourceCancelled = false
		// A never-ending source — without the cancel, this would pump forever.
		let pumpTimer: ReturnType<typeof setInterval> | null = null
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				let n = 0
				pumpTimer = setInterval(() => {
					try {
						controller.enqueue(new Uint8Array([n++ & 0xff]))
					} catch {
						if (pumpTimer) clearInterval(pumpTimer)
					}
				}, 5)
			},
			cancel() {
				sourceCancelled = true
				if (pumpTimer) clearInterval(pumpTimer)
			},
		})

		const registry = new OutboundStreamRegistry()
		const id = registry.allocateId()
		const posted: unknown[] = []
		let alive = true
		pumpStream(
			id,
			body,
			registry,
			(msg) => posted.push(msg),
			{
				chunk: (sid, c) => ({ type: 'chunk' as const, sid, c }),
				end: (sid) => ({ type: 'end' as const, sid }),
				error: (sid, err) => ({ type: 'error' as const, sid, err }),
			},
			() => alive,
		)

		// Let a few chunks flow, then flip alive=false.
		await new Promise((r) => setTimeout(r, 30))
		alive = false
		// Give the loop a tick to observe the isAlive flip and cancel the source.
		await new Promise((r) => setTimeout(r, 50))
		expect(sourceCancelled).toBe(true)
		if (pumpTimer) clearInterval(pumpTimer)
	})

	test('forwards zero-byte chunks (no silent drop)', async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1]))
				controller.enqueue(new Uint8Array(0)) // empty chunk
				controller.enqueue(new Uint8Array([2]))
				controller.close()
			},
		})
		const registry = new OutboundStreamRegistry()
		const id = registry.allocateId()
		const posted: { type: string; sid?: number; c?: Uint8Array }[] = []
		pumpStream(
			id,
			body,
			registry,
			(msg) => posted.push(msg as { type: string; sid?: number; c?: Uint8Array }),
			{
				chunk: (sid, c) => ({ type: 'chunk', sid, c }),
				end: (sid) => ({ type: 'end', sid }),
				error: (sid, err) => ({ type: 'error', sid, err: String(err) }),
			},
		)
		// Wait for the pump to drain.
		await new Promise((r) => setTimeout(r, 30))
		const chunks = posted.filter((m) => m.type === 'chunk')
		// All three chunks — including the empty one — must be posted.
		expect(chunks.length).toBe(3)
		expect(chunks[0]!.c!.byteLength).toBe(1)
		expect(chunks[1]!.c!.byteLength).toBe(0)
		expect(chunks[2]!.c!.byteLength).toBe(1)
		const last = posted[posted.length - 1] as { type: string }
		expect(last.type).toBe('end')
	})
})
