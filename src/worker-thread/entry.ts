/** Worker-thread entry: imports user module, builds env, dispatches fetch. */

import { ForwardableEmailMessage } from '../bindings/email'
import { createScheduledController } from '../bindings/scheduled'
import { CFWebSocket, type ResponseWithWebSocket } from '../bindings/websocket-pair'
import { getDatabase } from '../db'
import { runWithParentContext } from '../tracing/context'
import { setTraceStoreOverride } from '../tracing/store'
import { WorkerExecutionContext } from './execution-context'
import type { SerializedError, SerializedResponse, WorkerCommand, WorkerHandlerName, WorkerInitConfig, WorkerMessage } from './protocol'
import { RemoteTraceStore } from './remote-trace-store'
import { RpcClient } from './rpc-client'
import { deserializeRequest, serializeResponse as serializeResponseShared } from './serialize'
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

async function serializeResponse(response: Response, ws: WorkerWsBridge): Promise<SerializedResponse> {
	const cfSocket = (response as ResponseWithWebSocket).webSocket
	if (response.status === 101 && cfSocket instanceof CFWebSocket) {
		const headers: [string, string][] = []
		response.headers.forEach((v, k) => headers.push([k, v]))
		return {
			status: response.status,
			statusText: response.statusText,
			headers,
			body: null,
			webSocketId: ws.register(cfSocket),
		}
	}
	return serializeResponseShared(response)
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

	const callFetch = async (request: Request, props?: Record<string, unknown>): Promise<Response> => {
		const ctx = new WorkerExecutionContext(post, props)
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

	/** Resolve a named handler honoring class- vs object-based exports. */
	function resolveHandler(name: WorkerHandlerName, ctx: WorkerExecutionContext): ((...args: unknown[]) => Promise<unknown>) | null {
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
		const controller = createScheduledController(cronExpr, scheduledTime)
		await handler(controller, env, ctx)
		return { ok: true }
	}

	const callEmail = async (messageId: string, from: string, to: string, raw: Uint8Array): Promise<{ ok: boolean; noHandler?: boolean }> => {
		const ctx = new WorkerExecutionContext(post)
		const handler = resolveHandler('email', ctx)
		if (!handler) return { ok: false, noHandler: true }
		const message = new ForwardableEmailMessage(getDatabase(), messageId, from, to, raw)
		await handler(message, env, ctx)
		return { ok: true }
	}

	// When `noHandler:true` the `error.message` field is a wire-format placeholder —
	// the main-side executor resolves with `ok:false` rather than rejecting, so the
	// message is never surfaced to user code.
	self.onmessage = async (event: MessageEvent<WorkerCommand>) => {
		const cmd = event.data
		if (rpc.handle(cmd)) return
		switch (cmd.type) {
			case 'fetch':
				try {
					const request = deserializeRequest(cmd.request)
					const response = await runWithParentContext(cmd.parent, () => callFetch(request, cmd.props))
					const serialized = await serializeResponse(response, wsBridge)
					post({ type: 'fetch-result', id: cmd.id, response: serialized })
				} catch (e) {
					post({ type: 'fetch-error', id: cmd.id, error: serializeError(e) })
				}
				break
			case 'scheduled':
				try {
					const result = await runWithParentContext(cmd.parent, () => callScheduled(cmd.cronExpr, cmd.scheduledTime))
					if (!result.ok) post({ type: 'scheduled-error', id: cmd.id, error: { message: 'no-handler' }, noHandler: true })
					else post({ type: 'scheduled-result', id: cmd.id })
				} catch (e) {
					post({ type: 'scheduled-error', id: cmd.id, error: serializeError(e) })
				}
				break
			case 'email':
				try {
					const result = await runWithParentContext(cmd.parent, () => callEmail(cmd.messageId, cmd.from, cmd.to, cmd.raw))
					if (!result.ok) post({ type: 'email-error', id: cmd.id, error: { message: 'no-handler' }, noHandler: true })
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
