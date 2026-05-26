/**
 * Message protocol between main thread and worker-thread runtime.
 *
 * Main thread owns Bun.serve, file watcher, GenerationManager, dashboard.
 * Worker thread owns the user module graph + per-thread env. Reload =
 * terminate + respawn.
 */

import type { WranglerConfig } from '../config'
import type { TraceStore } from '../tracing/store'
import type { SpanData, SpanEventData } from '../tracing/types'

/** Parent span context handed to the worker so its spans nest under main's server span. */
export interface ParentSpanContext {
	traceId: string
	spanId: string
}

export type TraceErrorPayload = Parameters<TraceStore['insertError']>[0]

export interface SerializedRequest {
	url: string
	method: string
	headers: [string, string][]
	body: ArrayBuffer | null
	/**
	 * When set, the body is streamed (not buffered): `body` is `null` and the
	 * sender pumps chunk messages keyed by this id. The channel decides which
	 * message family (`req-stream-*` for top-level main→worker fetch,
	 * `rpc-req-stream-*` for cross-thread binding fetch, `do-req-stream-*` for
	 * main→DO-worker fetch). Receiver reconstructs a `ReadableStream` and uses
	 * it as the rebuilt Request's body.
	 */
	streamId?: number
}

export interface SerializedResponse {
	status: number
	statusText: string
	headers: [string, string][]
	body: ArrayBuffer | null
	/** When set, the response carries a WebSocket upgrade — main rebuilds a
	 *  `CFWebSocket` whose peer bridges send/close to this id on the worker. */
	webSocketId?: string
	/**
	 * When set, the body is streamed (not buffered): `body` is `null` and the
	 * worker pumps `stream-chunk` / `stream-end` / `stream-error` for this id.
	 * Main rebuilds a `ReadableStream` so SSE / chunked / otherwise-unbounded
	 * responses reach the client incrementally instead of hanging on a never-
	 * resolving `arrayBuffer()`.
	 */
	streamId?: number
}

export interface SerializedError {
	message: string
	stack?: string
	name?: string
}

export function serializeError(e: unknown): SerializedError {
	const err = e instanceof Error ? e : new Error(String(e))
	return { message: err.message, stack: err.stack, name: err.name }
}

export function deserializeError(err: SerializedError): Error {
	const e = new Error(err.message)
	if (err.stack) e.stack = err.stack
	e.name = err.name ?? 'Error'
	return e
}

export interface WorkerInitConfig {
	modulePath: string
	/** Wrangler config — already parsed, with `env.<name>` overrides applied. */
	config: WranglerConfig
	baseDir: string
	/** Worker name from `lopata.config.ts` (or single-worker wrangler config). Used
	 *  for span attribution + error attribution; mirrors `Generation.workerName`. */
	workerName?: string
	/** Browser Rendering local dev config (Chrome wsEndpoint or executable path). */
	browserConfig?: { wsEndpoint?: string; executablePath?: string; headless?: boolean }
}

/** Names of the worker handlers we know how to invoke via RPC. */
export type WorkerHandlerName = 'fetch' | 'scheduled' | 'email' | 'queue'

export interface BindingTarget {
	binding: string
	/**
	 * @internal Scaffold for upcoming workflow / DO instance RPC. When set, main
	 * resolves via `env[binding].get(instanceId)` before invoking `method`.
	 */
	instanceId?: string
}

/**
 * Unified cross-thread RPC frame. Used in both directions:
 *  - user-worker → main (`WorkerThreadExecutor`): stateful binding access from the user's worker
 *  - DO-worker → main (`WorkerExecutor`): same, from a DO instance worker
 *
 * `parent` propagates trace context so spans created on the receiving side
 * (including spans inside *further* nested cross-thread hops) link back to the
 * caller's active span. Without it nested service-binding calls float at root.
 */
export interface RpcCallRequest {
	type: 'rpc-call'
	id: number
	target: BindingTarget
	method: string
	args: unknown[]
	parent?: ParentSpanContext
}

export interface RpcFetchRequest {
	type: 'rpc-fetch'
	id: number
	target: BindingTarget
	request: SerializedRequest
	parent?: ParentSpanContext
}

export interface RpcCallReply {
	type: 'rpc-call-result'
	id: number
	value: unknown
}

export interface RpcCallErrorReply {
	type: 'rpc-call-error'
	id: number
	error: SerializedError
}

export interface RpcFetchReply {
	type: 'rpc-fetch-result'
	id: number
	response: SerializedResponse
}

export interface RpcFetchErrorReply {
	type: 'rpc-fetch-error'
	id: number
	error: SerializedError
}

/**
 * Reverse-direction streaming for {@link RpcFetchReply}. When main's
 * `dispatchRpcFetch` resolves a response with a body, it ships headers + a
 * `streamId` immediately and pumps the body via these messages so SSE / chunked
 * responses returned from a service binding reach the caller incrementally
 * instead of waiting for the source to finish.
 *
 * Direction: main → worker (mirrors `stream-chunk` / `stream-end` /
 * `stream-error` which carry the worker → main top-level fetch path).
 *
 * Id space: independent counter inside `dispatchRpcFetch`; carried in
 * {@link SerializedResponse}.streamId on the matching `rpc-fetch-result`.
 */
export interface RpcStreamChunk {
	type: 'rpc-stream-chunk'
	streamId: number
	chunk: Uint8Array
}
export interface RpcStreamEnd {
	type: 'rpc-stream-end'
	streamId: number
}
export interface RpcStreamError {
	type: 'rpc-stream-error'
	streamId: number
	error: SerializedError
}

/** worker → main: the caller cancelled the reconstructed response body
 *  (consumer dropped, AbortController, etc). Main stops the source reader. */
export interface RpcStreamCancel {
	type: 'rpc-stream-cancel'
	streamId: number
}

export type RpcRequest = RpcCallRequest | RpcFetchRequest | RpcStreamCancel
export type RpcReply =
	| RpcCallReply
	| RpcCallErrorReply
	| RpcFetchReply
	| RpcFetchErrorReply
	| RpcStreamChunk
	| RpcStreamEnd
	| RpcStreamError

/** Main → worker */
export type WorkerCommand =
	| { type: 'init'; config: WorkerInitConfig }
	// `props` carry the service-binding context `props` from the calling worker
	// across to the target's `ExecutionContext.props`. Absent for top-level HTTP.
	| { type: 'fetch'; id: number; request: SerializedRequest; parent?: ParentSpanContext; props?: Record<string, unknown> }
	| { type: 'scheduled'; id: number; cronExpr: string; scheduledTime: number; parent?: ParentSpanContext }
	| { type: 'email'; id: number; messageId: string; from: string; to: string; raw: Uint8Array; parent?: ParentSpanContext }
	| RpcCallReply
	| RpcCallErrorReply
	| RpcFetchReply
	| RpcFetchErrorReply
	| RpcStreamChunk
	| RpcStreamEnd
	| RpcStreamError
	// RPC method call into the worker's user-defined entrypoint class.
	// Sent from main when a `ServiceBinding` RPC callable resolves a target
	// whose entrypoint class lives in a worker thread. `props` carries the
	// `ServiceBinding._props` so `ctx.props` matches the in-process path;
	// `parent` propagates trace context so child spans link to the caller.
	| {
		type: 'entrypoint-rpc'
		id: number
		entrypoint: string | undefined
		method: string
		args: unknown[]
		props?: Record<string, unknown>
		parent?: ParentSpanContext
	}
	// WebSocket bridge: a real client connected to main's upgraded ws sent us
	// data / closed; dispatch into the user-facing peer of the worker-side pair.
	| { type: 'ws-client-message'; wsId: string; data: string | ArrayBuffer }
	| { type: 'ws-client-close'; wsId: string; code: number; reason: string; wasClean: boolean }
	// The reconstructed response stream was cancelled on main (client
	// disconnected). Tell the worker to cancel its reader so an unbounded
	// source (e.g. SSE) stops pumping instead of running forever.
	| { type: 'stream-cancel'; id: number }
	// Request-body streaming for the top-level user-worker fetch (main → worker).
	// Mirrors `stream-chunk` / `stream-end` / `stream-error` in the opposite
	// direction. Allows large or unbounded request bodies (uploads, streaming
	// proxies) to reach user code incrementally instead of being buffered into
	// an ArrayBuffer before crossing the worker boundary.
	| { type: 'req-stream-chunk'; streamId: number; chunk: Uint8Array }
	| { type: 'req-stream-end'; streamId: number }
	| { type: 'req-stream-error'; streamId: number; error: SerializedError }

/** Worker → main */
export type WorkerMessage =
	| { type: 'need-init' }
	/**
	 * Sent after the user module imports successfully.
	 *
	 * `doAlarmHandlers` maps each DO/container class name declared in the
	 * wrangler config to whether its prototype defines an `alarm()` method. Main
	 * uses it to forward `_setAlarmHandlerHint` to each namespace — without this,
	 * thread-mode `hasAlarmHandler()` would always return `false` (the main-side
	 * namespace doesn't load the user module). Missing exports report `false`.
	 */
	| { type: 'ready'; doAlarmHandlers: Record<string, boolean> }
	| { type: 'init-error'; error: SerializedError }
	| { type: 'fetch-result'; id: number; response: SerializedResponse }
	| { type: 'fetch-error'; id: number; error: SerializedError }
	| { type: 'scheduled-result'; id: number }
	| { type: 'scheduled-error'; id: number; error: SerializedError; noHandler?: boolean }
	| { type: 'email-result'; id: number }
	| { type: 'email-error'; id: number; error: SerializedError; noHandler?: boolean }
	| { type: 'entrypoint-rpc-result'; id: number; value: unknown }
	| { type: 'entrypoint-rpc-error'; id: number; error: SerializedError }
	| RpcCallRequest
	| RpcFetchRequest
	| RpcStreamCancel
	// `ctx.waitUntil(p)` and its settlement. Main tracks in-flight ids so reload
	// drain waits for background work the response no longer carries. Per-id
	// (vs. counter) makes double-add/double-settle impossible to silently desync.
	| { type: 'wait-until-add'; id: number }
	| { type: 'wait-until-settle'; id: number }
	// Trace store forwarding. The worker holds a `RemoteTraceStore` that posts
	// each operation here; main writes to the single real `TraceStore` so the
	// dashboard's subscribers fire normally.
	//
	// INVARIANT: wire shape == TraceStore row shape. If `SpanData` /
	// `SpanEventData` / `insertError` params gain a non-optional field, bump a
	// protocol version and translate at the dispatch site in `executor.ts`.
	| { type: 'trace-span-insert'; span: SpanData }
	| { type: 'trace-span-end'; spanId: string; endTime: number; status: 'ok' | 'error'; statusMessage: string | null }
	| { type: 'trace-span-status'; spanId: string; status: 'ok' | 'error'; statusMessage: string | null }
	| { type: 'trace-span-attrs'; spanId: string; attrs: Record<string, unknown> }
	| { type: 'trace-span-event'; event: Omit<SpanEventData, 'id'> }
	| { type: 'trace-error'; error: TraceErrorPayload }
	// WebSocket bridge: user code on the worker sent data / closed the socket.
	// Main dispatches into its local `CFWebSocket` so the cli/dev.ts WS handler
	// forwards to the real client.
	| { type: 'ws-worker-send'; wsId: string; data: string | ArrayBuffer }
	| { type: 'ws-worker-close'; wsId: string; code: number; reason: string }
	// Response-body streaming. The worker reads its `Response.body` reader and
	// pumps chunks here; main enqueues them on the reconstructed `ReadableStream`
	// it handed to `Bun.serve`. Chunks that arrive before main registers the
	// stream controller are buffered (see `_pendingStreamEvents`).
	| { type: 'stream-chunk'; id: number; chunk: Uint8Array }
	| { type: 'stream-end'; id: number }
	| { type: 'stream-error'; id: number; error: SerializedError }
	// Worker → main: user code cancelled the reconstructed request body
	// (e.g. `request.body.cancel()`). Stop the source pump on main.
	| { type: 'req-stream-cancel'; streamId: number }
