/**
 * WorkerExecutor — runs each DO instance in a separate Bun Worker thread.
 *
 * Main thread side: spawns a Worker on first command, maintains a serial
 * command queue, and bridges WebSocket events between main thread and worker.
 */

import { dirname, resolve } from 'node:path'
import type { DOExecutor, DOExecutorFactory, ExecutorConfig } from './do-executor'
import type { WsBridgeOutbound } from './do-websocket-bridge'
import { CFWebSocket, type WSEvent } from './websocket-pair'

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

/** Serialized Request payload for env-binding RPC fetches. */
export interface SerializedEnvRequest {
	url: string
	method: string
	headers: [string, string][]
	body: ArrayBuffer | null
}

/** Serialized Response payload for env-binding RPC fetch results. */
export interface SerializedEnvResponse {
	status: number
	statusText: string
	headers: [string, string][]
	body: ArrayBuffer | null
}

/** Messages from main thread → worker */
export type DOWorkerMessage =
	| { type: 'command'; id: number; command: DOCommand }
	| { type: 'ws-message'; wsId: string; data: string | ArrayBuffer }
	| { type: 'ws-close'; wsId: string; code: number; reason: string; wasClean: boolean }
	| { type: 'ws-error'; wsId: string }
	/** A real client wrote bytes; deliver them to the user's `server` peer inside the DO worker. */
	| { type: 'fetch-ws-incoming'; wsId: string; data: string | ArrayBuffer }
	| { type: 'fetch-ws-close-in'; wsId: string; code: number; reason: string; wasClean: boolean }
	/** Result of a DO-worker-side `this.env.X.method(...)` proxy call. */
	| { type: 'env-call-result'; id: number; value: unknown }
	| { type: 'env-call-error'; id: number; message: string; stack?: string; name?: string }
	/** Result of a DO-worker-side `this.env.X.fetch(req)` proxy call. */
	| { type: 'env-fetch-result'; id: number; response: SerializedEnvResponse }
	| { type: 'env-fetch-error'; id: number; message: string; stack?: string; name?: string }

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
	/** Stateful env-binding RPC from the DO worker (e.g. `this.env.FAILING.greet(name)`). */
	| { type: 'env-call'; id: number; binding: string; method: string; args: unknown[] }
	| { type: 'env-fetch'; id: number; binding: string; request: SerializedEnvRequest }

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
	private _pending = new Map<number, PendingCommand>()
	private _nextId = 1
	private _disposed = false
	private _inFlightCount = 0
	private _blocked = false
	private _wsCount = 0
	private _bridgedWebSockets = new Map<string, WebSocket>()
	/**
	 * Main-side CFWebSockets that proxy a `Response{webSocket}` returned by the
	 * DO worker's fetch handler. Each entry's `_peer` is a `FetchDoBridgePeer`
	 * that forwards outgoing bytes (Bun.serve → here) down to the DO worker.
	 */
	private _fetchBridgedSockets = new Map<string, CFWebSocket>()

	constructor(config: ExecutorConfig) {
		this._config = config
	}

	private _ensureWorker(): Worker {
		if (this._disposed) throw new Error('WorkerExecutor has been disposed')
		if (this._worker) return this._worker

		const config = this._config
		const worker = new Worker(WORKER_ENTRY_PATH)

		this._ready = new Promise<void>((resolve) => {
			this._readyResolve = resolve
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
						// Worker init error — reject all pending and the ready promise
						const error = new Error(msg.result.message)
						if (msg.result.stack) error.stack = msg.result.stack
						for (const [, pending] of this._pending) {
							pending.reject(error)
						}
						this._pending.clear()
						// Resolve ready so _sendCommand doesn't hang forever
						this._readyResolve?.()
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

				case 'fetch-ws-outgoing': {
					this._fetchBridgedSockets.get(msg.wsId)?.dispatchOrQueue({ type: 'message', data: msg.data })
					break
				}

				case 'fetch-ws-close-out': {
					const cfSocket = this._fetchBridgedSockets.get(msg.wsId)
					if (!cfSocket) break
					cfSocket.dispatchOrQueue({ type: 'close', code: msg.code, reason: msg.reason, wasClean: msg.wasClean })
					cfSocket.readyState = 3
					this._fetchBridgedSockets.delete(msg.wsId)
					break
				}

				case 'env-call':
					this._dispatchEnvCall(msg.id, msg.binding, msg.method, msg.args)
					break

				case 'env-fetch':
					this._dispatchEnvFetch(msg.id, msg.binding, msg.request)
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
			init.webSocket = this._adoptFetchWebSocket(result.fetchWebSocketId)
		}

		return new Response(result.body, init)
	}

	/**
	 * Build a main-side CFWebSocket pair that bridges back to the DO worker's
	 * client peer. The CFWebSocket returned here is what `Bun.serve.upgrade`
	 * receives via the binding-fetch round-trip; its peer forwards every event
	 * down to the DO worker so the user's `server.send()` reaches the real
	 * client and vice versa.
	 */
	private _adoptFetchWebSocket(wsId: string): CFWebSocket {
		const cfSocket = new CFWebSocket()
		const bridgePeer = new FetchDoBridgePeer(wsId, msg => this._worker?.postMessage(msg))
		cfSocket._peer = bridgePeer
		bridgePeer._peer = cfSocket
		this._fetchBridgedSockets.set(wsId, cfSocket)
		return cfSocket
	}

	/**
	 * Resolve a binding name against the main-side env and invoke a method on
	 * it. Used when the DO worker calls `this.env.X.someMethod(...)` for any
	 * stateful binding (service binding RPC, email send, workflow create, …).
	 */
	private async _dispatchEnvCall(id: number, binding: string, method: string, args: unknown[]): Promise<void> {
		try {
			const target = (this._config.env as Record<string, unknown>)?.[binding] as Record<string, unknown> | undefined
			if (!target) throw new Error(`Binding "${binding}" not found on main env`)
			const fn = target[method]
			if (typeof fn !== 'function') throw new Error(`Binding "${binding}" has no method "${method}"`)
			const value = await (fn as (...a: unknown[]) => unknown).call(target, ...args)
			this._worker?.postMessage({ type: 'env-call-result', id, value } satisfies DOWorkerMessage)
		} catch (e) {
			const err = e instanceof Error ? e : new Error(String(e))
			this._worker?.postMessage({ type: 'env-call-error', id, message: err.message, stack: err.stack, name: err.name } satisfies DOWorkerMessage)
		}
	}

	private async _dispatchEnvFetch(id: number, binding: string, req: SerializedEnvRequest): Promise<void> {
		try {
			const target = (this._config.env as Record<string, unknown>)?.[binding] as { fetch?: (r: Request) => Promise<Response> } | undefined
			if (!target?.fetch) throw new Error(`Binding "${binding}" has no fetch() method`)
			const request = new Request(req.url, { method: req.method, headers: req.headers, body: req.body })
			const response = await target.fetch(request)
			const headers: [string, string][] = []
			response.headers.forEach((v, k) => headers.push([k, v]))
			const body = response.body ? await response.arrayBuffer() : null
			this._worker?.postMessage(
				{
					type: 'env-fetch-result',
					id,
					response: { status: response.status, statusText: response.statusText, headers, body },
				} satisfies DOWorkerMessage,
			)
		} catch (e) {
			const err = e instanceof Error ? e : new Error(String(e))
			this._worker?.postMessage({ type: 'env-fetch-error', id, message: err.message, stack: err.stack, name: err.name } satisfies DOWorkerMessage)
		}
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
		this._fetchBridgedSockets.clear()
	}
}

/**
 * Peer that lives next to a main-side CFWebSocket and forwards every dispatched
 * event back to the DO worker thread (where the user's `server` peer can pick
 * it up). Mirrors `BridgeWebSocketPeer` in worker-thread/main-ws-bridge but
 * targets the DO executor's worker instead of the main user-worker thread.
 */
class FetchDoBridgePeer extends CFWebSocket {
	private _post: (msg: DOWorkerMessage) => void
	private _wsId: string

	constructor(wsId: string, post: (msg: DOWorkerMessage) => void) {
		super()
		this._wsId = wsId
		this._post = post
		this._accepted = true
		this.readyState = CFWebSocket.OPEN
	}

	override _dispatchWSEvent(evt: WSEvent): void {
		if (evt.type === 'message' && evt.data !== undefined) {
			this._post({ type: 'fetch-ws-incoming', wsId: this._wsId, data: evt.data })
			return
		}
		if (evt.type === 'close') {
			this._post({
				type: 'fetch-ws-close-in',
				wsId: this._wsId,
				code: evt.code ?? 1000,
				reason: evt.reason ?? '',
				wasClean: evt.wasClean ?? true,
			})
		}
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
