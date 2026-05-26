/**
 * Main-thread side of the worker-thread runtime.
 *
 * Spawns a Bun Worker that hosts the user module graph (see `entry.ts`)
 * and exposes `executeFetch()` to the rest of lopata. Lifecycle is
 * one-shot: each Generation owns its own executor and `dispose()` is
 * called when the generation is stopped (i.e. on every reload).
 */

import { dirname, resolve } from 'node:path'
import { CFWebSocket, type ResponseWithWebSocket } from '../bindings/websocket-pair'
import type { WranglerConfig } from '../config'
import { getActiveContext } from '../tracing/context'
import { getTraceStore } from '../tracing/store'
import type {
	BindingTarget,
	ParentSpanContext,
	RpcCallRequest,
	RpcFetchRequest,
	RpcReply,
	SerializedError,
	SerializedRequest,
	SerializedResponse,
	WorkerCommand,
	WorkerMessage,
} from './protocol'
import { deserializeError, serializeError } from './protocol'
import { dispatchRpcCall, dispatchRpcFetch, RpcStreamRegistry } from './rpc-shared'
import { deserializeResponse, serializeRequestShell } from './serialize'
import { WsHostBridge } from './ws-bridge-shared'

const WORKER_ENTRY = resolve(dirname(new URL(import.meta.url).pathname), 'entry.ts')

interface Pending<T> {
	resolve: (value: T) => void
	reject: (error: Error) => void
}

type HandlerResult = { ok: true } | { ok: false; noHandler: true }

type StreamEvent =
	| { kind: 'chunk'; chunk: Uint8Array }
	| { kind: 'end' }
	| { kind: 'error'; error: SerializedError }

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
	private _nextId = 1
	private _disposed = false
	private _initConfig: WorkerThreadExecutorOptions
	private _mainEnv: Record<string, unknown>
	private _pendingWaitUntil = new Set<number>()
	private _wsBridge: WsHostBridge<WorkerCommand>
	/** Open response-body streams (streamId → controller of the ReadableStream
	 *  handed to Bun.serve). */
	private _streams = new Map<number, ReadableStreamDefaultController<Uint8Array>>()
	/** Stream events that arrived before the matching ReadableStream's `start`
	 *  registered its controller (mirrors the WS `_pendingEvents` race guard). */
	private _pendingStreamEvents = new Map<number, StreamEvent[]>()
	/** Open response-body pumps started by `dispatchRpcFetch` (main → worker
	 *  reverse-streaming path for service-binding fetches). */
	private _rpcStreams = new RpcStreamRegistry()
	/** Outbound request-body pumps for the top-level fetch path (main → worker).
	 *  A `req-stream-cancel` from the worker (user code cancelled `request.body`)
	 *  stops the source reader. */
	private _topRequestStreams = new RpcStreamRegistry()

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
		this._worker.onmessage = (event: MessageEvent<WorkerMessage>) => this._handleMessage(event.data)
		this._worker.onerror = (event: ErrorEvent) => {
			if (this._disposed) return
			this._disposed = true
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
		this._pending.clear()
		this._pendingHandlers.clear()
		this._pendingRpc.clear()
		// Break open response streams so consumers see an error instead of hanging.
		for (const [, controller] of this._streams) {
			try {
				controller.error(err)
			} catch {}
		}
		this._streams.clear()
		this._pendingStreamEvents.clear()
		this._rpcStreams.disposeAll()
		this._topRequestStreams.disposeAll()
		this._wsBridge.disposeAll()
	}

	private _send(cmd: WorkerCommand): void {
		this._worker.postMessage(cmd)
	}

	private _postReply = (reply: RpcReply): void => {
		this._send(reply)
	}

	private _handleMessage(msg: WorkerMessage): void {
		if (this._disposed) return
		switch (msg.type) {
			case 'need-init':
				this._send({
					type: 'init',
					config: {
						modulePath: this._initConfig.modulePath,
						config: this._initConfig.config,
						baseDir: this._initConfig.baseDir,
						workerName: this._initConfig.workerName,
						browserConfig: this._initConfig.browserConfig,
					},
				})
				break
			case 'ready':
				this._readyResolve({ doAlarmHandlers: msg.doAlarmHandlers })
				break
			case 'init-error': {
				const err = new Error(msg.error.message)
				if (msg.error.stack) err.stack = msg.error.stack
				err.name = msg.error.name ?? 'Error'
				this._readyReject(err)
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
					const err = new Error(msg.error.message)
					if (msg.error.stack) err.stack = msg.error.stack
					err.name = msg.error.name ?? 'Error'
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
				const err = new Error(msg.error.message)
				if (msg.error.stack) err.stack = msg.error.stack
				err.name = msg.error.name ?? 'Error'
				p.reject(err)
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
					const err = new Error(msg.error.message)
					if (msg.error.stack) err.stack = msg.error.stack
					err.name = msg.error.name ?? 'Error'
					p.reject(err)
				}
				break
			}
			case 'rpc-call':
				this._dispatchRpcCall(msg)
				break
			case 'rpc-fetch':
				this._dispatchRpcFetch(msg)
				break
			case 'rpc-stream-cancel':
				this._rpcStreams.cancel(msg.streamId)
				break
			case 'req-stream-cancel':
				this._topRequestStreams.cancel(msg.streamId)
				break
			case 'wait-until-add':
				this._pendingWaitUntil.add(msg.id)
				break
			case 'wait-until-settle':
				this._pendingWaitUntil.delete(msg.id)
				break
			case 'trace-span-insert':
				getTraceStore().insertSpan(msg.span)
				break
			case 'trace-span-end':
				getTraceStore().endSpan(msg.spanId, msg.endTime, msg.status, msg.statusMessage ?? undefined)
				break
			case 'trace-span-status':
				getTraceStore().setSpanStatus(msg.spanId, msg.status, msg.statusMessage)
				break
			case 'trace-span-attrs':
				getTraceStore().updateAttributes(msg.spanId, msg.attrs)
				break
			case 'trace-span-event':
				getTraceStore().addEvent(msg.event)
				break
			case 'trace-error':
				getTraceStore().insertError(msg.error)
				break
			case 'ws-worker-send':
				this._wsBridge.deliverRemoteMessage(msg.wsId, msg.data)
				break
			case 'ws-worker-close':
				this._wsBridge.deliverRemoteClose(msg.wsId, msg.code, msg.reason, true)
				break
			case 'stream-chunk':
				this._onStreamEvent(msg.id, { kind: 'chunk', chunk: msg.chunk })
				break
			case 'stream-end':
				this._onStreamEvent(msg.id, { kind: 'end' })
				break
			case 'stream-error':
				this._onStreamEvent(msg.id, { kind: 'error', error: msg.error })
				break
		}
	}

	/** Build the main-side `ReadableStream` for a streamed response. Registers
	 *  its controller on `start` and drains any chunks that raced ahead. Cancel
	 *  (client disconnected) tells the worker to stop pumping. */
	private _makeResponseStream(streamId: number): ReadableStream<Uint8Array> {
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
				if (!this._disposed) this._send({ type: 'stream-cancel', id: streamId })
			},
		})
	}

	private _onStreamEvent(streamId: number, ev: StreamEvent): void {
		const controller = this._streams.get(streamId)
		if (!controller) {
			// Raced ahead of `start()` — buffer until the controller registers.
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

	private _applyStreamEvent(streamId: number, controller: ReadableStreamDefaultController<Uint8Array>, ev: StreamEvent): void {
		try {
			if (ev.kind === 'chunk') {
				controller.enqueue(ev.chunk)
				return
			}
			if (ev.kind === 'end') controller.close()
			else controller.error(deserializeError(ev.error))
		} catch {
			// Controller already closed/errored (e.g. consumer cancelled) — ignore.
		}
		if (ev.kind !== 'chunk') this._streams.delete(streamId)
	}

	/** Background `waitUntil` promises still in flight on the worker side. */
	pendingWaitUntil(): number {
		return this._pendingWaitUntil.size
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
		return (get as (id: string) => Record<string, unknown>).call(binding, target.instanceId)
	}

	private _dispatchRpcCall(req: RpcCallRequest): Promise<void> {
		return dispatchRpcCall(req, {
			resolveBinding: this._resolveBinding,
			post: this._postReply,
			isAlive: () => !this._disposed,
		})
	}

	private _dispatchRpcFetch(req: RpcFetchRequest): Promise<void> {
		return dispatchRpcFetch(req, {
			resolveBinding: this._resolveBinding,
			post: this._postReply,
			isAlive: () => !this._disposed,
			decorateResponse: (response, serialized) => {
				const ws = (response as ResponseWithWebSocket).webSocket
				if (response.status === 101 && ws instanceof CFWebSocket) {
					serialized.webSocketId = this._wsBridge.adoptExisting(ws)
				}
			},
		}, this._rpcStreams)
	}

	private _pumpTopRequestBody(streamId: number, body: ReadableStream<Uint8Array>): void {
		const reader = body.getReader()
		this._topRequestStreams.register(streamId, reader)
		void (async () => {
			try {
				while (true) {
					const { done, value } = await reader.read()
					if (this._disposed) return
					if (done) break
					if (value && value.byteLength > 0) {
						this._send({ type: 'req-stream-chunk', streamId, chunk: value })
					}
				}
				if (this._disposed) return
				this._send({ type: 'req-stream-end', streamId })
			} catch (e) {
				if (this._disposed) return
				this._send({ type: 'req-stream-error', streamId, error: serializeError(e) })
			} finally {
				this._topRequestStreams.complete(streamId)
			}
		})()
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
		const active = getActiveContext()
		const parent: ParentSpanContext | undefined = active ? { traceId: active.traceId, spanId: active.spanId } : undefined
		const id = this._nextId++
		return new Promise<T>((resolve, reject) => {
			map.set(id, { resolve, reject })
			this._send(build(id, parent))
			afterPost?.()
		})
	}

	async executeFetch(request: Request, props?: Record<string, unknown>): Promise<Response> {
		const shell = serializeRequestShell(request)
		const body = request.body
		const req: SerializedRequest = body
			? { ...shell, body: null, streamId: this._topRequestStreams.allocateId() }
			: { ...shell, body: null }
		// `afterPost` fires after `_sendAndAwait` posts the 'fetch' command so
		// the worker sees the streamId before any `req-stream-chunk` arrives.
		// (The receiver buffers events for unknown streamIds, but ordering the
		// pump after the post keeps the slow-path off the hot path.)
		const serialized = await this._sendAndAwait(
			this._pending,
			(id, parent) => ({ type: 'fetch', id, request: req, parent, props }),
			() => {
				if (body && req.streamId !== undefined) this._pumpTopRequestBody(req.streamId, body)
			},
		)

		let response: ResponseWithWebSocket
		if (serialized.streamId !== undefined) {
			// Streamed body — hand Bun.serve a ReadableStream fed by the worker's
			// `stream-chunk` messages, so the response resolves on headers (TTFB
			// preserved) and the body flows incrementally.
			response = new Response(this._makeResponseStream(serialized.streamId), {
				status: serialized.status,
				statusText: serialized.statusText,
				headers: serialized.headers,
			}) as ResponseWithWebSocket
		} else {
			response = deserializeResponse(serialized) as ResponseWithWebSocket
		}
		if (serialized.webSocketId) {
			// If the id was adopted earlier (e.g. WS came back through a DO/service
			// binding fetch), reuse that real CFWebSocket so `Bun.serve.upgrade`
			// gets the actual peer instead of a fresh bridge.
			response.webSocket = this._wsBridge.getSocket(serialized.webSocketId) ?? this._wsBridge.register(serialized.webSocketId)
		}
		return response
	}

	executeScheduled(cronExpr: string, scheduledTime: number): Promise<HandlerResult> {
		return this._sendAndAwait(this._pendingHandlers, (id, parent) => ({ type: 'scheduled', id, cronExpr, scheduledTime, parent }))
	}

	executeEntrypointRpc(entrypoint: string | undefined, method: string, args: unknown[], props?: Record<string, unknown>): Promise<unknown> {
		return this._sendAndAwait(this._pendingRpc, (id, parent) => ({ type: 'entrypoint-rpc', id, entrypoint, method, args, props, parent }))
	}

	executeEmail(messageId: string, from: string, to: string, raw: Uint8Array): Promise<HandlerResult> {
		return this._sendAndAwait(this._pendingHandlers, (id, parent) => ({ type: 'email', id, messageId, from, to, raw, parent }))
	}

	dispose(): void {
		if (this._disposed) return
		this._disposed = true
		this._worker.terminate()
		this._failAll(new Error('Worker thread terminated'))
	}
}
