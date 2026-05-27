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
import { deserializeError, serializeError } from './protocol'
import { RemoteTraceStore } from './remote-trace-store'
import { RpcClient } from './rpc-shared'
import { deserializeRequest } from './serialize'
import { OutboundStreamRegistry, pumpStream, StreamReceiver } from './stream-shared'
import { buildThreadEnv } from './thread-env'
import { startThreadQueueConsumers, wireWorkflows } from './wire-handlers'
import { WsGuestBridge } from './ws-bridge-shared'

declare var self: Worker

function post(msg: WorkerMessage): void {
	postMessage(msg)
}

/** Outbound response-body pumps for the top-level fetch response (worker →
 *  main). Inbound `stream-cancel` (client disconnected) stops the source. */
const responseStreams = new OutboundStreamRegistry()
/** Active reconstructed top-level request bodies (main → worker). Chunks
 *  arriving before user code pulls the body queue inside the receiver. */
const requestStreams = new StreamReceiver((streamId) => {
	post({ type: 'req-stream-cancel', streamId })
})

/**
 * Serialize response status + headers only — the body is never buffered here.
 * WS upgrades carry a `webSocketId`; every other body is streamed via a
 * `streamId` (see `pumpResponseBody`). Buffering bodies via `arrayBuffer()` is
 * what made unbounded responses (SSE, chunked) hang forever.
 */
function serializeResponse(response: Response, ws: WsGuestBridge<WorkerMessage>): SerializedResponse {
	const cfSocket = (response as ResponseWithWebSocket).webSocket as
		| CFWebSocket
		| { __bridgedWsId: string }
		| undefined
	const headers: [string, string][] = []
	response.headers.forEach((v, k) => headers.push([k, v]))
	const base = { status: response.status, statusText: response.statusText, headers, body: null }
	if (response.status === 101 && cfSocket) {
		if (cfSocket instanceof CFWebSocket) {
			return { ...base, webSocketId: ws.register(cfSocket) }
		}
		// Peer was adopted on main during a nested binding fetch — just reship its id.
		return { ...base, webSocketId: cfSocket.__bridgedWsId }
	}
	if (response.body) {
		return { ...base, streamId: responseStreams.allocateId() }
	}
	return base
}

type StreamChunkMsg = Extract<WorkerMessage, { type: 'stream-chunk' }>
type StreamEndMsg = Extract<WorkerMessage, { type: 'stream-end' }>
type StreamErrorMsg = Extract<WorkerMessage, { type: 'stream-error' }>

/** Pump a response body to main as `stream-chunk`s, terminated by `stream-end`
 *  or `stream-error`. Started only after `fetch-result` is posted so main has
 *  the `streamId` registered before chunks arrive. */
function pumpResponseBody(streamId: number, body: ReadableStream<Uint8Array>): void {
	pumpStream<StreamChunkMsg, StreamEndMsg, StreamErrorMsg>(streamId, body, responseStreams, post, {
		chunk: (id, chunk) => ({ type: 'stream-chunk', id, chunk }),
		end: (id) => ({ type: 'stream-end', id }),
		error: (id, error) => ({ type: 'stream-error', id, error }),
	})
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
					const reqBody = cmd.request.streamId !== undefined ? requestStreams.open(cmd.request.streamId) : undefined
					const request = deserializeRequest(cmd.request, reqBody)
					const response = await runWithParentContext(cmd.parent, () => callFetch(request, cmd.props))
					const serialized = serializeResponse(response, wsBridge)
					post({ type: 'fetch-result', id: cmd.id, response: serialized })
					if (serialized.streamId !== undefined && response.body) {
						pumpResponseBody(serialized.streamId, response.body)
					}
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
			case 'stream-cancel':
				responseStreams.cancel(cmd.id)
				break
			case 'req-stream-chunk':
				requestStreams.push(cmd.streamId, cmd.chunk)
				break
			case 'req-stream-end':
				requestStreams.end(cmd.streamId)
				break
			case 'req-stream-error':
				requestStreams.error(cmd.streamId, deserializeError(cmd.error))
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
