/**
 * Main-thread side of the worker-thread runtime.
 *
 * Spawns a Bun Worker that hosts the user module graph (see `entry.ts`)
 * and exposes `executeFetch()` to the rest of lopata. Lifecycle is
 * one-shot: each Generation owns its own executor and `dispose()` is
 * called when the generation is stopped (i.e. on every reload).
 */

import { dirname, resolve } from 'node:path'
import { DurableObjectIdImpl } from '../bindings/durable-object'
import { CFWebSocket, type ResponseWithWebSocket } from '../bindings/websocket-pair'
import type { WranglerConfig } from '../config'
import { getDataDir } from '../db'
import { getActiveContext } from '../tracing/context'
import { getTraceStore } from '../tracing/store'
import type {
	BindingTarget,
	ParentSpanContext,
	SerializedRequest,
	SerializedResponse,
	WorkerCommand,
	WorkerMessage,
	WorkflowControlOp,
	WorkflowControlResult,
} from './protocol'
import { deserializeError } from './protocol'
import { RpcHostChannel } from './rpc-shared'
import { deserializeResponse, serializeRequestShell } from './serialize'
import { OutboundStreamRegistry, pumpStream, STREAM_BACKPRESSURE_WINDOW, StreamReceiver } from './stream-shared'
import { WsHostBridge } from './ws-bridge-shared'

const WORKER_ENTRY = resolve(dirname(new URL(import.meta.url).pathname), 'entry.ts')

function isTraceMessage(msg: WorkerMessage): msg is Extract<WorkerMessage, { type: `trace-${string}` }> {
	return msg.type.startsWith('trace-')
}

interface Pending<T> {
	resolve: (value: T) => void
	reject: (error: Error) => void
}

type HandlerResult = { ok: true } | { ok: false; noHandler: true }

export interface WorkerThreadExecutorOptions {
	modulePath: string
	config: WranglerConfig
	baseDir: string
	workerName?: string
	browserConfig?: { wsEndpoint?: string; executablePath?: string; headless?: boolean }
	/** Main-thread env holding the stateful binding instances the worker calls into via RPC. */
	mainEnv: Record<string, unknown>
}

export interface WorkerReadyInfo {
	/** className → whether the user's DO class defines an `alarm()` handler. */
	doAlarmHandlers: Record<string, boolean>
}

export class WorkerThreadExecutor {
	private _worker: Worker
	private _ready: Promise<WorkerReadyInfo>
	private _readyResolve!: (info: WorkerReadyInfo) => void
	private _readyReject!: (err: Error) => void
	private _pending = new Map<number, Pending<SerializedResponse>>()
	private _pendingHandlers = new Map<number, Pending<HandlerResult>>()
	private _pendingRpc = new Map<number, Pending<unknown>>()
	private _pendingRpcGet = new Map<number, Pending<{ kind: 'value'; value: unknown } | { kind: 'function' }>>()
	private _pendingWorkflowControl = new Map<number, Pending<WorkflowControlResult>>()
	private _nextId = 1
	private _disposed = false
	private _initConfig: WorkerThreadExecutorOptions
	private _mainEnv: Record<string, unknown>
	private _pendingWaitUntil = new Set<number>()
	private _wsBridge: WsHostBridge<WorkerCommand>
	/** Main-side bridge for upstream CFWebSockets adopted from env-binding fetches
	 *  the user worker initiated (`env.DO.fetch('/ws')` returning 101). The worker
	 *  side holds the user-facing peer; events flow both ways so user code can
	 *  consume the socket (`.accept()`/`.send()`), not just reship it. */
	private _envBindingWsBridge!: WsHostBridge<WorkerCommand>
	/** Reconstructed response bodies fed by `stream-chunk` from the worker
	 *  (top-level fetch response → main). */
	private _responseStreams = new StreamReceiver(
		(streamId) => {
			if (this._disposed) return
			this._send({ type: 'stream-cancel', id: streamId })
		},
		{
			window: STREAM_BACKPRESSURE_WINDOW,
			onCredit: (streamId) => {
				if (this._disposed) return
				this._send({ type: 'stream-ack', id: streamId })
			},
		},
	)
	/** Main-side host of the unified cross-thread RPC channel — binding call/get/
	 *  fetch from the user's worker, with response/request-body streaming. Shared
	 *  with the DO-worker executor; channel-specifics injected as hooks. */
	private _rpcChannel = new RpcHostChannel({
		resolveBinding: (target) => this._resolveBinding(target),
		post: (reply) => this._send(reply),
		isAlive: () => !this._disposed,
		decorateResponse: (response, serialized) => {
			const ws = (response as ResponseWithWebSocket).webSocket
			if (response.status === 101 && ws instanceof CFWebSocket) {
				// `bridgeEvents: true` forwards the upstream socket's events to the
				// worker so user code can consume the WS (the CF-documented
				// `(await env.DO.fetch(req)).webSocket.accept()` pattern). Reship still
				// works: the worker re-registers the bridged peer on its top-level WS
				// bridge, double-bridging through to the real client.
				serialized.webSocketId = this._envBindingWsBridge.adoptExisting(ws, { bridgeEvents: true })
			}
		},
	})
	/** Outbound request-body pumps for the top-level fetch path (main → worker).
	 *  A `req-stream-cancel` from the worker (user code cancelled `request.body`)
	 *  stops the source reader. */
	private _topRequestStreams = new OutboundStreamRegistry()

	constructor(options: WorkerThreadExecutorOptions) {
		this._initConfig = options
		this._mainEnv = options.mainEnv
		this._ready = new Promise<WorkerReadyInfo>((res, rej) => {
			this._readyResolve = res
			this._readyReject = rej
		})

		this._worker = new Worker(WORKER_ENTRY)
		this._wsBridge = new WsHostBridge<WorkerCommand>(cmd => this._send(cmd), {
			clientMessage: (wsId, data) => ({ type: 'ws-client-message', wsId, data }),
			clientClose: (wsId, code, reason, wasClean) => ({ type: 'ws-client-close', wsId, code, reason, wasClean }),
		})
		this._envBindingWsBridge = new WsHostBridge<WorkerCommand>(cmd => this._send(cmd), {
			clientMessage: (wsId, data) => ({ type: 'env-ws-incoming', wsId, data }),
			clientClose: (wsId, code, reason, wasClean) => ({ type: 'env-ws-close-in', wsId, code, reason, wasClean }),
		})
		this._worker.onmessage = (event: MessageEvent<WorkerMessage>) => this._handleMessage(event.data)
		this._worker.onerror = (event: ErrorEvent) => {
			if (this._disposed) return
			this._disposed = true
			// Bun does NOT auto-terminate a Worker that crashed via an uncaught error
			// (unhandledrejection, async errors in waitUntil/queue/timer callbacks).
			// Terminate it here — otherwise `dispose()` early-returns on `_disposed`
			// and the thread (with its queue-consumer `setInterval`s, see
			// `startThreadQueueConsumers`) lives until process exit, polling the shared
			// SQLite queue forever. Mirrors `WorkerExecutor.onerror` for DO workers.
			this._worker.terminate()
			// `event.message` is frequently empty for Bun worker errors — prefer the
			// real stack when the runtime attaches one so the user gets a usable trace.
			const detail = event.error?.stack ?? event.message ?? 'unknown'
			this._failAll(new Error(`Worker thread error: ${detail}`))
		}
	}

	/** Reject every outstanding promise and tear down bridges. Shared by `onerror`
	 *  (worker crashed) and `dispose()` (planned teardown). */
	private _failAll(err: Error): void {
		this._readyReject(err)
		for (const [, pending] of this._pending) pending.reject(err)
		for (const [, pending] of this._pendingHandlers) pending.reject(err)
		for (const [, pending] of this._pendingRpc) pending.reject(err)
		for (const [, pending] of this._pendingRpcGet) pending.reject(err)
		for (const [, pending] of this._pendingWorkflowControl) pending.reject(err)
		this._pending.clear()
		this._pendingHandlers.clear()
		this._pendingRpc.clear()
		this._pendingRpcGet.clear()
		this._pendingWorkflowControl.clear()
		this._pendingWaitUntil.clear()
		this._responseStreams.disposeAll(err)
		this._rpcChannel.disposeAll(err)
		this._topRequestStreams.disposeAll()
		this._wsBridge.disposeAll()
		this._envBindingWsBridge.disposeAll()
	}

	private _send(cmd: WorkerCommand): void {
		this._worker.postMessage(cmd)
	}

	private _handleMessage(msg: WorkerMessage): void {
		if (isTraceMessage(msg)) {
			// Trace writes target the shared (process-wide) TraceStore + dashboard
			// subscribers — they never touch this (possibly disposed) generation.
			// Apply them even after dispose so a `trace-span-end` (or attrs/event)
			// queued just before teardown still finalizes the span instead of
			// leaving it dangling 'unset' for the dying generation.
			this._applyTrace(msg)
			return
		}
		if (this._disposed) return
		if (this._rpcChannel.handle(msg)) return
		switch (msg.type) {
			case 'need-init':
				this._send({
					type: 'init',
					config: {
						modulePath: this._initConfig.modulePath,
						config: this._initConfig.config,
						baseDir: this._initConfig.baseDir,
						// Same physical .lopata dir main + DO workers use, NOT baseDir —
						// otherwise multi-worker mode splits binding state into a second db.
						dataDir: getDataDir(),
						workerName: this._initConfig.workerName,
						browserConfig: this._initConfig.browserConfig,
					},
				})
				break
			case 'ready':
				this._readyResolve({ doAlarmHandlers: msg.doAlarmHandlers })
				break
			case 'init-error': {
				this._readyReject(deserializeError(msg.error))
				break
			}
			case 'fetch-result': {
				const pending = this._pending.get(msg.id)
				if (pending) {
					this._pending.delete(msg.id)
					pending.resolve(msg.response)
				}
				break
			}
			case 'fetch-error': {
				const pending = this._pending.get(msg.id)
				if (pending) {
					this._pending.delete(msg.id)
					const err = deserializeError(msg.error)
					pending.reject(err)
				}
				break
			}
			case 'scheduled-result':
			case 'email-result': {
				const p = this._pendingHandlers.get(msg.id)
				if (p) {
					this._pendingHandlers.delete(msg.id)
					p.resolve({ ok: true })
				}
				break
			}
			case 'entrypoint-rpc-result': {
				const p = this._pendingRpc.get(msg.id)
				if (p) {
					this._pendingRpc.delete(msg.id)
					p.resolve(msg.value)
				}
				break
			}
			case 'entrypoint-rpc-error': {
				const p = this._pendingRpc.get(msg.id)
				if (!p) break
				this._pendingRpc.delete(msg.id)
				p.reject(deserializeError(msg.error))
				break
			}
			case 'entrypoint-rpc-get-result': {
				const p = this._pendingRpcGet.get(msg.id)
				if (p) {
					this._pendingRpcGet.delete(msg.id)
					p.resolve(msg.kind === 'function' ? { kind: 'function' } : { kind: 'value', value: msg.value })
				}
				break
			}
			case 'entrypoint-rpc-get-error': {
				const p = this._pendingRpcGet.get(msg.id)
				if (!p) break
				this._pendingRpcGet.delete(msg.id)
				p.reject(deserializeError(msg.error))
				break
			}
			case 'workflow-control-result': {
				const p = this._pendingWorkflowControl.get(msg.id)
				if (p) {
					this._pendingWorkflowControl.delete(msg.id)
					p.resolve(msg.result)
				}
				break
			}
			case 'workflow-control-error': {
				const p = this._pendingWorkflowControl.get(msg.id)
				if (!p) break
				this._pendingWorkflowControl.delete(msg.id)
				p.reject(deserializeError(msg.error))
				break
			}
			case 'scheduled-error':
			case 'email-error': {
				const p = this._pendingHandlers.get(msg.id)
				if (!p) break
				this._pendingHandlers.delete(msg.id)
				if (msg.noHandler) {
					p.resolve({ ok: false, noHandler: true })
				} else {
					const err = deserializeError(msg.error)
					p.reject(err)
				}
				break
			}
			case 'req-stream-cancel':
				this._topRequestStreams.cancel(msg.streamId)
				break
			case 'req-stream-ack':
				this._topRequestStreams.grantCredit(msg.streamId)
				break
			case 'wait-until-add':
				this._pendingWaitUntil.add(msg.id)
				break
			case 'wait-until-settle':
				this._pendingWaitUntil.delete(msg.id)
				break
			case 'ws-worker-send':
				this._wsBridge.deliverRemoteMessage(msg.wsId, msg.data)
				break
			case 'ws-worker-close':
				this._wsBridge.deliverRemoteClose(msg.wsId, msg.code, msg.reason, true)
				break
			case 'env-ws-outgoing':
				this._envBindingWsBridge.deliverRemoteMessage(msg.wsId, msg.data)
				break
			case 'env-ws-close-out':
				this._envBindingWsBridge.deliverRemoteClose(msg.wsId, msg.code, msg.reason, msg.wasClean)
				break
			case 'stream-chunk':
				this._responseStreams.push(msg.id, msg.chunk)
				break
			case 'stream-end':
				this._responseStreams.end(msg.id)
				break
			case 'stream-error':
				this._responseStreams.error(msg.id, deserializeError(msg.error))
				break
		}
	}

	/** Apply a forwarded trace-store write on main. Wrapped in try/catch because
	 *  these run inside `worker.onmessage`: a write that throws (a `BigInt` /
	 *  circular value `JSON.stringify` chokes on, a transient DB error) would be
	 *  an uncaught exception that takes down the whole dev server. A failed trace
	 *  write is diagnostic-only — never worth crashing for. */
	private _applyTrace(msg: Extract<WorkerMessage, { type: `trace-${string}` }>): void {
		try {
			const store = getTraceStore()
			switch (msg.type) {
				case 'trace-span-insert':
					store.insertSpan(msg.span)
					break
				case 'trace-span-end':
					store.endSpan(msg.spanId, msg.endTime, msg.status, msg.statusMessage ?? undefined)
					break
				case 'trace-span-status':
					store.setSpanStatus(msg.spanId, msg.status, msg.statusMessage)
					break
				case 'trace-span-attrs':
					store.updateAttributes(msg.spanId, msg.attrs)
					break
				case 'trace-span-event':
					store.addEvent(msg.event)
					break
				case 'trace-error':
					store.insertError(msg.error)
					break
			}
		} catch (err) {
			console.error('[lopata] trace store write failed (ignored):', err)
		}
	}

	/** Background `waitUntil` promises still in flight on the worker side. */
	pendingWaitUntil(): number {
		return this._pendingWaitUntil.size
	}

	/** In-flight scheduled/email handlers and inbound entrypoint RPC/property-get
	 *  calls (another worker calling `env.THIS.method()`). Reload drain consults
	 *  this so a cron/email handler or inbound RPC firing just before reload isn't
	 *  force-terminated mid-execution. */
	pendingHandlerWork(): number {
		return this._pendingHandlers.size + this._pendingRpc.size + this._pendingRpcGet.size + this._pendingWorkflowControl.size
	}

	/** In-flight streamed bodies for the top-level fetch path: response bodies the
	 *  client is still downloading (`_responseStreams`, incl. SSE) plus request-body
	 *  pumps still uploading (`_topRequestStreams`). `executeFetch` resolves at the
	 *  headers, so these aren't reflected by `pendingFetch()` — reload drain must
	 *  consult them or it cuts off an active download/SSE with zero grace. */
	openStreamCount(): number {
		return this._responseStreams.activeCount() + this._topRequestStreams.activeCount()
	}

	/** In-flight top-level `executeFetch` calls. A cross-worker service-binding
	 *  fetch (`env.OTHER.fetch()`) lands here directly via the registry without
	 *  touching the target `Generation.activeRequests`, so the drain must consult
	 *  this too — otherwise reloading the target severs the request mid-flight. */
	pendingFetch(): number {
		return this._pending.size
	}

	private _resolveBinding = (target: BindingTarget): Record<string, unknown> => {
		const binding = this._mainEnv[target.binding]
		if (binding == null) {
			throw new Error(`Binding "${target.binding}" not found on main env`)
		}
		if (target.instanceId === undefined) {
			return binding as Record<string, unknown>
		}
		const get = (binding as Record<string, unknown>).get
		if (typeof get !== 'function') {
			throw new Error(`Binding "${target.binding}" cannot resolve instance "${target.instanceId}" — no .get() method`)
		}
		const doId = new DurableObjectIdImpl(target.instanceId, target.instanceName)
		return (get as (id: DurableObjectIdImpl) => Record<string, unknown>).call(binding, doId)
	}

	private _pumpTopRequestBody(streamId: number, body: ReadableStream<Uint8Array>): void {
		type Chunk = Extract<WorkerCommand, { type: 'req-stream-chunk' }>
		type End = Extract<WorkerCommand, { type: 'req-stream-end' }>
		type Err = Extract<WorkerCommand, { type: 'req-stream-error' }>
		pumpStream<Chunk, End, Err>(
			streamId,
			body,
			this._topRequestStreams,
			cmd => this._send(cmd),
			{
				chunk: (id, chunk) => ({ type: 'req-stream-chunk', streamId: id, chunk }),
				end: (id) => ({ type: 'req-stream-end', streamId: id }),
				error: (id, error) => ({ type: 'req-stream-error', streamId: id, error }),
			},
			() => !this._disposed,
			STREAM_BACKPRESSURE_WINDOW,
		)
	}

	/** Resolves when the worker has imported the user module successfully. */
	ready(): Promise<WorkerReadyInfo> {
		return this._ready
	}

	/**
	 * Allocate an id, register a pending promise, post the command. The `build`
	 * callback receives the id + active span context (so sub-spans on the worker
	 * side link to the caller) and returns the actual `WorkerCommand`.
	 */
	private async _sendAndAwait<T>(
		map: Map<number, Pending<T>>,
		build: (id: number, parent: ParentSpanContext | undefined) => WorkerCommand,
		afterPost?: () => void,
	): Promise<T> {
		if (this._disposed) throw new Error('Worker-thread executor disposed')
		await this._ready
		// `dispose()` may have run during `await this._ready` — `_failAll` already
		// cleared the maps, so registering a fresh pending entry here would post to a
		// terminated Worker (a silent no-op) and the promise would never settle.
		// Re-check after the await (mirrors the DO channel's `_sendCommand`).
		if (this._disposed) throw new Error('Worker-thread executor disposed')
		const active = getActiveContext()
		const parent: ParentSpanContext | undefined = active ? { traceId: active.traceId, spanId: active.spanId } : undefined
		const id = this._nextId++
		return new Promise<T>((resolve, reject) => {
			map.set(id, { resolve, reject })
			try {
				this._send(build(id, parent))
				afterPost?.()
			} catch (e) {
				// A synchronous postMessage throw (DataCloneError on a non-cloneable
				// arg) would otherwise leave the pending entry registered forever,
				// pinning the generation non-idle. Drop it and reject the caller.
				map.delete(id)
				reject(e instanceof Error ? e : new Error(String(e)))
			}
		})
	}

	async executeFetch(request: Request, props?: Record<string, unknown>): Promise<Response> {
		const shell = serializeRequestShell(request)
		const body = request.body
		const reqStreamId = body ? this._topRequestStreams.allocateId() : undefined
		const req: SerializedRequest = reqStreamId !== undefined
			? { ...shell, body: null, streamId: reqStreamId }
			: { ...shell, body: null }
		// `afterPost` fires after `_sendAndAwait` posts the 'fetch' command so
		// the worker sees the streamId before any `req-stream-chunk` arrives.
		// (The receiver buffers events for unknown streamIds, but ordering the
		// pump after the post keeps the slow-path off the hot path.)
		// Propagate client disconnect (Bun.serve `request.signal`) to the worker so
		// the rebuilt Request's signal fires for user code listening on it (SSE /
		// long-poll cleanup). The fetch id is known once `build` runs (post-ready).
		let fetchId: number | undefined
		const signal = request.signal
		const onAbort = () => {
			if (fetchId !== undefined && !this._disposed) this._send({ type: 'fetch-abort', id: fetchId })
		}
		const resultPromise = this._sendAndAwait(
			this._pending,
			(id, parent) => {
				fetchId = id
				return { type: 'fetch', id, request: req, parent, props }
			},
			() => {
				// Wire the signal only AFTER the fetch command is posted: a client
				// that already disconnected fires onAbort synchronously, and posting
				// fetch-abort ahead of the fetch command would no-op in the worker
				// (no controller for the id yet) — the rebuilt Request's signal
				// would then never fire. postMessage is FIFO, so abort-after-fetch
				// is ordered.
				if (signal) {
					if (signal.aborted) onAbort()
					else signal.addEventListener('abort', onAbort, { once: true })
				}
				if (body && reqStreamId !== undefined) this._pumpTopRequestBody(reqStreamId, body)
			},
		)
		if (body && reqStreamId !== undefined) {
			// If the handler errors mid-upload, stop the request-body pump so it
			// doesn't keep reading the source into the worker's receiver buffer for a
			// request that already failed. Mirrors the DO-fetch path.
			resultPromise.catch(() => this._topRequestStreams.cancel(reqStreamId))
		}
		const serialized = await resultPromise

		let response: ResponseWithWebSocket
		if (serialized.streamId !== undefined) {
			// Streamed body — hand Bun.serve a ReadableStream fed by the worker's
			// `stream-chunk` messages, so the response resolves on headers (TTFB
			// preserved) and the body flows incrementally.
			response = new Response(this._responseStreams.open(serialized.streamId), {
				status: serialized.status,
				statusText: serialized.statusText,
				headers: serialized.headers,
			}) as ResponseWithWebSocket
		} else {
			response = deserializeResponse(serialized) as ResponseWithWebSocket
		}
		if (serialized.webSocketId) {
			// Always a fresh guest-side id: the worker registers the response's
			// CFWebSocket on its top-level WS bridge in serializeResponse — even a
			// socket that originally came from a DO/service binding fetch was
			// reconstructed worker-side and re-registered (its env-binding adoption
			// lives on `_envBindingWsBridge`, not here).
			response.webSocket = this._wsBridge.register(serialized.webSocketId)
		}
		return response
	}

	executeScheduled(cronExpr: string, scheduledTime: number): Promise<HandlerResult> {
		return this._sendAndAwait(this._pendingHandlers, (id, parent) => ({ type: 'scheduled', id, cronExpr, scheduledTime, parent }))
	}

	executeEntrypointRpc(entrypoint: string | undefined, method: string, args: unknown[], props?: Record<string, unknown>): Promise<unknown> {
		return this._sendAndAwait(this._pendingRpc, (id, parent) => ({ type: 'entrypoint-rpc', id, entrypoint, method, args, props, parent }))
	}

	executeEntrypointPropertyGet(
		entrypoint: string | undefined,
		property: string,
		props?: Record<string, unknown>,
	): Promise<{ kind: 'value'; value: unknown } | { kind: 'function' }> {
		return this._sendAndAwait(this._pendingRpcGet, (id, parent) => ({
			type: 'entrypoint-rpc-get',
			id,
			entrypoint,
			property,
			props,
			parent,
		}))
	}

	executeEmail(messageId: string, from: string, to: string, raw: Uint8Array): Promise<HandlerResult> {
		return this._sendAndAwait(this._pendingHandlers, (id, parent) => ({ type: 'email', id, messageId, from, to, raw, parent }))
	}

	/** Run a dashboard workflow control op against the live worker-side binding. */
	executeWorkflowControl(binding: string, op: WorkflowControlOp): Promise<WorkflowControlResult> {
		return this._sendAndAwait(this._pendingWorkflowControl, (id, parent) => ({ type: 'workflow-control', id, binding, op, parent }))
	}

	/** Tell the worker to stop its queue consumers from claiming new messages
	 *  (reload drain). In-flight batches finish and are awaited via wait-until. */
	stopQueueConsumers(): void {
		if (this._disposed) return
		try {
			this._send({ type: 'stop-queue-consumers' })
		} catch {
			// Worker already gone — nothing to stop.
		}
	}

	dispose(): void {
		if (this._disposed) return
		this._disposed = true
		this._worker.terminate()
		this._failAll(new Error('Worker thread terminated'))
	}
}
