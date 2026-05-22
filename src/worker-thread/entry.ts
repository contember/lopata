/** Worker-thread entry: imports user module, builds env, dispatches fetch. */

import { ForwardableEmailMessage } from '../bindings/email'
import { createScheduledController } from '../bindings/scheduled'
import { resolveEntrypointTarget } from '../bindings/service-binding'
import { CFWebSocket, type ResponseWithWebSocket } from '../bindings/websocket-pair'
import { getDatabase } from '../db'
import { getActiveContext, runWithParentContext } from '../tracing/context'
import { setTraceStoreOverride } from '../tracing/store'
import { WorkerExecutionContext } from './execution-context'
import type { ParentSpanContext, SerializedResponse, WorkerCommand, WorkerHandlerName, WorkerInitConfig, WorkerMessage } from './protocol'
import { serializeError } from './protocol'
import { RemoteTraceStore } from './remote-trace-store'
import { RpcClient } from './rpc-shared'
import { deserializeRequest, serializeResponse as serializeResponseShared } from './serialize'
import { buildThreadEnv } from './thread-env'
import { startThreadQueueConsumers, wireWorkflows } from './wire-handlers'
import { WsGuestBridge } from './ws-bridge-shared'

declare var self: Worker

function post(msg: WorkerMessage): void {
	postMessage(msg)
}

async function serializeResponse(response: Response, ws: WsGuestBridge<WorkerMessage>): Promise<SerializedResponse> {
	const cfSocket = (response as ResponseWithWebSocket).webSocket as
		| CFWebSocket
		| { __bridgedWsId: string }
		| undefined
	if (response.status === 101 && cfSocket) {
		const headers: [string, string][] = []
		response.headers.forEach((v, k) => headers.push([k, v]))
		const base = { status: response.status, statusText: response.statusText, headers, body: null }
		if (cfSocket instanceof CFWebSocket) {
			return { ...base, webSocketId: ws.register(cfSocket) }
		}
		// Peer was adopted on main during a nested binding fetch — just reship its id.
		return { ...base, webSocketId: cfSocket.__bridgedWsId }
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

	const getParent = (): ParentSpanContext | undefined => {
		const active = getActiveContext()
		return active ? { traceId: active.traceId, spanId: active.spanId } : undefined
	}
	const rpc = new RpcClient(post, getParent)
	const wsBridge = new WsGuestBridge<WorkerMessage>(post, {
		remoteMessage: (wsId, data) => ({ type: 'ws-worker-send', wsId, data }),
		// User-worker channel doesn't propagate wasClean — drop it (matches the
		// pre-refactor wire format in `protocol.ts`).
		remoteClose: (wsId, code, reason, _wasClean) => ({ type: 'ws-worker-close', wsId, code, reason }),
	})
	const built = buildThreadEnv({ config: init.config, baseDir: init.baseDir, rpc, browserConfig: init.browserConfig })
	const { env } = built

	const workerModule = await import(init.modulePath)
	const defaultExport = workerModule.default

	// Introspect DO + container classes for `alarm()` so main's
	// `DurableObjectNamespaceImpl.hasAlarmHandler()` returns the right value in
	// thread mode (main itself doesn't load the user module, so without this
	// hint it would shortcircuit to `false`).
	const doAlarmHandlers: Record<string, boolean> = {}
	const collectAlarmHandler = (className: string) => {
		if (doAlarmHandlers[className] !== undefined) return
		const cls = (workerModule as Record<string, unknown>)[className] as
			| { prototype?: { alarm?: unknown } }
			| undefined
		doAlarmHandlers[className] = typeof cls?.prototype?.alarm === 'function'
	}
	for (const binding of init.config.durable_objects?.bindings ?? []) {
		collectAlarmHandler(binding.class_name)
	}
	for (const container of init.config.containers ?? []) {
		collectAlarmHandler(container.class_name)
	}

	wireWorkflows(built, workerModule)
	// `Worker.terminate()` (called on reload) clears the consumer's setInterval
	// timers, so no graceful-shutdown handle is needed here.
	startThreadQueueConsumers(init.config, built.db, env, workerModule, init.workerName)

	const invokeEntrypointRpc = async (
		entrypoint: string | undefined,
		method: string,
		args: unknown[],
		props?: Record<string, unknown>,
	): Promise<unknown> => {
		const ctx = new WorkerExecutionContext(post, props)
		const target = resolveEntrypointTarget(workerModule, entrypoint, ctx, env)
		const member = target?.[method]
		if (typeof member !== 'function') {
			throw new Error(`Service binding RPC: "${method}" is not a function on the ${entrypoint ?? 'default'} entrypoint`)
		}
		return await (member as (...a: unknown[]) => unknown).call(target, ...args)
	}

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
		if (rpc.handle(cmd as { type: string })) return
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
			case 'entrypoint-rpc':
				try {
					const value = await runWithParentContext(cmd.parent, () => invokeEntrypointRpc(cmd.entrypoint, cmd.method, cmd.args, cmd.props))
					post({ type: 'entrypoint-rpc-result', id: cmd.id, value })
				} catch (e) {
					post({ type: 'entrypoint-rpc-error', id: cmd.id, error: serializeError(e) })
				}
				break
		}
	}

	post({ type: 'ready', doAlarmHandlers })
}
