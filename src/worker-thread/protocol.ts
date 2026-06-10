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
	/** Recursively serialized `error.cause` chain (depth-capped). */
	cause?: SerializedError
	/** Enumerable own-properties (err.code, err.status, err.data, …) that user
	 *  or library error handling branches on. Only structured-cloneable values
	 *  are kept (the whole SerializedError must survive postMessage). */
	props?: Record<string, unknown>
}

const MAX_CAUSE_DEPTH = 8

/**
 * Serialize a thrown value for postMessage. MUST be total — it runs inside every
 * worker-side catch block, so a secondary throw here (a non-stringifiable value,
 * a throwing getter) would escalate a handled error into `worker.onerror` and
 * tear down the whole generation. Every value read is guarded.
 *
 * Non-Error thrown values (`throw { status: 404 }`, `throw 'boom'`) keep their
 * cloneable own-enumerable properties so `catch (e) { e.status }` survives the
 * hop — class identity is lost (it always was, even in-process the wire is
 * structured-clone), but the payload is preserved.
 */
export function serializeError(e: unknown, depth = 0): SerializedError {
	const isError = e instanceof Error
	const source = e !== null && typeof e === 'object' ? e : null

	let message = ''
	let name: string | undefined
	let stack: string | undefined
	try {
		if (isError) {
			message = e.message
			name = e.name
			stack = e.stack
		} else if (source) {
			const m = Reflect.get(source, 'message')
			message = typeof m === 'string' ? m : String(e)
			const n = Reflect.get(source, 'name')
			if (typeof n === 'string') name = n
		} else {
			message = String(e)
		}
	} catch {
		message = 'Unserializable thrown value'
	}

	const out: SerializedError = { message, stack, name: name ?? (isError ? 'Error' : undefined) }

	// Preserve cloneable own-enumerable properties. For real Errors these are
	// extras (err.code/status/data/…); for thrown plain objects they ARE the
	// payload. Read each key via Reflect.get inside the try so a throwing getter
	// drops only that key instead of crashing the whole serialize.
	if (source) {
		const props: Record<string, unknown> = {}
		for (const key of Object.keys(source)) {
			if (key === 'message' || key === 'stack' || key === 'name' || key === 'cause') continue
			try {
				const value = Reflect.get(source, key)
				structuredClone(value)
				props[key] = value
			} catch {}
		}
		if (Object.keys(props).length > 0) out.props = props
	}

	if (isError && e.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
		out.cause = serializeError(e.cause, depth + 1)
	}
	return out
}

export function deserializeError(err: SerializedError): Error {
	const e = new Error(err.message, err.cause ? { cause: deserializeError(err.cause) } : undefined)
	if (err.stack) e.stack = err.stack
	e.name = err.name ?? 'Error'
	if (err.props) Object.assign(e, err.props)
	return e
}

export interface WorkerInitConfig {
	modulePath: string
	/** Wrangler config — already parsed, with `env.<name>` overrides applied. */
	config: WranglerConfig
	baseDir: string
	/**
	 * Main's resolved `.lopata` data dir (`getDataDir()`). The worker thread MUST
	 * open the same SQLite file / r2 / d1 dirs main and the DO workers use —
	 * `baseDir` is per-worker (`dirname(workerDef.config)` in multi-worker mode)
	 * and would otherwise split state into a second db. `baseDir` is kept only for
	 * `.dev.vars`/`.env`/assets resolution, which IS per-worker.
	 */
	dataDir: string
	/** Worker name from `lopata.config.ts` (or single-worker wrangler config). Used
	 *  for span attribution + error attribution; mirrors `Generation.workerName`. */
	workerName?: string
	/** Browser Rendering local dev config (Chrome wsEndpoint or executable path). */
	browserConfig?: { wsEndpoint?: string; executablePath?: string; headless?: boolean }
}

/** Names of the worker handlers we know how to invoke via RPC. */
export type WorkerHandlerName = 'fetch' | 'scheduled' | 'email' | 'queue'

/**
 * Dashboard-initiated workflow control operation, routed main → worker so it
 * lands on the *live* worker-side `SqliteWorkflowBinding` (which owns the real
 * abort controllers / event waiters / sleep resolvers — main's binding is
 * hollow in thread mode). `binding` is the wrangler binding name; `instanceId`
 * targets a specific instance for everything except `create`.
 */
export type WorkflowControlOp =
	| { kind: 'create'; params: unknown }
	// Resume all interrupted (running/waiting) instances. Driven by main AFTER the
	// previous generation's worker is disposed, so an interrupted workflow is never
	// re-executed in the new worker while the old one is still running it.
	| { kind: 'resumeInterrupted' }
	| { kind: 'terminate'; instanceId: string }
	| { kind: 'pause'; instanceId: string }
	| { kind: 'resume'; instanceId: string }
	| { kind: 'restart'; instanceId: string; fromStep?: string }
	| { kind: 'skipSleep'; instanceId: string }
	| { kind: 'sendEvent'; instanceId: string; eventType: string; payload?: unknown }
	// Introspection reads of the worker-side in-memory registries — the dashboard
	// instance detail renders "sleeping" / "waiting for events" from these.
	| { kind: 'isSleeping'; instanceId: string }
	| { kind: 'waitingEventTypes'; instanceId: string }

/** Result payload of a {@link WorkflowControlOp}. `create` reports the new id,
 *  the introspection reads report their value; mutating ops report nothing. */
export type WorkflowControlResult =
	| { kind: 'create'; id: string }
	| { kind: 'ok' }
	| { kind: 'isSleeping'; value: boolean }
	| { kind: 'waitingEventTypes'; value: string[] }

export interface BindingTarget {
	binding: string
	/**
	 * DO instance target. When set, the resolving side routes through
	 * `env[binding].get(instanceId)` before invoking `method` / `fetch`, so
	 * cross-DO and self-DO access via env-RPC lands on the right instance. Used
	 * by both the DO-stub proxies and the executors' `_resolveBinding`.
	 */
	instanceId?: string
	/**
	 * @internal For DO instance targets created via `idFromName(name)`: the
	 * original name string. Main reconstructs `DurableObjectIdImpl(instanceId,
	 * instanceName)` before calling `binding.get()` so `ctx.id.name` is
	 * preserved across the thread boundary (matches the in-process path).
	 */
	instanceName?: string
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

/**
 * Property read on a cross-thread binding (`await env.SVC.someProp`). The
 * worker-side binding proxy is callable (for method calls) AND thenable (for
 * property reads); awaiting it posts this and main resolves the property on the
 * main-side binding (which itself implements the thenable property-get). The
 * reply reuses {@link RpcCallReply} / {@link RpcCallErrorReply}.
 */
export interface RpcGetRequest {
	type: 'rpc-call-get'
	id: number
	target: BindingTarget
	property: string
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

/** worker → main: the caller consumed an rpc-fetch response-body chunk and
 *  grants the sender one more credit (see `STREAM_BACKPRESSURE_WINDOW`). */
export interface RpcStreamAck {
	type: 'rpc-stream-ack'
	streamId: number
}

/**
 * Forward-direction streaming for {@link RpcFetchRequest}'s body. The sender
 * (worker-side `RpcClient.callFetch`) ships the request shell + a
 * `requestStreamId` immediately and pumps the body via these messages so
 * uploads / streaming proxies reach the binding's `fetch()` incrementally
 * instead of waiting for the full body to buffer.
 *
 * Direction: sender → receiver of the unified RPC channel. For the
 * user-worker channel that's worker → main; for the DO-worker channel that's
 * DO worker → main. Both `WorkerThreadExecutor` and `WorkerExecutor` host an
 * inbound request-stream receiver and route these messages into it.
 *
 * Id space: independent counter inside the sending `RpcClient`; carried in
 * {@link SerializedRequest}.streamId on the matching `rpc-fetch`.
 */
export interface RpcReqStreamChunk {
	type: 'rpc-req-stream-chunk'
	streamId: number
	chunk: Uint8Array
}
export interface RpcReqStreamEnd {
	type: 'rpc-req-stream-end'
	streamId: number
}
export interface RpcReqStreamError {
	type: 'rpc-req-stream-error'
	streamId: number
	error: SerializedError
}

/** receiver → sender: the binding consumer cancelled the reconstructed
 *  request body. Sender stops the source reader. */
export interface RpcReqStreamCancel {
	type: 'rpc-req-stream-cancel'
	streamId: number
}

/** receiver → sender: the binding consumer pulled a request-body chunk and
 *  grants the sender one more credit (cross-thread backpressure, mirrors
 *  {@link RpcStreamAck} on the response side). */
export interface RpcReqStreamAck {
	type: 'rpc-req-stream-ack'
	streamId: number
}

export type RpcReply =
	| RpcCallReply
	| RpcCallErrorReply
	| RpcFetchReply
	| RpcFetchErrorReply
	| RpcStreamChunk
	| RpcStreamEnd
	| RpcStreamError
	| RpcReqStreamCancel
	| RpcReqStreamAck

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
	| RpcReqStreamCancel
	| RpcReqStreamAck
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
	// RPC property read on the worker's entrypoint (`await env.SVC.someProp`).
	// Mirrors `entrypoint-rpc` but reads the property instead of invoking it —
	// the worker reports back whether the resolved member is a function (so
	// main can hand back a function-stub that RPCs through) or a plain value.
	| {
		type: 'entrypoint-rpc-get'
		id: number
		entrypoint: string | undefined
		property: string
		props?: Record<string, unknown>
		parent?: ParentSpanContext
	}
	// Dashboard-initiated workflow control (create/terminate/pause/resume/
	// restart/skipSleep/sendEvent + introspection reads). Routed to the worker
	// because the live workflow state machine — abort controllers, event
	// waiters, sleep resolvers — lives in the worker's binding instance, not
	// main's hollow one.
	| {
		type: 'workflow-control'
		id: number
		binding: string
		op: WorkflowControlOp
		parent?: ParentSpanContext
	}
	// WebSocket bridge: a real client connected to main's upgraded ws sent us
	// data / closed; dispatch into the user-facing peer of the worker-side pair.
	| { type: 'ws-client-message'; wsId: string; data: string | ArrayBuffer }
	| { type: 'ws-client-close'; wsId: string; code: number; reason: string; wasClean: boolean }
	// Env-binding fetch returned `Response{status:101, webSocket}`; main adopted the
	// upstream `CFWebSocket` and ships its events to the worker, where a user-facing
	// peer reconstructed via `WsGuestBridge.createBridgedSocket` lets user code
	// `.accept()` / `.addEventListener('message')` it. Mirrors the DO channel.
	| { type: 'env-ws-incoming'; wsId: string; data: string | ArrayBuffer }
	| { type: 'env-ws-close-in'; wsId: string; code: number; reason: string; wasClean: boolean }
	// The reconstructed response stream was cancelled on main (client
	// disconnected). Tell the worker to cancel its reader so an unbounded
	// source (e.g. SSE) stops pumping instead of running forever.
	| { type: 'stream-cancel'; id: number }
	// Backpressure: main consumed a response-body chunk and grants the worker
	// one more credit to post (see `STREAM_BACKPRESSURE_WINDOW`).
	| { type: 'stream-ack'; id: number }
	// Request-body streaming for the top-level user-worker fetch (main → worker).
	// Mirrors `stream-chunk` / `stream-end` / `stream-error` in the opposite
	// direction. Allows large or unbounded request bodies (uploads, streaming
	// proxies) to reach user code incrementally instead of being buffered into
	// an ArrayBuffer before crossing the worker boundary.
	| { type: 'req-stream-chunk'; streamId: number; chunk: Uint8Array }
	| { type: 'req-stream-end'; streamId: number }
	| { type: 'req-stream-error'; streamId: number; error: SerializedError }
	// Reload drain: stop the worker's queue consumers from claiming NEW messages.
	// Without this the OLD generation keeps polling the shared queue for the whole
	// grace period, competing with the new generation. In-flight batches finish
	// (tracked via wait-until so drain waits for them).
	| { type: 'stop-queue-consumers' }

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
	| { type: 'entrypoint-rpc-get-result'; id: number; kind: 'value'; value: unknown }
	| { type: 'entrypoint-rpc-get-result'; id: number; kind: 'function' }
	| { type: 'entrypoint-rpc-get-error'; id: number; error: SerializedError }
	| { type: 'workflow-control-result'; id: number; result: WorkflowControlResult }
	| { type: 'workflow-control-error'; id: number; error: SerializedError }
	| RpcCallRequest
	| RpcGetRequest
	| RpcFetchRequest
	| RpcStreamCancel
	| RpcStreamAck
	| RpcReqStreamChunk
	| RpcReqStreamEnd
	| RpcReqStreamError
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
	// User code emitted bytes / closed on a CFWebSocket reconstructed from an
	// env-binding fetch upgrade. Forward to the upstream peer main adopted.
	| { type: 'env-ws-outgoing'; wsId: string; data: string | ArrayBuffer }
	| { type: 'env-ws-close-out'; wsId: string; code: number; reason: string; wasClean: boolean }
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
	// Worker → main: the worker consumed a request-body chunk and grants main's
	// pump one more credit (cross-thread backpressure for the top-level fetch
	// request body, mirrors `stream-ack` on the response side).
	| { type: 'req-stream-ack'; streamId: number }
