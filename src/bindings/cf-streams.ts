/**
 * Cloudflare-specific stream classes: IdentityTransformStream and FixedLengthStream.
 */

// Bun's global stream typings omit byte streams; node:stream/web exports the same classes with full typings.
import { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { ReadableStreamBYOBReader as WebBYOBReader, ReadableStreamReadResult } from 'node:stream/web'

/**
 * IdentityTransformStream — passes bytes through unchanged.
 * Functionally equivalent to `new TransformStream()` but semantically indicates byte stream passthrough.
 */
export class IdentityTransformStream extends TransformStream<Uint8Array, Uint8Array> {}

/**
 * FixedLengthStream — enforces exact byte count.
 * Errors if total bytes written exceed `expectedLength` or if closed before reaching it.
 */
export class FixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
	readonly expectedLength: number

	constructor(expectedLength: number | bigint) {
		const length = Number(expectedLength)
		if (!Number.isFinite(length) || length < 0) {
			throw new TypeError('FixedLengthStream requires a non-negative length')
		}

		let bytesWritten = 0

		super({
			transform(chunk, controller) {
				bytesWritten += chunk.byteLength
				if (bytesWritten > length) {
					controller.error(
						new TypeError(
							`FixedLengthStream: exceeded expected length of ${length} bytes (got ${bytesWritten})`,
						),
					)
					return
				}
				controller.enqueue(chunk)
			},
			flush(controller) {
				if (bytesWritten < length) {
					controller.error(
						new TypeError(
							`FixedLengthStream: stream closed with ${bytesWritten} bytes, expected ${length}`,
						),
					)
				}
			},
		})

		this.expectedLength = length
	}
}

/**
 * Streams constructed by JavaScript code (`new ReadableStream(...)`, subclasses included) and their tee branches.
 * workerd gives BYOB readers to its native streams (Request and Response bodies, IdentityTransformStream and
 * FixedLengthStream readables) but not to a JS stream without `type: 'bytes'`. Bun creates native streams without
 * calling the global constructor, so a stream outside this set is native.
 */
const jsStreams = new WeakSet<ReadableStream>()
let byobInstalled = false

/** The global constructor before `installByobReading()` replaces it. Runtime code builds the streams it hands to user code with this one, so they count as native. */
export const NativeReadableStream = ReadableStream

/**
 * BYOB reading as workerd offers it: native streams accept `getReader({ mode: 'byob' })` and BYOB readers have
 * `readAtLeast(min, view)`. Bun gives BYOB readers only to `type: 'bytes'` streams, so a native stream without a byte
 * source is read through a byte-stream adapter over a default reader of it. The adapter keeps the original stream
 * locked after the BYOB reader releases its lock.
 */
export function installByobReading(): void {
	if (byobInstalled) return
	byobInstalled = true
	const TrackedReadableStream: typeof ReadableStream = new Proxy(NativeReadableStream, {
		construct(target, args, newTarget): object {
			const stream: ReadableStream = Reflect.construct(target, args, newTarget === TrackedReadableStream ? target : newTarget)
			jsStreams.add(stream)
			return stream
		},
	})
	Object.defineProperty(NativeReadableStream.prototype, 'constructor', { value: TrackedReadableStream, writable: true, configurable: true })
	globalThis.ReadableStream = TrackedReadableStream

	const nativeGetReader = NativeReadableStream.prototype.getReader
	Object.defineProperty(NativeReadableStream.prototype, 'getReader', {
		value: function getReader(this: ReadableStream, options?: { mode?: 'byob' }) {
			if (options?.mode !== 'byob' || this.locked || jsStreams.has(this)) return Reflect.apply(nativeGetReader, this, [options])
			try {
				return Reflect.apply(nativeGetReader, this, [options])
			} catch (error) {
				if (!(error instanceof TypeError)) throw error
				return byteSourceOver(this).getReader({ mode: 'byob' })
			}
		},
		writable: true,
		configurable: true,
	})
	const nativeTee = NativeReadableStream.prototype.tee
	Object.defineProperty(NativeReadableStream.prototype, 'tee', {
		value: function tee(this: ReadableStream) {
			const branches = Reflect.apply(nativeTee, this, [])
			if (jsStreams.has(this)) { for (const branch of branches) jsStreams.add(branch) }
			return branches
		},
		writable: true,
		configurable: true,
	})
	Object.defineProperty(ReadableStreamBYOBReader.prototype, 'readAtLeast', { value: readAtLeast, writable: true, configurable: true })
}

function byteSourceOver(stream: ReadableStream): WebReadableStream<Uint8Array> {
	const reader = stream.getReader()
	return new WebReadableStream({
		type: 'bytes',
		async pull(controller) {
			for (;;) {
				const { done, value } = await reader.read()
				if (done) {
					controller.close()
					controller.byobRequest?.respond(0)
					return
				}
				// A copy: enqueue() detaches the chunk's buffer, which still belongs to whoever wrote it.
				const chunk = chunkCopy(value)
				// A byte stream refuses an empty chunk; the source may still send one.
				if (chunk.byteLength === 0) continue
				controller.enqueue(chunk)
				return
			}
		},
		cancel(reason) {
			return reader.cancel(reason)
		},
	})
}

function chunkCopy(chunk: unknown): Uint8Array<ArrayBuffer> {
	if (typeof chunk === 'string') return new TextEncoder().encode(chunk)
	const bytes = chunk instanceof ArrayBuffer
		? new Uint8Array(chunk)
		: ArrayBuffer.isView(chunk)
		? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
		: null
	if (!bytes) throw new TypeError('This ReadableStream did not return bytes.')
	const copy = new Uint8Array(bytes.byteLength)
	copy.set(bytes)
	return copy
}

/**
 * Reads until at least `min` bytes are in `view` or the stream ends; a short final read is not `done`. Reading goes on
 * until the bytes fill whole elements of `view`, so a stream that ends inside an element is an error.
 */
async function readAtLeast(this: WebBYOBReader, min: number, view: ArrayBufferView): Promise<ReadableStreamReadResult<ArrayBufferView>> {
	if (!ArrayBuffer.isView(view)) throw new TypeError('readAtLeast() requires an ArrayBufferView.')
	if (!(min >= 1)) throw new TypeError(`Requested invalid minimum number of bytes to read (${min}).`)
	if (min > view.byteLength) throw new RangeError(`Minimum bytes to read (${min}) exceeds size of buffer (${view.byteLength}).`)
	if (!(view.buffer instanceof ArrayBuffer)) throw new TypeError('readAtLeast() cannot read into a SharedArrayBuffer.')
	const elementSize = view instanceof DataView ? 1 : Number(Reflect.get(view, 'BYTES_PER_ELEMENT'))
	// Each read() detaches the buffer it was given and returns it in a new view, so `view` reads as empty afterwards.
	const start = view.byteOffset
	const capacity = view.byteLength
	let buffer = view.buffer
	let filled = 0
	for (;;) {
		const result = await this.read(new Uint8Array(buffer, start + filled, capacity - filled))
		if (result.value) {
			buffer = result.value.buffer
			filled += result.value.byteLength
		}
		if (result.done && filled % elementSize !== 0) throw new TypeError('The stream ended in the middle of an element of the view.')
		if (result.done || (filled >= min && filled % elementSize === 0)) {
			const value: ArrayBufferView = Reflect.construct(view.constructor, [buffer, start, filled / elementSize])
			return result.done && filled === 0 ? { done: true, value } : { done: false, value }
		}
	}
}
