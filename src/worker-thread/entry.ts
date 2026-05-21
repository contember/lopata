/** Worker-thread entry: imports user module, builds env, dispatches fetch. */

import { CFWebSocket, type ResponseWithWebSocket } from '../bindings/websocket-pair'
import { runWithContext } from '../tracing/context'
import { setTraceStoreOverride } from '../tracing/store'
import { WorkerExecutionContext } from './execution-context'
import type {
	ParentSpanContext,
	SerializedError,
	SerializedRequest,
	SerializedResponse,
	WorkerCommand,
	WorkerInitConfig,
	WorkerMessage,
} from './protocol'
import { RemoteTraceStore } from './remote-trace-store'
import { RpcClient } from './rpc-client'
import { buildThreadEnv } from './thread-env'
import { WorkerWsBridge } from './ws-bridge'

declare var self: Worker

function serializeError(e: unknown): SerializedError {
	const err = e instanceof Error ? e : new Error(String(e))
	return { message: err.message, stack: err.stack, name: err.name }
}

function post(msg: WorkerMessage): void {
	postMessage(msg)
}

async function deserializeRequest(req: SerializedRequest): Promise<Request> {
	return new Request(req.url, {
		method: req.method,
		headers: req.headers,
		body: req.body,
	})
}

async function serializeResponse(response: Response, ws: WorkerWsBridge): Promise<SerializedResponse> {
	const headers: [string, string][] = []
	response.headers.forEach((v, k) => headers.push([k, v]))
	const cfSocket = (response as ResponseWithWebSocket).webSocket
	if (response.status === 101 && cfSocket instanceof CFWebSocket) {
		return {
			status: response.status,
			statusText: response.statusText,
			headers,
			body: null,
			webSocketId: ws.register(cfSocket),
		}
	}
	const body = response.body ? await response.arrayBuffer() : null
	return { status: response.status, statusText: response.statusText, headers, body }
}

self.onmessage = async (event: MessageEvent<WorkerCommand>) => {
	const msg = event.data
	if (msg.type !== 'init') return

	try {
		await initRuntime(msg.config)
	} catch (e) {
		post({ type: 'init-error', error: serializeError(e) })
	}
}

post({ type: 'need-init' })

async function initRuntime(init: WorkerInitConfig) {
	// Plugin import must run before user code so Bun.plugin().module() intercepts
	// `cloudflare:workers` etc. and `globalThis.caches` is patched in.
	await import('../plugin')

	// Route all tracing operations through main so the dashboard's subscribers fire.
	setTraceStoreOverride(new RemoteTraceStore(post))

	const rpc = new RpcClient(post)
	const wsBridge = new WorkerWsBridge(post)
	const env = buildThreadEnv({ config: init.config, baseDir: init.baseDir, rpc })

	const workerModule = await import(init.modulePath)
	const defaultExport = workerModule.default

	const callFetch = async (request: Request): Promise<Response> => {
		const ctx = new WorkerExecutionContext(post)
		if (typeof defaultExport === 'function' && defaultExport.prototype?.fetch) {
			const Ctor = defaultExport as new(ctx: unknown, env: unknown) => { fetch: (r: Request) => Promise<Response> }
			const instance = new Ctor(ctx, env)
			return instance.fetch(request)
		}
		if (defaultExport && typeof defaultExport.fetch === 'function') {
			return defaultExport.fetch(request, env, ctx) as Promise<Response>
		}
		throw new Error('Worker module does not export a fetch handler')
	}

	/** Resolve the named handler ('scheduled' / 'email' / 'queue') honoring class- vs object-based exports. */
	function resolveHandler(name: 'scheduled' | 'email' | 'queue', ctx: WorkerExecutionContext): ((...args: unknown[]) => Promise<unknown>) | null {
		if (typeof defaultExport === 'function' && defaultExport.prototype) {
			const fn = defaultExport.prototype[name]
			if (typeof fn !== 'function') return null
			const Ctor = defaultExport as new(ctx: unknown, env: unknown) => Record<string, (...args: unknown[]) => Promise<unknown>>
			const instance = new Ctor(ctx, env)
			return instance[name]!.bind(instance)
		}
		const obj = defaultExport as Record<string, unknown> | null | undefined
		const fn = obj?.[name]
		return typeof fn === 'function' ? (fn as (...a: unknown[]) => Promise<unknown>).bind(obj) : null
	}

	const callScheduled = async (cronExpr: string, scheduledTime: number): Promise<{ ok: boolean; noHandler?: boolean }> => {
		const ctx = new WorkerExecutionContext(post)
		const handler = resolveHandler('scheduled', ctx)
		if (!handler) return { ok: false, noHandler: true }
		const { createScheduledController } = await import('../bindings/scheduled')
		const controller = createScheduledController(cronExpr, scheduledTime)
		await handler(controller, env, ctx)
		return { ok: true }
	}

	const callEmail = async (messageId: string, from: string, to: string, raw: Uint8Array): Promise<{ ok: boolean; noHandler?: boolean }> => {
		const ctx = new WorkerExecutionContext(post)
		const handler = resolveHandler('email', ctx)
		if (!handler) return { ok: false, noHandler: true }
		const { ForwardableEmailMessage } = await import('../bindings/email')
		const { getDatabase } = await import('../db')
		const message = new ForwardableEmailMessage(getDatabase(), messageId, from, to, raw)
		await handler(message, env, ctx)
		return { ok: true }
	}

	function withParent<T>(parent: ParentSpanContext | undefined, fn: () => Promise<T>): Promise<T> {
		if (!parent) return fn()
		return runWithContext({ traceId: parent.traceId, spanId: parent.spanId, fetchStack: { current: null }, subrequests: { count: 0 } }, fn)
	}

	self.onmessage = async (event: MessageEvent<WorkerCommand>) => {
		const cmd = event.data
		if (rpc.handle(cmd)) return
		switch (cmd.type) {
			case 'fetch':
				try {
					const request = await deserializeRequest(cmd.request)
					const response = await withParent(cmd.parent, () => callFetch(request))
					const serialized = await serializeResponse(response, wsBridge)
					post({ type: 'fetch-result', id: cmd.id, response: serialized })
				} catch (e) {
					post({ type: 'fetch-error', id: cmd.id, error: serializeError(e) })
				}
				break
			case 'scheduled':
				try {
					const result = await withParent(cmd.parent, () => callScheduled(cmd.cronExpr, cmd.scheduledTime))
					if (!result.ok) post({ type: 'scheduled-error', id: cmd.id, error: { message: 'No scheduled handler defined' }, noHandler: true })
					else post({ type: 'scheduled-result', id: cmd.id })
				} catch (e) {
					post({ type: 'scheduled-error', id: cmd.id, error: serializeError(e) })
				}
				break
			case 'email':
				try {
					const result = await withParent(cmd.parent, () => callEmail(cmd.messageId, cmd.from, cmd.to, new Uint8Array(cmd.raw)))
					if (!result.ok) post({ type: 'email-error', id: cmd.id, error: { message: 'No email handler defined' }, noHandler: true })
					else post({ type: 'email-result', id: cmd.id })
				} catch (e) {
					post({ type: 'email-error', id: cmd.id, error: serializeError(e) })
				}
				break
			case 'ws-client-message':
				wsBridge.deliverClientMessage(cmd.wsId, cmd.data)
				break
			case 'ws-client-close':
				wsBridge.deliverClientClose(cmd.wsId, cmd.code, cmd.reason, cmd.wasClean)
				break
		}
	}

	post({ type: 'ready' })
}
