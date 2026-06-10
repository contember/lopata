/**
 * Cross-thread stream plumbing — sender and receiver primitives used by every
 * worker channel (top-level user-worker fetch, DO instance fetch, unified
 * cross-thread binding-fetch RPC) on both request and response sides.
 *
 * `OutboundStreamRegistry` tracks active source pumps so an inbound cancel can
 * stop the reader. `StreamReceiver` reconstructs a `ReadableStream` on the
 * receiving end, buffering chunks that race ahead of `start()` (the controller
 * only registers when the consumer pulls the body, which on Bun lands after
 * the first chunk message in some interleavings). `pumpStream` is the
 * symmetric sender-side helper: it consumes a `ReadableStream`, registers the
 * source reader so an inbound cancel can stop it, and posts channel-specific
 * envelope messages until the body completes or errors.
 */

import type { SerializedError } from './protocol'
import { serializeError } from './protocol'

/**
 * Default cross-thread backpressure window (chunk count) for response-body
 * streams. Bounds in-flight chunks so a fast producer (e.g. proxying a large R2
 * object, a tight SSE/generated stream) can't race ahead of a slow consumer and
 * grow memory unbounded. Small enough to bound memory, large enough to keep the
 * pipe full across the postMessage round-trip.
 */
export const STREAM_BACKPRESSURE_WINDOW = 8

interface OutboundStreamState {
	reader: { cancel(reason?: unknown): Promise<unknown> }
	/** Remaining permits to post a chunk. `Infinity` = no backpressure (eager,
	 *  the default for channels that don't opt in). */
	credits: number
	/** Resolver for a pump parked in `acquireCredit`, waiting for a grant. */
	waiter: (() => void) | null
}

export class OutboundStreamRegistry {
	private _nextStreamId = 1
	private _streams = new Map<number, OutboundStreamState>()

	allocateId(): number {
		return this._nextStreamId++
	}

	/** Number of source pumps still running. Reload drain consults this so an
	 *  in-flight upload / response-body pump isn't force-terminated mid-stream. */
	activeCount(): number {
		return this._streams.size
	}

	register(
		streamId: number,
		reader: { cancel(reason?: unknown): Promise<unknown> },
		initialCredits: number = Number.POSITIVE_INFINITY,
	): void {
		this._streams.set(streamId, { reader, credits: initialCredits, waiter: null })
	}

	/**
	 * Sender: take one permit to post a chunk, parking until the receiver grants
	 * one if none are left. Returns `false` if the stream was cancelled/disposed
	 * while parked (the pump should stop). With the default `Infinity` credits
	 * this never blocks — eager behavior, unchanged.
	 */
	async acquireCredit(streamId: number): Promise<boolean> {
		const s = this._streams.get(streamId)
		if (!s) return false
		if (s.credits > 0) {
			s.credits--
			return true
		}
		await new Promise<void>((resolve) => {
			s.waiter = resolve
		})
		const after = this._streams.get(streamId)
		if (!after) return false // cancelled/disposed while parked
		if (after.credits > 0) after.credits--
		return true
	}

	/** Receiver granted `n` more permits — replenish and wake a parked pump. */
	grantCredit(streamId: number, n = 1): void {
		const s = this._streams.get(streamId)
		if (!s) return
		s.credits += n
		const w = s.waiter
		if (w) {
			s.waiter = null
			w()
		}
	}

	complete(streamId: number): void {
		this._streams.delete(streamId)
	}

	/** Receiver-side cancel arrived — stop the source pump if still running. */
	cancel(streamId: number): void {
		const s = this._streams.get(streamId)
		if (!s) return
		this._streams.delete(streamId)
		// Wake a parked pump so it exits instead of hanging on a grant that will
		// never come.
		const w = s.waiter
		if (w) {
			s.waiter = null
			w()
		}
		s.reader.cancel().catch(() => {})
	}

	disposeAll(): void {
		for (const [, s] of this._streams) {
			const w = s.waiter
			if (w) {
				s.waiter = null
				w()
			}
			s.reader.cancel().catch(() => {})
		}
		this._streams.clear()
	}
}

/**
 * Receiver-side state for an inbound stream channel. Holds open `ReadableStream`
 * controllers keyed by streamId and a small per-streamId pending-events queue
 * for chunks that arrive before the consumer's `start()` registers the
 * controller.
 *
 * Wiring code (each channel's `onmessage` dispatcher) routes channel-specific
 * `*-chunk` / `*-end` / `*-error` messages into {@link push} / {@link end} /
 * {@link error}. The `onCancel` callback is invoked when the consumer cancels
 * the reconstructed stream, so the wiring code can post the channel-specific
 * `*-cancel` message back to the sender.
 */
export interface StreamReceiverOptions {
	/**
	 * Enable cross-thread backpressure. When set, the reconstructed
	 * `ReadableStream` uses this as its highWaterMark (chunk count) and the
	 * receiver grants the sender a credit (via {@link StreamReceiverOptions.onCredit})
	 * as it pulls — bounding the number of in-flight chunks instead of letting a
	 * fast producer race ahead and grow memory unbounded. Omit for eager
	 * (unbounded) behavior — the default.
	 */
	window?: number
	/** Post the channel-specific `*-stream-ack` message granting one credit. Only
	 *  consulted when `window` is set. */
	onCredit?: (streamId: number) => void
}

export class StreamReceiver {
	private _controllers = new Map<number, ReadableStreamDefaultController<Uint8Array>>()
	private _pending = new Map<number, StreamEvent[]>()
	private _cancelled = new Set<number>()
	/** Streams reconstructed via `open()` that haven't reached a terminal event
	 *  (end/error/cancel) yet. Reload drain consults `activeCount()` so a response
	 *  the client is still downloading (SSE, large proxy) isn't cut off mid-body. */
	private _open = new Set<number>()
	private _onCancel: (streamId: number) => void
	private _window?: number
	private _onCredit?: (streamId: number) => void

	constructor(onCancel: (streamId: number) => void, options: StreamReceiverOptions = {}) {
		this._onCancel = onCancel
		this._window = options.window
		this._onCredit = options.onCredit
	}

	/** Number of reconstructed streams not yet terminated. */
	activeCount(): number {
		return this._open.size
	}

	open(streamId: number): ReadableStream<Uint8Array> {
		this._open.add(streamId)
		type Source = {
			start: (controller: ReadableStreamDefaultController<Uint8Array>) => void
			pull?: (controller: ReadableStreamDefaultController<Uint8Array>) => void
			cancel?: (reason?: unknown) => void
		}
		const source: Source = {
			start: (controller) => {
				this._controllers.set(streamId, controller)
				const pending = this._pending.get(streamId)
				if (pending) {
					this._pending.delete(streamId)
					for (const ev of pending) this._apply(streamId, controller, ev)
				}
			},
			cancel: () => {
				this._controllers.delete(streamId)
				this._pending.delete(streamId)
				this._open.delete(streamId)
				this._cancelled.add(streamId)
				this._onCancel(streamId)
			},
		}
		// Backpressure mode: bound the queue and grant the sender a credit each
		// time the stream pulls (i.e. has room). `pull` returns undefined, so the
		// stream calls it once per drain rather than spinning. Eager mode (no
		// window) keeps the original unbounded behavior.
		if (this._window !== undefined && this._onCredit) {
			const onCredit = this._onCredit
			source.pull = () => {
				onCredit(streamId)
			}
			return new ReadableStream<Uint8Array>(source, new CountQueuingStrategy({ highWaterMark: this._window }))
		}
		return new ReadableStream<Uint8Array>(source)
	}

	/**
	 * Receiver-side cancel for an inbound stream that never reached a consumer
	 * (e.g. dispatcher errored before `open()` registered the controller, or the
	 * request was torn down post-open). Drops any buffered events, marks the id
	 * stale so late chunks are ignored, and signals the sender via `onCancel`.
	 */
	cancel(streamId: number): void {
		this._controllers.delete(streamId)
		this._pending.delete(streamId)
		this._open.delete(streamId)
		this._cancelled.add(streamId)
		this._onCancel(streamId)
	}

	push(streamId: number, chunk: Uint8Array): void {
		this._onEvent(streamId, { kind: 'chunk', chunk })
	}

	end(streamId: number): void {
		this._onEvent(streamId, { kind: 'end' })
	}

	error(streamId: number, err: Error): void {
		this._onEvent(streamId, { kind: 'error', error: err })
	}

	disposeAll(err: Error): void {
		for (const [, controller] of this._controllers) {
			try {
				controller.error(err)
			} catch {}
		}
		this._controllers.clear()
		this._pending.clear()
		this._cancelled.clear()
		this._open.clear()
	}

	private _onEvent(streamId: number, ev: StreamEvent): void {
		if (this._cancelled.has(streamId)) {
			// Consumer cancelled the reconstructed stream — drop racing late events
			// from the sender (it hadn't yet seen the cancel). Forget the id once
			// the sender's terminator arrives so we don't grow the Set unbounded.
			if (ev.kind !== 'chunk') this._cancelled.delete(streamId)
			return
		}
		const controller = this._controllers.get(streamId)
		if (!controller) {
			let q = this._pending.get(streamId)
			if (!q) {
				q = []
				this._pending.set(streamId, q)
			}
			q.push(ev)
			return
		}
		this._apply(streamId, controller, ev)
	}

	private _apply(
		streamId: number,
		controller: ReadableStreamDefaultController<Uint8Array>,
		ev: StreamEvent,
	): void {
		try {
			if (ev.kind === 'chunk') {
				controller.enqueue(ev.chunk)
				return
			}
			if (ev.kind === 'end') controller.close()
			else controller.error(ev.error)
		} catch {
			// Already closed/errored (consumer cancelled) — drop.
		}
		if (ev.kind !== 'chunk') {
			this._controllers.delete(streamId)
			this._open.delete(streamId)
		}
	}
}

type StreamEvent =
	| { kind: 'chunk'; chunk: Uint8Array }
	| { kind: 'end' }
	| { kind: 'error'; error: Error }

/**
 * Channel-specific envelope builders. Each callsite supplies its own message
 * shapes (e.g. `{ type: 'stream-chunk', id, chunk }` vs `{ type:
 * 'do-stream-chunk', streamId, chunk }`); the pump loop itself is identical.
 */
export interface PumpEnvelopes<TChunk, TEnd, TError> {
	chunk: (streamId: number, chunk: Uint8Array) => TChunk
	end: (streamId: number) => TEnd
	error: (streamId: number, error: SerializedError) => TError
}

/**
 * Read a body to completion and post channel-specific envelopes for each
 * chunk + the terminator. The reader is registered with `registry` so an
 * inbound cancel can stop the source; `complete()` runs on every exit path.
 *
 * `isAlive` is optional — worker-side callers omit it (worker termination
 * kills the loop). Main-side callers pass a closure over their disposal flag
 * so a posted message after teardown is dropped at the source (matches the
 * pre-refactor main-side pumps).
 */
export function pumpStream<TChunk, TEnd, TError>(
	streamId: number,
	body: ReadableStream<Uint8Array>,
	registry: OutboundStreamRegistry,
	post: (msg: TChunk | TEnd | TError) => void,
	envelopes: PumpEnvelopes<TChunk, TEnd, TError>,
	isAlive?: () => boolean,
	/** When set, post at most `window` chunks ahead of the receiver's credits
	 *  (cross-thread backpressure). Requires the receiver's `StreamReceiver` to be
	 *  constructed with a matching `window` + `onCredit`. Omit for eager. */
	window?: number,
): void {
	void (async () => {
		try {
			// `getReader()` throws synchronously on a locked/disturbed body — e.g. the
			// user did `await res.text()` then returned `res`. Doing it inside the try
			// (rather than before the IIFE) surfaces that to the receiver as a stream
			// error instead of letting the throw escape AFTER the headers/result were
			// already posted, which would leave the consumer hanging on a body that
			// never produces a chunk or terminator. Runs synchronously (before the
			// first await), so registration stays synchronous as before.
			const reader = body.getReader()
			registry.register(streamId, reader, window ?? Number.POSITIVE_INFINITY)
			while (true) {
				const { done, value } = await reader.read()
				if (isAlive && !isAlive()) {
					// Channel torn down between this read and posting — release the
					// source so it doesn't stay locked. `finally` removes us from the
					// registry, so `disposeAll` won't see this reader.
					reader.cancel().catch(() => {})
					return
				}
				if (done) break
				if (value) {
					// Backpressure: park until the receiver has room. No-op (immediate)
					// for eager streams (Infinity credits).
					const ok = await registry.acquireCredit(streamId)
					if (!ok) {
						// Cancelled or disposed while parked. On a receiver-initiated cancel
						// the channel is still alive — post a terminator so the receiver
						// clears its cancelled-stream bookkeeping (`_cancelled`) instead of
						// leaking the id until the next `disposeAll`. On teardown
						// (`isAlive()` false) posting is moot. Worker-side pumps omit
						// `isAlive` and only reach here via a receiver cancel, so they post.
						if (!isAlive || isAlive()) post(envelopes.end(streamId))
						reader.cancel().catch(() => {})
						return
					}
					if (isAlive && !isAlive()) {
						reader.cancel().catch(() => {})
						return
					}
					post(envelopes.chunk(streamId, value))
				}
			}
			if (isAlive && !isAlive()) {
				reader.cancel().catch(() => {})
				return
			}
			post(envelopes.end(streamId))
		} catch (e) {
			if (isAlive && !isAlive()) return
			post(envelopes.error(streamId, serializeError(e)))
		} finally {
			registry.complete(streamId)
		}
	})()
}
