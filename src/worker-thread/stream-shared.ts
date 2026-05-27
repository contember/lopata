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

export class OutboundStreamRegistry {
	private _nextStreamId = 1
	private _readers = new Map<number, { cancel(reason?: unknown): Promise<unknown> }>()

	allocateId(): number {
		return this._nextStreamId++
	}

	register(streamId: number, reader: { cancel(reason?: unknown): Promise<unknown> }): void {
		this._readers.set(streamId, reader)
	}

	complete(streamId: number): void {
		this._readers.delete(streamId)
	}

	/** Receiver-side cancel arrived — stop the source pump if still running. */
	cancel(streamId: number): void {
		const r = this._readers.get(streamId)
		if (!r) return
		this._readers.delete(streamId)
		r.cancel().catch(() => {})
	}

	disposeAll(): void {
		for (const [, r] of this._readers) r.cancel().catch(() => {})
		this._readers.clear()
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
export class StreamReceiver {
	private _controllers = new Map<number, ReadableStreamDefaultController<Uint8Array>>()
	private _pending = new Map<number, StreamEvent[]>()
	private _cancelled = new Set<number>()
	private _onCancel: (streamId: number) => void

	constructor(onCancel: (streamId: number) => void) {
		this._onCancel = onCancel
	}

	open(streamId: number): ReadableStream<Uint8Array> {
		return new ReadableStream<Uint8Array>({
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
				this._cancelled.add(streamId)
				this._onCancel(streamId)
			},
		})
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
		if (ev.kind !== 'chunk') this._controllers.delete(streamId)
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
): void {
	const reader = body.getReader()
	registry.register(streamId, reader)
	void (async () => {
		try {
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
				if (value) post(envelopes.chunk(streamId, value))
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
