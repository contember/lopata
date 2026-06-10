/**
 * Message protocol for the main ↔ DO-instance-worker channel.
 *
 * Sibling of `protocol.ts` (the main ↔ user-worker channel). The two channels
 * are structurally parallel — same concepts under channel-specific names
 * (`do-stream-chunk` here vs `stream-chunk` there, `do-req-stream-*` vs
 * `req-stream-*`) — and both reuse the unified cross-thread RPC frames
 * (`RpcCallRequest`, `RpcReply`, …) defined in `protocol.ts`. Keeping the DO
 * channel's message types here (rather than inline in `do-executor-worker.ts`)
 * lets the two channels be lined up and cross-referenced in one place; the
 * executor/entry implementation logic stays in the bindings layer.
 */

import type {
	RpcCallRequest,
	RpcFetchRequest,
	RpcGetRequest,
	RpcReply,
	RpcReqStreamChunk,
	RpcReqStreamEnd,
	RpcReqStreamError,
	RpcStreamAck,
	RpcStreamCancel,
	SerializedError,
} from './protocol'

/**
 * DO worker → main: the instance's lifecycle state changed. Main mirrors these
 * flags onto the executor so the idle reaper behaves correctly:
 *  - `aborted` — `state.abort()` was called; the executor must be evicted and
 *    recreated fresh on next access (otherwise every command keeps throwing).
 *  - `blocked` — `blockConcurrencyWhile` is running; the executor must not be
 *    evicted mid-block.
 */
export interface DoStateSignal {
	type: 'do-state'
	aborted: boolean
	blocked: boolean
}

/** Commands sent from main thread to worker */
export type DOCommand =
	| {
		type: 'fetch'
		url: string
		method: string
		headers: [string, string][]
		body: ArrayBuffer | null
		/**
		 * When set, the request body is streamed: `body` is `null` and main pumps
		 * `do-req-stream-*` for this id so the DO worker reconstructs a
		 * `ReadableStream` for the rebuilt `Request`. Allows large uploads /
		 * streaming proxies to reach `instance.fetch()` incrementally.
		 */
		streamId?: number
	}
	| { type: 'rpc-call'; method: string; args: unknown[] }
	| { type: 'rpc-get'; prop: string }
	| { type: 'alarm'; retryCount: number }
	// Stop the DO's Docker container (rm -f + stop timers) before main terminates
	// the worker thread. terminate() kills the activity/health timers but leaves
	// the Docker process running; only an explicit cleanup stops it.
	| { type: 'cleanup' }

/** Results returned from worker to main thread */
export type DOResult =
	| {
		type: 'fetch'
		status: number
		statusText: string
		headers: [string, string][]
		body: ArrayBuffer | null
		/** Set when the DO's fetch handler returned a `Response{status:101, webSocket}`. */
		fetchWebSocketId?: string
		/**
		 * When set, the body is streamed: `body` is `null` and the DO worker pumps
		 * `do-stream-chunk` / `do-stream-end` / `do-stream-error` for this id so
		 * main can reconstruct a `ReadableStream` and ship headers immediately.
		 * Mutually exclusive with `fetchWebSocketId`.
		 */
		streamId?: number
	}
	| { type: 'rpc-call'; value: unknown }
	// `kind` discriminates a plain property value from a method (functions can't
	// cross the worker boundary — main hands back a callable stub). Mirrors the
	// user-worker channel's `entrypoint-rpc-get-result` instead of an in-band
	// magic-string sentinel that a real string value could collide with.
	| { type: 'rpc-get'; kind: 'value'; value: unknown }
	| { type: 'rpc-get'; kind: 'function' }
	| { type: 'alarm' }
	| { type: 'cleanup' }
	// Carries the unified SerializedError (cause chain + cloneable own-props),
	// same as every other cross-thread error frame — so a DO method throwing
	// `Object.assign(new Error('x'), { code })` keeps `.code`/`.cause` crossing
	// DO worker → main → calling worker.
	| { type: 'error'; error: SerializedError }

/**
 * Reverse-streaming for DO instance fetch responses (DO worker → main). When a
 * DO `fetch()` returns a `Response` with a body, the worker ships the `result`
 * with `streamId` set and pumps the body via these messages so SSE / chunked
 * responses reach main (and onward to the caller) incrementally.
 *
 * Id space: per-`WorkerExecutor`. Independent of the `RpcStreamRegistry` used
 * by env-binding fetches (those flow main → DO worker over the same channel).
 */
export interface DoStreamChunk {
	type: 'do-stream-chunk'
	streamId: number
	chunk: Uint8Array
}
export interface DoStreamEnd {
	type: 'do-stream-end'
	streamId: number
}
export interface DoStreamError {
	type: 'do-stream-error'
	streamId: number
	error: SerializedError
}
/** main → DO worker: caller dropped the reconstructed body — stop the pump. */
export interface DoStreamCancel {
	type: 'do-stream-cancel'
	streamId: number
}
/** main → DO worker: main consumed a DO-fetch response-body chunk and grants
 *  the DO worker one more credit (see `STREAM_BACKPRESSURE_WINDOW`). */
export interface DoStreamAck {
	type: 'do-stream-ack'
	streamId: number
}

/**
 * Forward-direction streaming for the DOCommand 'fetch' request body (main →
 * DO worker). Main ships the 'fetch' command with `streamId` set and pumps
 * the body via these messages so the DO worker reconstructs a
 * `ReadableStream` for the rebuilt `Request`.
 *
 * Id space: per-`WorkerExecutor`, independent of the response-side `streamId`
 * (`DoStreamChunk`) and the env-binding RPC stream registries.
 */
export interface DoReqStreamChunk {
	type: 'do-req-stream-chunk'
	streamId: number
	chunk: Uint8Array
}
export interface DoReqStreamEnd {
	type: 'do-req-stream-end'
	streamId: number
}
export interface DoReqStreamError {
	type: 'do-req-stream-error'
	streamId: number
	error: SerializedError
}
/** DO worker → main: instance code cancelled the reconstructed request body. */
export interface DoReqStreamCancel {
	type: 'do-req-stream-cancel'
	streamId: number
}
/** DO worker → main: instance code pulled a request-body chunk and grants main's
 *  pump one more credit (cross-thread backpressure, mirrors {@link DoStreamAck}). */
export interface DoReqStreamAck {
	type: 'do-req-stream-ack'
	streamId: number
}

/** Messages from main thread → worker */
export type DOWorkerMessage =
	| { type: 'command'; id: number; command: DOCommand }
	/** A real client wrote bytes; deliver them to the user's `server` peer inside the DO worker. */
	| { type: 'fetch-ws-incoming'; wsId: string; data: string | ArrayBuffer }
	| { type: 'fetch-ws-close-in'; wsId: string; code: number; reason: string; wasClean: boolean }
	/**
	 * Env-binding fetch returned `Response{status:101, webSocket}`; main adopted
	 * the upstream `CFWebSocket` and ships its events to the DO worker, where a
	 * user-facing peer reconstructed via `WsGuestBridge.createBridgedSocket`
	 * dispatches them on user code's `.addEventListener('message')` / `.onmessage`.
	 */
	| { type: 'env-ws-incoming'; wsId: string; data: string | ArrayBuffer }
	| { type: 'env-ws-close-in'; wsId: string; code: number; reason: string; wasClean: boolean }
	// Unified cross-thread binding-RPC replies — see `protocol.ts`.
	| RpcReply
	/** Caller-side cancel for a streamed DO-fetch response body. */
	| DoStreamCancel
	/** Caller-side credit grant for a streamed DO-fetch response body. */
	| DoStreamAck
	/** Body chunks for a streamed DO-fetch *request* body (main → DO worker). */
	| DoReqStreamChunk
	| DoReqStreamEnd
	| DoReqStreamError

/** Messages from worker → main thread */
export type DOMainMessage =
	| { type: 'need-init' }
	| { type: 'ready' }
	| { type: 'result'; id: number; result: DOResult }
	| { type: 'alarm-set'; time: number | null }
	| DoStateSignal
	/** The user's `server` peer sent bytes; forward to the real client via the main-side CFWebSocket. */
	| { type: 'fetch-ws-outgoing'; wsId: string; data: string | ArrayBuffer }
	| { type: 'fetch-ws-close-out'; wsId: string; code: number; reason: string; wasClean: boolean }
	/**
	 * User code (inside the DO worker) emitted bytes / closed on a CFWebSocket
	 * reconstructed from an env-binding fetch upgrade. Forward to the upstream
	 * peer adopted on main via `_envBindingWsBridge`.
	 */
	| { type: 'env-ws-outgoing'; wsId: string; data: string | ArrayBuffer }
	| { type: 'env-ws-close-out'; wsId: string; code: number; reason: string; wasClean: boolean }
	// Unified cross-thread binding-RPC requests — see `protocol.ts`.
	// The DO-worker calls `this.env.<binding>.method(...)` / `.fetch(...)`; main
	// resolves the binding from its env, runs the call under the caller's trace
	// context, and ships the reply back.
	| RpcCallRequest
	| RpcGetRequest
	| RpcFetchRequest
	| RpcStreamCancel
	| RpcStreamAck
	| RpcReqStreamChunk
	| RpcReqStreamEnd
	| RpcReqStreamError
	/** Body chunks for a streamed DO-fetch response (see {@link DoStreamChunk}). */
	| DoStreamChunk
	| DoStreamEnd
	| DoStreamError
	/** Instance-side cancel for a streamed DO-fetch request body. */
	| DoReqStreamCancel
	/** Instance-side credit grant for a streamed DO-fetch request body. */
	| DoReqStreamAck
	/**
	 * Container lifecycle notifications. Main owns the active-container Set so
	 * one centralized `exit` handler can `docker rm -f` everything, regardless
	 * of which DO worker created it. The label-based reaper handles processes
	 * that die before the handler runs.
	 */
	| { type: 'container-registered'; name: string }
	| { type: 'container-removed'; name: string }
