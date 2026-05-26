/**
 * Cross-thread binding RPC — shared core used by both worker channels.
 *
 * One frame ({@link RpcCallRequest} / {@link RpcFetchRequest} + their
 * replies in `./protocol.ts`) covers both:
 *  - main ↔ user-worker thread (`WorkerThreadExecutor` in `./executor.ts`)
 *  - main ↔ DO-instance worker thread (`WorkerExecutor` in `../bindings/do-executor-worker.ts`)
 *
 * The two channels carry channel-specific messages on top (fetch/scheduled,
 * ws-bridge events, container lifecycle, …) but the binding RPC half is
 * identical: resolve binding from `target`, invoke under the caller's trace
 * context, serialize the result. This module hosts that half.
 */

import { runWithParentContext } from '../tracing/context'
import type {
	BindingTarget,
	ParentSpanContext,
	RpcCallErrorReply,
	RpcCallReply,
	RpcCallRequest,
	RpcFetchErrorReply,
	RpcFetchReply,
	RpcFetchRequest,
	RpcReply,
	RpcReqStreamCancel,
	RpcReqStreamChunk,
	RpcReqStreamEnd,
	RpcReqStreamError,
	RpcStreamCancel,
	RpcStreamChunk,
	RpcStreamEnd,
	RpcStreamError,
	SerializedRequest,
	SerializedResponse,
} from './protocol'
import { deserializeError, serializeError } from './protocol'
import { deserializeRequest, serializeRequestShell } from './serialize'

import { CFWebSocket, type ResponseWithWebSocket } from '../bindings/websocket-pair'

/**
 * Cross-thread class-identity registry. `structuredClone` (Bun postMessage)
 * strips class prototypes — bindings whose RPC args/returns rely on class
 * identity register a reviver here, and the sender side wraps instances with
 * `tagCloneable` to ship them over the wire.
 */
type Reviver = (raw: Record<string, unknown>) => unknown
const revivers = new Map<string, Reviver>()

export function registerCloneable(tag: string, revive: Reviver): void {
	revivers.set(tag, revive)
}

/** Sender-side tag: produces a structured-clone-safe payload that the
 *  receiver rebuilds via the registered reviver. */
export function tagCloneable<T extends Record<string, unknown>>(tag: string, payload: T): T & { __lopata_class: string } {
	return { ...payload, __lopata_class: tag }
}

export function reifyArgs(args: unknown[]): unknown[] {
	return args.map(reifyArg)
}

function reifyArg(arg: unknown): unknown {
	if (arg && typeof arg === 'object' && '__lopata_class' in arg) {
		const tag = (arg as { __lopata_class: string }).__lopata_class
		const revive = revivers.get(tag)
		if (revive) return revive(arg as Record<string, unknown>)
	}
	return arg
}

export interface RpcDispatchHooks {
	/** Resolve a binding from main env (channel-specific: user-worker supports
	 *  `instanceId` namespace .get(), DO channel doesn't). */
	resolveBinding(target: BindingTarget): Record<string, unknown>
	/** Post a reply back through the channel's transport. */
	post(reply: RpcReply): void
	/** Return false once the channel is torn down so we drop late replies. */
	isAlive(): boolean
	/** Optional hook to add transport-specific fields (e.g. webSocketId) to a
	 *  serialized response after fetch resolves. */
	decorateResponse?(response: Response, serialized: SerializedResponse): void
}

/**
 * Active body pumps started by `dispatchRpcFetch`, keyed by their `streamId`,
 * so an `rpc-stream-cancel` from the worker (caller dropped the response
 * body) can stop the source reader. One registry per channel — the
 * `WorkerThreadExecutor` and `WorkerExecutor` each own their own.
 */
export class RpcStreamRegistry {
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

	/** Worker-side cancel arrived — stop the source pump if still running. */
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

type RpcRequestStreamEvent =
	| { kind: 'chunk'; chunk: Uint8Array }
	| { kind: 'end' }
	| { kind: 'error'; error: ReturnType<typeof deserializeError> }

/**
 * Receiver-side state for inbound request-body streams on the unified RPC
 * channel. The sender (`RpcClient.callFetch`) ships `rpc-fetch` with
 * `requestStreamId` and pumps chunks via `rpc-req-stream-*`; the receiver
 * reconstructs a `ReadableStream` for the rebuilt `Request` and posts
 * `rpc-req-stream-cancel` if the binding consumer drops the body.
 *
 * One per channel (each executor owns its own). Mirrors the inline
 * receiver pattern used in `WorkerThreadExecutor._streams` / `DoFetchStreamReceiver`
 * for response bodies — kept separate to match the existing channel-bound
 * registries rather than introducing a cross-cutting abstraction.
 */
export class RpcRequestStreamReceiver {
	private _controllers = new Map<number, ReadableStreamDefaultController<Uint8Array>>()
	private _pending = new Map<number, RpcRequestStreamEvent[]>()
	private _cancel: (streamId: number) => void

	constructor(cancel: (streamId: number) => void) {
		this._cancel = cancel
	}

	build(streamId: number): ReadableStream<Uint8Array> {
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
				this._cancel(streamId)
			},
		})
	}

	onEvent(streamId: number, ev: RpcRequestStreamEvent): void {
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
		ev: RpcRequestStreamEvent,
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

	disposeAll(err: Error): void {
		for (const [, controller] of this._controllers) {
			try {
				controller.error(err)
			} catch {}
		}
		this._controllers.clear()
		this._pending.clear()
	}
}

export async function dispatchRpcCall(req: RpcCallRequest, hooks: RpcDispatchHooks): Promise<void> {
	try {
		const resolved = hooks.resolveBinding(req.target)
		const fn = resolved[req.method]
		if (typeof fn !== 'function') {
			throw new Error(`Binding "${req.target.binding}" has no method "${req.method}"`)
		}
		const args = reifyArgs(req.args)
		const value = await runWithParentContext(req.parent, () => (fn as (...a: unknown[]) => unknown).call(resolved, ...args))
		if (!hooks.isAlive()) return
		hooks.post({ type: 'rpc-call-result', id: req.id, value } satisfies RpcCallReply)
	} catch (e) {
		if (!hooks.isAlive()) return
		hooks.post({ type: 'rpc-call-error', id: req.id, error: serializeError(e) } satisfies RpcCallErrorReply)
	}
}

/**
 * Resolve a binding's fetch and stream the body back to the caller. Headers +
 * status ship immediately (TTFB preserved); the body flows in
 * `rpc-stream-chunk` messages and terminates with `rpc-stream-end` or
 * `rpc-stream-error`. WS upgrades (status 101) are short-circuited — they
 * carry `webSocketId`, not a body stream. Body-less responses ship without a
 * `streamId` and no pump.
 *
 * The request body is reconstructed from the inbound request-stream messages
 * when `req.request.streamId` is set, so streaming uploads / proxies reach the
 * binding's `fetch()` incrementally.
 */
export async function dispatchRpcFetch(
	req: RpcFetchRequest,
	hooks: RpcDispatchHooks,
	streams: RpcStreamRegistry,
	requestStreams: RpcRequestStreamReceiver,
): Promise<void> {
	let response: Response
	try {
		const resolved = hooks.resolveBinding(req.target)
		const fetch = resolved.fetch
		if (typeof fetch !== 'function') {
			throw new Error(`Binding "${req.target.binding}" has no fetch() method`)
		}
		const body = req.request.streamId !== undefined ? requestStreams.build(req.request.streamId) : undefined
		const request = deserializeRequest(req.request, body)
		response = await runWithParentContext(
			req.parent,
			() => (fetch as (r: Request) => Promise<Response>).call(resolved, request),
		)
	} catch (e) {
		if (!hooks.isAlive()) return
		hooks.post({ type: 'rpc-fetch-error', id: req.id, error: serializeError(e) } satisfies RpcFetchErrorReply)
		return
	}

	if (!hooks.isAlive()) return

	const cfSocket = (response as ResponseWithWebSocket).webSocket
	const isWsUpgrade = response.status === 101 && cfSocket instanceof CFWebSocket
	const headers: [string, string][] = []
	response.headers.forEach((v, k) => headers.push([k, v]))
	const serialized: SerializedResponse = {
		status: response.status,
		statusText: response.statusText,
		headers,
		body: null,
	}

	if (!isWsUpgrade && response.body) {
		serialized.streamId = streams.allocateId()
	}

	hooks.decorateResponse?.(response, serialized)
	hooks.post({ type: 'rpc-fetch-result', id: req.id, response: serialized } satisfies RpcFetchReply)

	if (serialized.streamId !== undefined && response.body) {
		pumpRpcFetchBody(serialized.streamId, response.body, hooks, streams)
	}
}

function pumpRpcFetchBody(
	streamId: number,
	body: ReadableStream<Uint8Array>,
	hooks: RpcDispatchHooks,
	streams: RpcStreamRegistry,
): void {
	const reader = body.getReader()
	streams.register(streamId, reader)
	void (async () => {
		try {
			while (true) {
				const { done, value } = await reader.read()
				if (!hooks.isAlive()) return
				if (done) break
				if (value && value.byteLength > 0) {
					hooks.post({ type: 'rpc-stream-chunk', streamId, chunk: value } satisfies RpcStreamChunk)
				}
			}
			if (!hooks.isAlive()) return
			hooks.post({ type: 'rpc-stream-end', streamId } satisfies RpcStreamEnd)
		} catch (e) {
			if (!hooks.isAlive()) return
			hooks.post({ type: 'rpc-stream-error', streamId, error: serializeError(e) } satisfies RpcStreamError)
		} finally {
			streams.complete(streamId)
		}
	})()
}

interface PendingCall {
	resolve: (value: unknown) => void
	reject: (error: Error) => void
}

type StreamEvent =
	| { kind: 'chunk'; chunk: Uint8Array }
	| { kind: 'end' }
	| { kind: 'error'; error: ReturnType<typeof deserializeError> }

/**
 * Worker-side RPC caller: posts {@link RpcCallRequest}/{@link RpcFetchRequest},
 * resolves the matching reply.
 *
 * Reads the active span context on every call so spans created on the
 * receiving thread (including spans inside nested cross-thread hops) nest
 * under the caller's current span.
 *
 * Also reconstructs streamed response bodies: when a `rpc-fetch-result`
 * carries a `streamId`, the matching `Response` is built around a
 * `ReadableStream` fed by `rpc-stream-chunk` messages. Consumer cancel posts
 * `rpc-stream-cancel` so an unbounded source on main stops pumping.
 */
export class RpcClient {
	private _pending = new Map<number, PendingCall>()
	private _nextId = 1
	private _post: (
		req:
			| RpcCallRequest
			| RpcFetchRequest
			| RpcStreamCancel
			| RpcReqStreamChunk
			| RpcReqStreamEnd
			| RpcReqStreamError,
	) => void
	private _getParent: () => ParentSpanContext | undefined
	/** Active reconstructed streams, keyed by `streamId`. Filled when the
	 *  stream controller registers on `start`; events that arrive earlier are
	 *  buffered in `_pendingStreamEvents`. */
	private _streams = new Map<number, ReadableStreamDefaultController<Uint8Array>>()
	private _pendingStreamEvents = new Map<number, StreamEvent[]>()
	/** Outbound request-body pumps started by `callFetch`. A receiver-side
	 *  `rpc-req-stream-cancel` arrives via `handle()` and stops the source
	 *  reader so an unbounded upload doesn't pump forever. */
	private _requestStreams = new RpcStreamRegistry()

	constructor(
		post: (
			req:
				| RpcCallRequest
				| RpcFetchRequest
				| RpcStreamCancel
				| RpcReqStreamChunk
				| RpcReqStreamEnd
				| RpcReqStreamError,
		) => void,
		getParent: () => ParentSpanContext | undefined,
	) {
		this._post = post
		this._getParent = getParent
	}

	call(target: BindingTarget, method: string, args: unknown[]): Promise<unknown> {
		const id = this._nextId++
		return new Promise((resolve, reject) => {
			this._pending.set(id, { resolve, reject })
			this._post({ type: 'rpc-call', id, target, method, args, parent: this._getParent() })
		})
	}

	callFetch(target: BindingTarget, request: Request): Promise<SerializedResponse> {
		const shell = serializeRequestShell(request)
		const body = request.body
		const id = this._nextId++
		const serialized: SerializedRequest = body
			? { ...shell, body: null, streamId: this._requestStreams.allocateId() }
			: { ...shell, body: null }
		const promise = new Promise<SerializedResponse>((resolve, reject) => {
			this._pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
			this._post({ type: 'rpc-fetch', id, target, request: serialized, parent: this._getParent() })
		})
		if (body && serialized.streamId !== undefined) {
			this._pumpRequestBody(serialized.streamId, body)
		}
		return promise
	}

	private _pumpRequestBody(streamId: number, body: ReadableStream<Uint8Array>): void {
		const reader = body.getReader()
		this._requestStreams.register(streamId, reader)
		void (async () => {
			try {
				while (true) {
					const { done, value } = await reader.read()
					if (done) break
					if (value && value.byteLength > 0) {
						this._post({ type: 'rpc-req-stream-chunk', streamId, chunk: value } satisfies RpcReqStreamChunk)
					}
				}
				this._post({ type: 'rpc-req-stream-end', streamId } satisfies RpcReqStreamEnd)
			} catch (e) {
				this._post({ type: 'rpc-req-stream-error', streamId, error: serializeError(e) } satisfies RpcReqStreamError)
			} finally {
				this._requestStreams.complete(streamId)
			}
		})()
	}

	/**
	 * Build a `Response` from a `SerializedResponse`. When `streamId` is set,
	 * the body becomes a `ReadableStream` fed by `rpc-stream-chunk` messages;
	 * otherwise a buffered body. WebSocket adoption is the caller's job (only
	 * `proxyFetch` / `makeEnvBindingProxy` know the channel's wsId convention).
	 */
	makeResponse(serialized: SerializedResponse): Response {
		if (serialized.streamId === undefined) {
			return new Response(serialized.body, {
				status: serialized.status,
				statusText: serialized.statusText,
				headers: serialized.headers,
			})
		}
		const stream = this._makeStream(serialized.streamId)
		return new Response(stream, {
			status: serialized.status,
			statusText: serialized.statusText,
			headers: serialized.headers,
		})
	}

	private _makeStream(streamId: number): ReadableStream<Uint8Array> {
		return new ReadableStream<Uint8Array>({
			start: (controller) => {
				this._streams.set(streamId, controller)
				const pending = this._pendingStreamEvents.get(streamId)
				if (pending) {
					this._pendingStreamEvents.delete(streamId)
					for (const ev of pending) this._applyStreamEvent(streamId, controller, ev)
				}
			},
			cancel: () => {
				this._streams.delete(streamId)
				this._pendingStreamEvents.delete(streamId)
				this._post({ type: 'rpc-stream-cancel', streamId } satisfies RpcStreamCancel)
			},
		})
	}

	private _onStreamEvent(streamId: number, ev: StreamEvent): void {
		const controller = this._streams.get(streamId)
		if (!controller) {
			let q = this._pendingStreamEvents.get(streamId)
			if (!q) {
				q = []
				this._pendingStreamEvents.set(streamId, q)
			}
			q.push(ev)
			return
		}
		this._applyStreamEvent(streamId, controller, ev)
	}

	private _applyStreamEvent(
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
		if (ev.kind !== 'chunk') this._streams.delete(streamId)
	}

	/** Returns true when `msg` was a unified RPC reply we consumed. */
	handle(msg: { type: string }): boolean {
		switch (msg.type) {
			case 'rpc-call-result':
			case 'rpc-fetch-result': {
				const reply = msg as RpcCallReply | RpcFetchReply
				const p = this._pending.get(reply.id)
				if (!p) return true
				this._pending.delete(reply.id)
				p.resolve(reply.type === 'rpc-call-result' ? reply.value : reply.response)
				return true
			}
			case 'rpc-call-error':
			case 'rpc-fetch-error': {
				const reply = msg as RpcCallErrorReply | RpcFetchErrorReply
				const p = this._pending.get(reply.id)
				if (!p) return true
				this._pending.delete(reply.id)
				p.reject(deserializeError(reply.error))
				return true
			}
			case 'rpc-stream-chunk': {
				const m = msg as RpcStreamChunk
				this._onStreamEvent(m.streamId, { kind: 'chunk', chunk: m.chunk })
				return true
			}
			case 'rpc-stream-end': {
				const m = msg as RpcStreamEnd
				this._onStreamEvent(m.streamId, { kind: 'end' })
				return true
			}
			case 'rpc-stream-error': {
				const m = msg as RpcStreamError
				this._onStreamEvent(m.streamId, { kind: 'error', error: deserializeError(m.error) })
				return true
			}
			case 'rpc-req-stream-cancel': {
				const m = msg as RpcReqStreamCancel
				this._requestStreams.cancel(m.streamId)
				return true
			}
			default:
				return false
		}
	}

	rejectAll(err: Error): void {
		for (const [, p] of this._pending) p.reject(err)
		this._pending.clear()
		for (const [, controller] of this._streams) {
			try {
				controller.error(err)
			} catch {}
		}
		this._streams.clear()
		this._pendingStreamEvents.clear()
		this._requestStreams.disposeAll()
	}
}
