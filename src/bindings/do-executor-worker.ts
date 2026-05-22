/**
 * WorkerExecutor — runs each DO instance in a separate Bun Worker thread.
 *
 * Main thread side: spawns a Worker on first command, maintains a serial
 * command queue, and bridges WebSocket events between main thread and worker.
 */

import { dirname, resolve } from 'node:path'
import type { BindingTarget, RpcCallRequest, RpcFetchRequest, RpcReply } from '../worker-thread/protocol'
import { dispatchRpcCall, dispatchRpcFetch } from '../worker-thread/rpc-shared'
import { WsHostBridge } from '../worker-thread/ws-bridge-shared'
import { registerContainer, unregisterContainer } from './container-cleanup'
import type { DOExecutor, DOExecutorFactory, ExecutorConfig } from './do-executor'
import type { WsBridgeOutbound } from './do-websocket-bridge'
import { CFWebSocket } from './websocket-pair'

// --- Message protocol ---

/** Commands sent from main thread to worker */
export type DOCommand =
	| { type: 'fetch'; url: string; method: string; headers: [string, string][]; body: ArrayBuffer | null }
	| { type: 'rpc-call'; method: string; args: unknown[] }
	| { type: 'rpc-get'; prop: string }
	| { type: 'alarm'; retryCount: number }
	| { type: 'ws-create'; wsId: string }

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
	}
	| { type: 'rpc-call'; value: unknown }
	| { type: 'rpc-get'; value: unknown }
	| { type: 'alarm' }
	| { type: 'ws-created'; wsId: string }
	| { type: 'error'; message: string; stack?: string; name?: string }

/** Messages from main thread → worker */
export type DOWorkerMessage =
	| { type: 'command'; id: number; command: DOCommand }
	| { type: 'ws-message'; wsId: string; data: string | ArrayBuffer }
	| { type: 'ws-close'; wsId: string; code: number; reason: string; wasClean: boolean }
	| { type: 'ws-error'; wsId: string }
	/** A real client wrote bytes; deliver them to the user's `server` peer inside the DO worker. */
	| { type: 'fetch-ws-incoming'; wsId: string; data: string | ArrayBuffer }
	| { type: 'fetch-ws-close-in'; wsId: string; code: number; reason: string; wasClean: boolean }
	// Unified cross-thread binding-RPC replies — see `worker-thread/protocol.ts`.
	| RpcReply

/** Messages from worker → main thread */
export type DOMainMessage =
	| { type: 'need-init' }
	| { type: 'ready' }
	| { type: 'result'; id: number; result: DOResult }
	| { type: 'alarm-set'; time: number | null }
	| { type: 'ws-bridge'; payload: WsBridgeOutbound }
	/** The user's `server` peer sent bytes; forward to the real client via the main-side CFWebSocket. */
	| { type: 'fetch-ws-outgoing'; wsId: string; data: string | ArrayBuffer }
	| { type: 'fetch-ws-close-out'; wsId: string; code: number; reason: string; wasClean: boolean }
	// Unified cross-thread binding-RPC requests — see `worker-thread/protocol.ts`.
	// The DO-worker calls `this.env.<binding>.method(...)` / `.fetch(...)`; main
	// resolves the binding from its env, runs the call under the caller's trace
	// context, and ships the reply back.
	| RpcCallRequest
	| RpcFetchRequest
	/**
	 * Container lifecycle notifications. Main owns the active-container Set so
	 * one centralized `exit` handler can `docker rm -f` everything, regardless
	 * of which DO worker created it. The label-based reaper handles processes
	 * that die before the handler runs.
	 */
	| { type: 'container-registered'; name: string }
	| { type: 'container-removed'; name: string }

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
	private _bridgedWebSockets = new Map<string, WebSocket>()
	/**
	 * Main-side WS bridge for `Response{webSocket}` returned by the DO worker's
	 * fetch handler. The bridge's peer forwards outgoing bytes (Bun.serve → here)
	 * down to the DO worker as `fetch-ws-incoming` / `fetch-ws-close-in`.
	 */
	private _fetchBridge: WsHostBridge<DOWorkerMessage> | null = null

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
			clientClose: (wsId, code, reason, wasClean) => ({ type: 'fetch-ws-close-in', wsId, code, reason, wasClean }),
		})

		worker.onmessage = (event: MessageEvent<DOMainMessage>) => {
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
					break

				case 'rpc-call':
					this._dispatchRpcCall(msg)
					break

				case 'rpc-fetch':
					this._dispatchRpcFetch(msg)
					break

				case 'container-registered':
					registerContainer(msg.name)
					break

				case 'container-removed':
					unregisterContainer(msg.name)
					break
			}
		}

		worker.onerror = (event) => {
			// Reject all pending commands
			const error = new Error(`Worker error: ${event.message}`)
			for (const [id, pending] of this._pending) {
				pending.reject(error)
			}
			this._pending.clear()
		}

		this._worker = worker
		return worker
	}

	private _resolveModulePath(): string {
		return (this._config as any)._modulePath ?? ''
	}

	private _resolveConfigPath(): string {
		return (this._config as any)._configPath ?? ''
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

	private _handleWsBridge(payload: WsBridgeOutbound): void {
		switch (payload.type) {
			case 'ws-send': {
				const ws = this._bridgedWebSockets.get(payload.wsId)
				if (ws && ws.readyState === 1) {
					ws.send(payload.data)
				}
				break
			}
			case 'ws-close': {
				const ws = this._bridgedWebSockets.get(payload.wsId)
				if (ws) {
					ws.close(payload.code, payload.reason)
					this._bridgedWebSockets.delete(payload.wsId)
					this._wsCount--
				}
				break
			}
			case 'ws-accept': {
				// WebSocket was accepted by the DO — increment count
				this._wsCount++
				break
			}
		}
	}

	/** Register a real WebSocket for bridging to the worker */
	_bridgeWebSocket(wsId: string, ws: WebSocket): void {
		this._bridgedWebSockets.set(wsId, ws)

		// Forward events from real WS to worker
		ws.addEventListener('message', (event: MessageEvent) => {
			this._worker?.postMessage(
				{
					type: 'ws-message',
					wsId,
					data: event.data,
				} satisfies DOWorkerMessage,
			)
		})

		ws.addEventListener('close', (event: CloseEvent) => {
			this._worker?.postMessage(
				{
					type: 'ws-close',
					wsId,
					code: event.code,
					reason: event.reason,
					wasClean: event.wasClean,
				} satisfies DOWorkerMessage,
			)
			this._bridgedWebSockets.delete(wsId)
		})

		ws.addEventListener('error', () => {
			this._worker?.postMessage(
				{
					type: 'ws-error',
					wsId,
				} satisfies DOWorkerMessage,
			)
		})
	}

	// --- DOExecutor interface ---

	async executeFetch(request: Request): Promise<Response> {
		// Serialize Request
		const headers: [string, string][] = []
		request.headers.forEach((v, k) => headers.push([k, v]))
		const body = request.body ? await request.arrayBuffer() : null

		const result = await this._sendCommand({
			type: 'fetch',
			url: request.url,
			method: request.method,
			headers,
			body,
		})

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

		return new Response(result.body, init)
	}

	/**
	 * Resolve a binding from main's env. DO-worker channel never carries
	 * `instanceId` (env-binding access only — no DO-stub redirection).
	 */
	private _resolveBinding = (target: BindingTarget): Record<string, unknown> => {
		const binding = this._config.env[target.binding] as Record<string, unknown> | undefined
		if (!binding) throw new Error(`Binding "${target.binding}" not found on main env`)
		return binding
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

	private _dispatchRpcFetch(req: RpcFetchRequest): Promise<void> {
		return dispatchRpcFetch(req, {
			resolveBinding: this._resolveBinding,
			post: this._postReply,
			isAlive: () => !this._disposed && this._worker !== null,
		})
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
		if (result.value === '__function__') {
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

	async dispose(): Promise<void> {
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
		this._bridgedWebSockets.clear()
		this._fetchBridge?.disposeAll()
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
		const extendedConfig = config as any
		extendedConfig._modulePath = this._modulePath ?? ''
		extendedConfig._configPath = this._configPath ?? ''
		return new WorkerExecutor(extendedConfig)
	}
}
