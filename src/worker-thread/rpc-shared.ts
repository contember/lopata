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
import { OutboundStreamRegistry, pumpStream, StreamReceiver } from './stream-shared'

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
	streams: OutboundStreamRegistry,
	requestStreams: StreamReceiver,
): Promise<void> {
	let response: Response
	try {
		const resolved = hooks.resolveBinding(req.target)
		const fetch = resolved.fetch
		if (typeof fetch !== 'function') {
			throw new Error(`Binding "${req.target.binding}" has no fetch() method`)
		}
		const body = req.request.streamId !== undefined ? requestStreams.open(req.request.streamId) : undefined
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
	streams: OutboundStreamRegistry,
): void {
	pumpStream<RpcStreamChunk, RpcStreamEnd, RpcStreamError>(
		streamId,
		body,
		streams,
		hooks.post,
		{
			chunk: (id, chunk) => ({ type: 'rpc-stream-chunk', streamId: id, chunk }),
			end: (id) => ({ type: 'rpc-stream-end', streamId: id }),
			error: (id, error) => ({ type: 'rpc-stream-error', streamId: id, error }),
		},
		hooks.isAlive,
	)
}

interface PendingCall {
	resolve: (value: unknown) => void
	reject: (error: Error) => void
}

type RpcClientPost = (
	req:
		| RpcCallRequest
		| RpcFetchRequest
		| RpcStreamCancel
		| RpcReqStreamChunk
		| RpcReqStreamEnd
		| RpcReqStreamError,
) => void

/**
 * Pump a request body to the channel as `rpc-req-stream-*` messages. The
 * source reader is registered with {@link requestStreams} so an inbound
 * `rpc-req-stream-cancel` can stop the pump.
 */
function pumpRpcRequestBody(
	streamId: number,
	body: ReadableStream<Uint8Array>,
	post: RpcClientPost,
	requestStreams: OutboundStreamRegistry,
): void {
	pumpStream<RpcReqStreamChunk, RpcReqStreamEnd, RpcReqStreamError>(
		streamId,
		body,
		requestStreams,
		post,
		{
			chunk: (id, chunk) => ({ type: 'rpc-req-stream-chunk', streamId: id, chunk }),
			end: (id) => ({ type: 'rpc-req-stream-end', streamId: id }),
			error: (id, error) => ({ type: 'rpc-req-stream-error', streamId: id, error }),
		},
	)
}

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
	private _post: RpcClientPost
	private _getParent: () => ParentSpanContext | undefined
	/** Reconstructed inbound response-body streams (rpc-fetch-result.streamId). */
	private _streams = new StreamReceiver((streamId) => {
		this._post({ type: 'rpc-stream-cancel', streamId } satisfies RpcStreamCancel)
	})
	/** Outbound request-body pumps started by `callFetch`. A receiver-side
	 *  `rpc-req-stream-cancel` arrives via `handle()` and stops the source
	 *  reader so an unbounded upload doesn't pump forever. */
	private _requestStreams = new OutboundStreamRegistry()

	constructor(post: RpcClientPost, getParent: () => ParentSpanContext | undefined) {
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
			pumpRpcRequestBody(serialized.streamId, body, this._post, this._requestStreams)
		}
		return promise
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
		const stream = this._streams.open(serialized.streamId)
		return new Response(stream, {
			status: serialized.status,
			statusText: serialized.statusText,
			headers: serialized.headers,
		})
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
				this._streams.push(m.streamId, m.chunk)
				return true
			}
			case 'rpc-stream-end': {
				const m = msg as RpcStreamEnd
				this._streams.end(m.streamId)
				return true
			}
			case 'rpc-stream-error': {
				const m = msg as RpcStreamError
				this._streams.error(m.streamId, deserializeError(m.error))
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
		this._streams.disposeAll(err)
		this._requestStreams.disposeAll()
	}
}
