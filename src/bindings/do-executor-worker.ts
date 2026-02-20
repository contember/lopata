/**
 * WorkerExecutor — runs each DO instance in a separate Bun Worker thread.
 *
 * Main thread side: spawns a Worker on first command, maintains a serial
 * command queue, and bridges WebSocket events between main thread and worker.
 */

import { dirname, resolve } from 'node:path'
import type { DOExecutor, DOExecutorFactory, ExecutorConfig } from './do-executor'
import type { WsBridgeOutbound } from './do-websocket-bridge'

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
	| { type: 'fetch'; status: number; statusText: string; headers: [string, string][]; body: ArrayBuffer | null }
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

/** Messages from worker → main thread */
export type DOMainMessage =
	| { type: 'need-init' }
	| { type: 'ready' }
	| { type: 'result'; id: number; result: DOResult }
	| { type: 'alarm-set'; time: number | null }
	| { type: 'ws-bridge'; payload: WsBridgeOutbound }

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

		// Reconstruct Response
		return new Response(result.body, {
			status: result.status,
			statusText: result.statusText,
			headers: result.headers,
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
