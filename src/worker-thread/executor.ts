/**
 * Main-thread side of the worker-thread runtime.
 *
 * Spawns a Bun Worker that hosts the user module graph (see `entry.ts`)
 * and exposes `executeFetch()` to the rest of lopata. Lifecycle is
 * one-shot: each Generation owns its own executor and `dispose()` is
 * called when the generation is stopped (i.e. on every reload).
 */

import { dirname, resolve } from 'node:path'
import type { WranglerConfig } from '../config'
import type { SerializedError, SerializedResponse, WorkerCommand, WorkerMessage } from './protocol'

function serializeError(e: unknown): SerializedError {
	const err = e instanceof Error ? e : new Error(String(e))
	return { message: err.message, stack: err.stack, name: err.name }
}

const WORKER_ENTRY = resolve(dirname(new URL(import.meta.url).pathname), 'entry.ts')

interface PendingFetch {
	resolve: (response: SerializedResponse) => void
	reject: (error: Error) => void
}

export interface WorkerThreadExecutorOptions {
	modulePath: string
	config: WranglerConfig
	baseDir: string
	/** Main-thread env holding the stateful binding instances the worker calls into via RPC. */
	mainEnv: Record<string, unknown>
}

export class WorkerThreadExecutor {
	private _worker: Worker
	private _ready: Promise<void>
	private _readyResolve!: () => void
	private _readyReject!: (err: Error) => void
	private _pending = new Map<number, PendingFetch>()
	private _nextId = 1
	private _disposed = false
	private _initConfig: WorkerThreadExecutorOptions

	constructor(options: WorkerThreadExecutorOptions) {
		this._initConfig = options
		this._ready = new Promise<void>((res, rej) => {
			this._readyResolve = res
			this._readyReject = rej
		})

		this._worker = new Worker(WORKER_ENTRY)
		this._worker.onmessage = (event: MessageEvent<WorkerMessage>) => this._handleMessage(event.data)
		this._worker.onerror = (event) => {
			const err = new Error(`Worker thread error: ${event.message ?? 'unknown'}`)
			this._readyReject(err)
			for (const [, pending] of this._pending) pending.reject(err)
			this._pending.clear()
		}
	}

	private _send(cmd: WorkerCommand): void {
		this._worker.postMessage(cmd)
	}

	private _handleMessage(msg: WorkerMessage): void {
		switch (msg.type) {
			case 'need-init':
				this._send({
					type: 'init',
					config: {
						modulePath: this._initConfig.modulePath,
						config: this._initConfig.config,
						baseDir: this._initConfig.baseDir,
					},
				})
				break
			case 'ready':
				this._readyResolve()
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
			case 'binding-call':
				this._dispatchBindingCall(msg.id, msg.target.binding, msg.method, msg.args)
				break
		}
	}

	private async _dispatchBindingCall(id: number, bindingName: string, method: string, args: unknown[]): Promise<void> {
		try {
			const binding = this._initConfig.mainEnv[bindingName]
			if (binding == null) {
				throw new Error(`Binding "${bindingName}" not found on main env`)
			}
			const fn = (binding as Record<string, unknown>)[method]
			if (typeof fn !== 'function') {
				throw new Error(`Binding "${bindingName}" has no method "${method}"`)
			}
			const value = await (fn as (...a: unknown[]) => unknown).call(binding, ...args)
			this._send({ type: 'binding-result', id, value })
		} catch (e) {
			this._send({ type: 'binding-error', id, error: serializeError(e) })
		}
	}

	/** Resolves when the worker has imported the user module successfully. */
	ready(): Promise<void> {
		return this._ready
	}

	async executeFetch(request: Request): Promise<Response> {
		if (this._disposed) throw new Error('Worker-thread executor disposed')
		await this._ready

		const headers: [string, string][] = []
		request.headers.forEach((v, k) => headers.push([k, v]))
		const body = request.body ? await request.arrayBuffer() : null

		const id = this._nextId++
		const serialized = await new Promise<SerializedResponse>((resolve, reject) => {
			this._pending.set(id, { resolve, reject })
			this._send({ type: 'fetch', id, request: { url: request.url, method: request.method, headers, body } })
		})

		return new Response(serialized.body, {
			status: serialized.status,
			statusText: serialized.statusText,
			headers: serialized.headers,
		})
	}

	dispose(): void {
		if (this._disposed) return
		this._disposed = true
		this._worker.terminate()
		const err = new Error('Worker thread terminated')
		for (const [, pending] of this._pending) pending.reject(err)
		this._pending.clear()
	}
}
