/**
 * Main-thread side of the worker-thread runtime.
 *
 * Spawns a Bun Worker that hosts the user module graph (see `entry.ts`)
 * and exposes `executeFetch()` to the rest of lopata. Lifecycle is
 * one-shot: each Generation owns its own executor and `dispose()` is
 * called when the generation is stopped (i.e. on every reload).
 */

import { dirname, resolve } from 'node:path'
import { EmailMessage } from '../bindings/email'
import { CFWebSocket, type ResponseWithWebSocket } from '../bindings/websocket-pair'
import type { WranglerConfig } from '../config'
import { getActiveContext } from '../tracing/context'
import { getTraceStore } from '../tracing/store'
import { MainWsBridge } from './main-ws-bridge'
import type { BindingTarget, ParentSpanContext, SerializedRequest, SerializedResponse, WorkerCommand, WorkerMessage } from './protocol'
import { serializeError } from './protocol'
import { deserializeRequest, deserializeResponse, serializeRequest, serializeResponse } from './serialize'

/**
 * Restore class identities that structured-clone strips. Worker proxies tag
 * such args with `__lopata_class` so we can rebuild the real instance here.
 */
function reifyArgs(args: unknown[]): unknown[] {
	return args.map(reifyArg)
}

function reifyArg(arg: unknown): unknown {
	if (arg && typeof arg === 'object' && '__lopata_class' in arg) {
		const tag = (arg as { __lopata_class: string }).__lopata_class
		if (tag === 'EmailMessage') {
			const { from, to, raw } = arg as unknown as { from: string; to: string; raw: unknown }
			return new EmailMessage(from, to, raw as Uint8Array | ArrayBuffer | string)
		}
	}
	return arg
}

const WORKER_ENTRY = resolve(dirname(new URL(import.meta.url).pathname), 'entry.ts')

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

export class WorkerThreadExecutor {
	private _worker: Worker
	private _ready: Promise<void>
	private _readyResolve!: () => void
	private _readyReject!: (err: Error) => void
	private _pending = new Map<number, Pending<SerializedResponse>>()
	private _pendingHandlers = new Map<number, Pending<HandlerResult>>()
	private _pendingRpc = new Map<number, Pending<unknown>>()
	private _nextId = 1
	private _disposed = false
	private _initConfig: WorkerThreadExecutorOptions
	private _mainEnv: Record<string, unknown>
	private _pendingWaitUntil = 0
	private _wsBridge: MainWsBridge

	constructor(options: WorkerThreadExecutorOptions) {
		this._initConfig = options
		this._mainEnv = options.mainEnv
		this._ready = new Promise<void>((res, rej) => {
			this._readyResolve = res
			this._readyReject = rej
		})

		this._worker = new Worker(WORKER_ENTRY)
		this._wsBridge = new MainWsBridge(cmd => this._send(cmd))
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
						workerName: this._initConfig.workerName,
						browserConfig: this._initConfig.browserConfig,
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
			case 'binding-call':
				this._dispatchBindingCall(msg.id, msg.target, msg.method, msg.args)
				break
			case 'binding-fetch':
				this._dispatchBindingFetch(msg.id, msg.target, msg.request)
				break
			case 'wait-until-add':
				this._pendingWaitUntil++
				break
			case 'wait-until-settle':
				// `Math.max(0, ...)` guards against any future double-post slipping
				// through (e.g. if the worker handler gains a second listener).
				this._pendingWaitUntil = Math.max(0, this._pendingWaitUntil - 1)
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
				this._wsBridge.deliverWorkerSend(msg.wsId, msg.data)
				break
			case 'ws-worker-close':
				this._wsBridge.deliverWorkerClose(msg.wsId, msg.code, msg.reason)
				break
		}
	}

	/** Background `waitUntil` promises still in flight on the worker side. */
	pendingWaitUntil(): number {
		return this._pendingWaitUntil
	}

	private _resolveBinding(target: BindingTarget): Record<string, unknown> {
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

	private async _dispatchBindingCall(id: number, target: BindingTarget, method: string, args: unknown[]): Promise<void> {
		try {
			const resolved = this._resolveBinding(target)
			const fn = resolved[method]
			if (typeof fn !== 'function') {
				throw new Error(`Binding "${target.binding}" has no method "${method}"`)
			}
			const value = await (fn as (...a: unknown[]) => unknown).call(resolved, ...reifyArgs(args))
			this._send({ type: 'binding-result', id, value })
		} catch (e) {
			this._send({ type: 'binding-error', id, error: serializeError(e) })
		}
	}

	private async _dispatchBindingFetch(id: number, target: BindingTarget, req: SerializedRequest): Promise<void> {
		try {
			const resolved = this._resolveBinding(target)
			const fetch = resolved.fetch
			if (typeof fetch !== 'function') {
				throw new Error(`Binding "${target.binding}" has no fetch() method`)
			}
			const response = await (fetch as (r: Request) => Promise<Response>).call(resolved, deserializeRequest(req))
			const serialized = await serializeResponse(response)
			const ws = (response as ResponseWithWebSocket).webSocket
			if (response.status === 101 && ws instanceof CFWebSocket) {
				serialized.webSocketId = this._wsBridge.adoptExisting(ws)
			}
			this._send({ type: 'binding-fetch-result', id, response: serialized })
		} catch (e) {
			this._send({ type: 'binding-fetch-error', id, error: serializeError(e) })
		}
	}

	/** Resolves when the worker has imported the user module successfully. */
	ready(): Promise<void> {
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
	): Promise<T> {
		if (this._disposed) throw new Error('Worker-thread executor disposed')
		await this._ready
		const active = getActiveContext()
		const parent: ParentSpanContext | undefined = active ? { traceId: active.traceId, spanId: active.spanId } : undefined
		const id = this._nextId++
		return new Promise<T>((resolve, reject) => {
			map.set(id, { resolve, reject })
			this._send(build(id, parent))
		})
	}

	async executeFetch(request: Request, props?: Record<string, unknown>): Promise<Response> {
		const req = await serializeRequest(request)
		const serialized = await this._sendAndAwait(this._pending, (id, parent) => ({ type: 'fetch', id, request: req, parent, props }))

		const response = deserializeResponse(serialized) as ResponseWithWebSocket
		if (serialized.webSocketId) {
			// If the id was adopted earlier (e.g. WS came back through a DO/service
			// binding fetch), reuse that real CFWebSocket so `Bun.serve.upgrade`
			// gets the actual peer instead of a fresh bridge.
			response.webSocket = this._wsBridge.getSocket(serialized.webSocketId) ?? this._wsBridge.createSocket(serialized.webSocketId)
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
		const err = new Error('Worker thread terminated')
		for (const [, pending] of this._pending) pending.reject(err)
		for (const [, pending] of this._pendingHandlers) pending.reject(err)
		for (const [, pending] of this._pendingRpc) pending.reject(err)
		this._pending.clear()
		this._pendingHandlers.clear()
		this._pendingRpc.clear()
		this._wsBridge.disposeAll()
	}
}
