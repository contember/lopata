/**
 * WorkerExecutor — runs each DO instance in a separate Bun Worker thread.
 *
 * Main thread side: spawns a Worker on first command, maintains a serial
 * command queue, and bridges WebSocket events between main thread and worker.
 */

import { dirname, resolve } from 'node:path'
import type {
	DOCommand,
	DOMainMessage,
	DoReqStreamChunk,
	DoReqStreamEnd,
	DoReqStreamError,
	DOResult,
	DOWorkerMessage,
	WsAcceptSignal,
} from '../worker-thread/do-protocol'
import type { BindingTarget, RpcCallRequest, RpcFetchRequest, RpcGetRequest, RpcReply } from '../worker-thread/protocol'
import { deserializeError } from '../worker-thread/protocol'
import { dispatchRpcCall, dispatchRpcFetch, dispatchRpcGet } from '../worker-thread/rpc-shared'
import { OutboundStreamRegistry, pumpStream, STREAM_BACKPRESSURE_WINDOW, StreamReceiver } from '../worker-thread/stream-shared'
import { WsHostBridge } from '../worker-thread/ws-bridge-shared'
import { registerContainer, unregisterContainer } from './container-cleanup'
import type { DOExecutor, DOExecutorFactory, ExecutorConfig } from './do-executor'
import { DurableObjectIdImpl } from './durable-object'
import { CFWebSocket, type ResponseWithWebSocket } from './websocket-pair'

// The DO-channel message protocol (DOCommand / DOResult / DOWorkerMessage /
// DOMainMessage / Do*Stream* / WsAcceptSignal) lives in
// `worker-thread/do-protocol.ts`, beside the user-worker channel's `protocol.ts`.
// Re-exported here so existing `import … from './do-executor-worker'` sites keep
// working.
export type {
	DOCommand,
	DOMainMessage,
	DoReqStreamAck,
	DoReqStreamCancel,
	DoReqStreamChunk,
	DoReqStreamEnd,
	DoReqStreamError,
	DOResult,
	DoStreamAck,
	DoStreamCancel,
	DoStreamChunk,
	DoStreamEnd,
	DoStreamError,
	DOWorkerMessage,
} from '../worker-thread/do-protocol'

// --- Pending command tracking ---

interface PendingCommand {
	resolve: (result: DOResult) => void
	reject: (error: Error) => void
}

// --- WorkerExecutor ---

const WORKER_ENTRY_PATH = resolve(dirname(new URL(import.meta.url).pathname), 'do-worker-entry.ts')

export class WorkerExecutor implements DOExecutor {
	private _config: ExecutorConfig
	private _worker: Worker | null = null
	private _ready: Promise<void> | null = null
	private _readyResolve: (() => void) | null = null
	private _readyReject: ((err: Error) => void) | null = null
	private _pending = new Map<number, PendingCommand>()
	private _nextId = 1
	private _disposed = false
	private _inFlightCount = 0
	private _blocked = false
	private _wsCount = 0
	/**
	 * `wsId`s of hibernation WSes the DO worker has signalled as accepted via
	 * `state.acceptWebSocket`. The matching decrement lives in the `_fetchBridge`
	 * clientClose envelope (client disconnect) and the `fetch-ws-close-out`
	 * dispatch (server-side close) — both guard on this set so neither
	 * double-decrements.
	 */
	private _acceptedFetchWsIds = new Set<string>()
	/**
	 * Main-side WS bridge for `Response{webSocket}` returned by the DO worker's
	 * fetch handler. The bridge's peer forwards outgoing bytes (Bun.serve → here)
	 * down to the DO worker as `fetch-ws-incoming` / `fetch-ws-close-in`.
	 */
	private _fetchBridge: WsHostBridge<DOWorkerMessage> | null = null
	/**
	 * Main-side WS bridge for upstream CFWebSockets adopted from env-binding
	 * fetches the DO worker initiated (e.g. `this.env.SVC.fetch('/ws')` returning
	 * a 101). Direction is opposite of `_fetchBridge`: we already hold the real
	 * CFWebSocket from main's `resolveBinding(...).fetch()`, the DO worker side
	 * holds the synthetic user-facing peer.
	 */
	private _envBindingWsBridge: WsHostBridge<DOWorkerMessage> | null = null
	/** Reverse-streaming pumps for env-binding fetch responses (service-binding
	 *  RPC `.fetch()` invoked from inside the DO worker). */
	private _rpcStreams = new OutboundStreamRegistry()
	/** Receiver state for request-body streams arriving from the DO worker on
	 *  the unified RPC channel (DO-worker → main env-binding fetch with body). */
	private _rpcRequestStreams = new StreamReceiver(
		(streamId) => {
			if (this._disposed) return
			this._worker?.postMessage({ type: 'rpc-req-stream-cancel', streamId } satisfies DOWorkerMessage)
		},
		{
			window: STREAM_BACKPRESSURE_WINDOW,
			onCredit: (streamId) => {
				if (this._disposed) return
				this._worker?.postMessage({ type: 'rpc-req-stream-ack', streamId } satisfies DOWorkerMessage)
			},
		},
	)
	/** Reconstruction of streamed DO-fetch response bodies (DO worker → main). */
	private _fetchStreams = new StreamReceiver(
		(streamId) => {
			this._worker?.postMessage({ type: 'do-stream-cancel', streamId } satisfies DOWorkerMessage)
		},
		{
			window: STREAM_BACKPRESSURE_WINDOW,
			onCredit: (streamId) => {
				this._worker?.postMessage({ type: 'do-stream-ack', streamId } satisfies DOWorkerMessage)
			},
		},
	)
	/** Outbound request-body pumps for DO-fetch (main → DO worker). A
	 *  `do-req-stream-cancel` from the DO worker (instance code cancelled the
	 *  body) stops the source reader. */
	private _fetchRequestStreams = new OutboundStreamRegistry()

	constructor(config: ExecutorConfig) {
		this._config = config
	}

	private _ensureWorker(): Worker {
		if (this._disposed) throw new Error('WorkerExecutor has been disposed')
		if (this._worker) return this._worker

		const config = this._config
		const worker = new Worker(WORKER_ENTRY_PATH)

		this._ready = new Promise<void>((resolve, reject) => {
			this._readyResolve = resolve
			this._readyReject = reject
		})

		this._fetchBridge = new WsHostBridge<DOWorkerMessage>(msg => worker.postMessage(msg), {
			clientMessage: (wsId, data) => ({ type: 'fetch-ws-incoming', wsId, data }),
			clientClose: (wsId, code, reason, wasClean) => {
				// A real client disconnect ends the hibernation WS regardless of
				// whether user code calls `ws.close()` in its `webSocketClose`
				// handler (that call is optional in CF). Decrement here so the count
				// doesn't leak and pin the DO worker alive past eviction. The matching
				// `fetch-ws-close-out` (when the server peer also closes) then finds
				// the id already gone and is a no-op, so this never double-decrements.
				if (this._acceptedFetchWsIds.delete(wsId)) this._wsCount--
				return { type: 'fetch-ws-close-in', wsId, code, reason, wasClean }
			},
		})
		this._envBindingWsBridge = new WsHostBridge<DOWorkerMessage>(msg => worker.postMessage(msg), {
			clientMessage: (wsId, data) => ({ type: 'env-ws-incoming', wsId, data }),
			clientClose: (wsId, code, reason, wasClean) => ({ type: 'env-ws-close-in', wsId, code, reason, wasClean }),
		})

		worker.onmessage = (event: MessageEvent<DOMainMessage>) => {
			// Drop late messages after dispose/onerror — the shared RPC dispatchers
			// would otherwise commit side effects (KV write, R2 put, queue send)
			// from a dying generation before their reply gets filtered by
			// `hooks.isAlive()`. Mirrors `WorkerThreadExecutor._handleMessage`.
			if (this._disposed) return
			const msg = event.data

			switch (msg.type) {
				case 'need-init':
					// Worker is alive, send configuration
					worker.postMessage({
						type: 'init',
						config: {
							modulePath: this._resolveModulePath(),
							configPath: this._resolveConfigPath(),
							dataDir: this._resolveDataDir(),
							namespaceName: config.namespaceName,
							idStr: config.id.toString(),
							idName: config.id.name,
						},
					})
					break

				case 'ready':
					this._readyResolve?.()
					break

				case 'result': {
					if (msg.id === -1 && msg.result.type === 'error') {
						// Worker init error — reject all pending and the ready promise so
						// awaiting callers surface the real cause instead of a generic
						// "Worker terminated" after `_disposed` flips.
						const error = new Error(msg.result.message)
						if (msg.result.stack) error.stack = msg.result.stack
						error.name = msg.result.name ?? 'Error'
						for (const [, pending] of this._pending) {
							pending.reject(error)
						}
						this._pending.clear()
						this._readyReject?.(error)
						this._disposed = true
						break
					}
					const pending = this._pending.get(msg.id)
					if (pending) {
						this._pending.delete(msg.id)
						pending.resolve(msg.result)
					}
					break
				}

				case 'alarm-set':
					// Forward alarm set/delete to namespace via callback
					config.onAlarmSet?.(msg.time)
					break

				case 'ws-bridge':
					this._handleWsBridge(msg.payload)
					break

				case 'fetch-ws-outgoing':
					this._fetchBridge?.deliverRemoteMessage(msg.wsId, msg.data)
					break

				case 'fetch-ws-close-out':
					this._fetchBridge?.deliverRemoteClose(msg.wsId, msg.code, msg.reason, msg.wasClean)
					if (this._acceptedFetchWsIds.delete(msg.wsId)) {
						this._wsCount--
					}
					break

				case 'env-ws-outgoing':
					this._envBindingWsBridge?.deliverRemoteMessage(msg.wsId, msg.data)
					break

				case 'env-ws-close-out':
					this._envBindingWsBridge?.deliverRemoteClose(msg.wsId, msg.code, msg.reason, msg.wasClean)
					break

				case 'rpc-call':
					this._dispatchRpcCall(msg)
					break

				case 'rpc-call-get':
					this._dispatchRpcGet(msg)
					break

				case 'rpc-fetch':
					this._dispatchRpcFetch(msg)
					break

				case 'rpc-stream-cancel':
					this._rpcStreams.cancel(msg.streamId)
					break

				case 'rpc-stream-ack':
					this._rpcStreams.grantCredit(msg.streamId)
					break

				case 'rpc-req-stream-chunk':
					this._rpcRequestStreams.push(msg.streamId, msg.chunk)
					break

				case 'rpc-req-stream-end':
					this._rpcRequestStreams.end(msg.streamId)
					break

				case 'rpc-req-stream-error':
					this._rpcRequestStreams.error(msg.streamId, deserializeError(msg.error))
					break

				case 'do-stream-chunk':
					this._fetchStreams.push(msg.streamId, msg.chunk)
					break

				case 'do-stream-end':
					this._fetchStreams.end(msg.streamId)
					break

				case 'do-stream-error':
					this._fetchStreams.error(msg.streamId, deserializeError(msg.error))
					break

				case 'do-req-stream-cancel':
					this._fetchRequestStreams.cancel(msg.streamId)
					break
				case 'do-req-stream-ack':
					this._fetchRequestStreams.grantCredit(msg.streamId)
					break

				case 'container-registered':
					registerContainer(msg.name)
					break

				case 'container-removed':
					unregisterContainer(msg.name)
					break
			}
		}

		worker.onerror = (event: ErrorEvent) => {
			if (this._disposed) return
			// Mark dead so the namespace drops this executor and recreates a fresh
			// one on next access (see `isDisposed()` + `_getOrCreateExecutor`),
			// instead of posting to a terminated Worker (which would hang). Mirrors
			// the init-error path above.
			this._disposed = true
			this._worker = null
			const detail = event.error?.stack ?? event.message ?? 'unknown'
			const error = new Error(`Worker error: ${detail}`)
			this._readyReject?.(error)
			for (const [, pending] of this._pending) {
				pending.reject(error)
			}
			this._pending.clear()
			this._acceptedFetchWsIds.clear()
			this._wsCount = 0
			this._fetchBridge?.disposeAll()
			this._envBindingWsBridge?.disposeAll()
			this._rpcStreams.disposeAll()
			this._rpcRequestStreams.disposeAll(error)
			this._fetchStreams.disposeAll(error)
			this._fetchRequestStreams.disposeAll()
		}

		this._worker = worker
		return worker
	}

	private _resolveModulePath(): string {
		return this._config._modulePath ?? ''
	}

	private _resolveConfigPath(): string {
		return this._config._configPath ?? ''
	}

	private _resolveDataDir(): string {
		return this._config.dataDir ?? ''
	}

	private async _sendCommand(command: DOCommand): Promise<DOResult> {
		const worker = this._ensureWorker()
		await this._ready

		if (this._disposed) throw new Error('Worker terminated')

		const id = this._nextId++
		this._inFlightCount++

		return new Promise<DOResult>((resolve, reject) => {
			this._pending.set(id, {
				resolve: (result) => {
					this._inFlightCount--
					if (result.type === 'error') {
						const err = new Error(result.message)
						err.name = result.name ?? 'Error'
						if (result.stack) err.stack = result.stack
						reject(err)
					} else {
						resolve(result)
					}
				},
				reject: (err) => {
					this._inFlightCount--
					reject(err)
				},
			})
			worker.postMessage({ type: 'command', id, command } satisfies DOWorkerMessage)
		})
	}

	private _handleWsBridge(payload: WsAcceptSignal): void {
		// The DO accepted a hibernation WebSocket — increment the count and track
		// the id so the matching `fetch-ws-close-out` / inbound client close can
		// decrement it (see the `_fetchBridge` clientClose envelope).
		if (!this._acceptedFetchWsIds.has(payload.wsId)) {
			this._acceptedFetchWsIds.add(payload.wsId)
			this._wsCount++
		}
	}

	// --- DOExecutor interface ---

	async executeFetch(request: Request): Promise<Response> {
		const headers: [string, string][] = []
		request.headers.forEach((v, k) => headers.push([k, v]))
		const body = request.body
		const streamId = body ? this._fetchRequestStreams.allocateId() : undefined

		// `_sendCommand` posts the 'fetch' command first; the request-body pump
		// kicks off afterward so the DO worker has registered the streamId
		// before any chunk arrives. (Chunks for an unknown streamId are still
		// buffered on the receiver side, so order is correctness — not safety.)
		const resultPromise = this._sendCommand({
			type: 'fetch',
			url: request.url,
			method: request.method,
			headers,
			body: null,
			streamId,
		})

		if (body && streamId !== undefined) {
			if (this._disposed) {
				// `_sendCommand` already rejected synchronously (worker disposed before
				// `_ensureWorker()` / `await _ready`); skipping the pump avoids locking
				// the source reader on a stream nobody will read.
				body.cancel().catch(() => {})
			} else {
				// If `resultPromise` rejects mid-flight (worker errored during
				// `await _ready`), `_pumpFetchRequestBody` would otherwise hold the
				// source reader locked because `pumpStream`'s loop awaits
				// `reader.read()` and only checks `_disposed` afterwards. Cancel the
				// pump's reader so any pending read resolves and the registry releases.
				resultPromise.catch(() => {
					this._fetchRequestStreams.cancel(streamId)
				})
				this._pumpFetchRequestBody(streamId, body)
			}
		}

		const result = await resultPromise

		if (result.type !== 'fetch') throw new Error('Unexpected result type')

		const init: ResponseInit & { webSocket?: CFWebSocket } = {
			status: result.status,
			statusText: result.statusText,
			headers: result.headers,
		}

		if (result.fetchWebSocketId) {
			if (!this._fetchBridge) throw new Error('Fetch WS bridge not initialised — worker must be alive')
			init.webSocket = this._fetchBridge.register(result.fetchWebSocketId)
		}

		if (result.streamId !== undefined) {
			const stream = this._fetchStreams.open(result.streamId)
			return new Response(stream, init)
		}

		return new Response(result.body, init)
	}

	private _pumpFetchRequestBody(streamId: number, body: ReadableStream<Uint8Array>): void {
		pumpStream<DoReqStreamChunk, DoReqStreamEnd, DoReqStreamError>(
			streamId,
			body,
			this._fetchRequestStreams,
			msg => this._worker?.postMessage(msg satisfies DOWorkerMessage),
			{
				chunk: (id, chunk) => ({ type: 'do-req-stream-chunk', streamId: id, chunk }),
				end: (id) => ({ type: 'do-req-stream-end', streamId: id }),
				error: (id, error) => ({ type: 'do-req-stream-error', streamId: id, error }),
			},
			() => !this._disposed,
			STREAM_BACKPRESSURE_WINDOW,
		)
	}

	/**
	 * Resolve a binding from main's env. Mirrors the user-worker channel:
	 * when `target.instanceId` is set, route through the namespace's `.get()`
	 * so DO-stub redirection works (cross-DO and self-DO access via env-RPC).
	 */
	private _resolveBinding = (target: BindingTarget): Record<string, unknown> => {
		const binding = this._config.env[target.binding] as Record<string, unknown> | undefined
		if (!binding) throw new Error(`Binding "${target.binding}" not found on main env`)
		if (target.instanceId === undefined) return binding
		const get = binding.get
		if (typeof get !== 'function') {
			throw new Error(`Binding "${target.binding}" cannot resolve instance "${target.instanceId}" — no .get() method`)
		}
		const doId = new DurableObjectIdImpl(target.instanceId, target.instanceName)
		return (get as (id: DurableObjectIdImpl) => Record<string, unknown>).call(binding, doId)
	}

	private _postReply = (reply: RpcReply): void => {
		this._worker?.postMessage(reply satisfies DOWorkerMessage)
	}

	private _dispatchRpcCall(req: RpcCallRequest): Promise<void> {
		return dispatchRpcCall(req, {
			resolveBinding: this._resolveBinding,
			post: this._postReply,
			isAlive: () => !this._disposed && this._worker !== null,
		})
	}

	private _dispatchRpcGet(req: RpcGetRequest): Promise<void> {
		return dispatchRpcGet(req, {
			resolveBinding: this._resolveBinding,
			post: this._postReply,
			isAlive: () => !this._disposed && this._worker !== null,
		})
	}

	private _dispatchRpcFetch(req: RpcFetchRequest): Promise<void> {
		return dispatchRpcFetch(
			req,
			{
				resolveBinding: this._resolveBinding,
				post: this._postReply,
				isAlive: () => !this._disposed && this._worker !== null,
				decorateResponse: (response, serialized) => {
					const ws = (response as ResponseWithWebSocket).webSocket
					if (response.status === 101 && ws instanceof CFWebSocket && this._envBindingWsBridge) {
						serialized.webSocketId = this._envBindingWsBridge.adoptExisting(ws, { bridgeEvents: true })
					}
				},
			},
			this._rpcStreams,
			this._rpcRequestStreams,
		)
	}

	async executeRpc(method: string, args: unknown[]): Promise<unknown> {
		const result = await this._sendCommand({
			type: 'rpc-call',
			method,
			args,
		})

		if (result.type !== 'rpc-call') throw new Error('Unexpected result type')
		return result.value
	}

	async executeRpcGet(prop: string): Promise<unknown> {
		const result = await this._sendCommand({
			type: 'rpc-get',
			prop,
		})

		if (result.type !== 'rpc-get') throw new Error('Unexpected result type')
		// Functions can't cross the boundary — return a callable stub
		if (result.kind === 'function') {
			return (...args: unknown[]) => this.executeRpc(prop, args)
		}
		return result.value
	}

	async executeAlarm(retryCount: number): Promise<void> {
		const result = await this._sendCommand({
			type: 'alarm',
			retryCount,
		})
		if (result.type === 'error') {
			const err = new Error(result.message)
			if (result.stack) err.stack = result.stack
			throw err
		}
	}

	isActive(): boolean {
		return this._inFlightCount > 0
	}

	isBlocked(): boolean {
		return this._blocked
	}

	activeWebSocketCount(): number {
		return this._wsCount
	}

	isAborted(): boolean {
		return false // Worker-thread DOs don't support abort
	}

	isDisposed(): boolean {
		return this._disposed
	}

	/**
	 * Ask the DO worker to tear down its Docker container before we terminate the
	 * thread. terminate() kills the worker's activity/health timers but leaves the
	 * Docker process running — mirrors `InProcessExecutor.dispose()`'s
	 * `containerRuntime.cleanup()`. Bounded so a hung `docker rm` can't block
	 * reload; the thread is terminated right after regardless.
	 */
	private _cleanupContainer(): Promise<void> {
		let timer: ReturnType<typeof setTimeout>
		const timeout = new Promise<void>((res) => {
			timer = setTimeout(res, 3000)
		})
		return Promise.race([
			this._sendCommand({ type: 'cleanup' }).then(() => {}, () => {}),
			timeout,
		]).finally(() => clearTimeout(timer))
	}

	async dispose(): Promise<void> {
		// Container DOs: stop the Docker container before terminating the thread.
		// Non-container DOs skip the round-trip so reload stays fast.
		if (!this._disposed && this._worker && this._config.containerConfig) {
			try {
				await this._cleanupContainer()
			} catch {}
		}
		this._disposed = true
		if (this._worker) {
			this._worker.terminate()
			this._worker = null
		}
		// Reject all pending commands
		const error = new Error('Worker terminated')
		for (const [, pending] of this._pending) {
			pending.reject(error)
		}
		this._pending.clear()
		this._acceptedFetchWsIds.clear()
		this._wsCount = 0
		this._fetchBridge?.disposeAll()
		this._envBindingWsBridge?.disposeAll()
		this._rpcStreams.disposeAll()
		this._rpcRequestStreams.disposeAll(error)
		this._fetchStreams.disposeAll(error)
		this._fetchRequestStreams.disposeAll()
	}
}

// --- Factory ---

export class WorkerExecutorFactory implements DOExecutorFactory {
	private _modulePath?: string
	private _configPath?: string

	/**
	 * Set the module and config paths for all executors created by this factory.
	 * Called by the generation manager after loading config.
	 */
	configure(modulePath: string, configPath: string): void {
		this._modulePath = modulePath
		this._configPath = configPath
	}

	create(config: ExecutorConfig): DOExecutor {
		// Attach paths to the config for the executor to use
		return new WorkerExecutor({
			...config,
			_modulePath: this._modulePath ?? '',
			_configPath: this._configPath ?? '',
		})
	}
}
