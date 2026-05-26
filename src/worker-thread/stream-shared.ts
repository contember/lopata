/**
 * Cross-thread stream plumbing — sender and receiver primitives used by every
 * worker channel (top-level user-worker fetch, DO instance fetch, unified
 * cross-thread binding-fetch RPC) on both request and response sides.
 *
 * `OutboundStreamRegistry` tracks active source pumps so an inbound cancel can
 * stop the reader. `StreamReceiver` reconstructs a `ReadableStream` on the
 * receiving end, buffering chunks that race ahead of `start()` (the controller
 * only registers when the consumer pulls the body, which on Bun lands after
 * the first chunk message in some interleavings).
 */

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
				this._onCancel(streamId)
			},
		})
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
	}

	private _onEvent(streamId: number, ev: StreamEvent): void {
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
