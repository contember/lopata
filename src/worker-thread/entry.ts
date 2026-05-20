/** Worker-thread entry: imports user module, builds env, dispatches fetch. */

import { CFWebSocket, type ResponseWithWebSocket } from '../bindings/websocket-pair'
import { runWithContext } from '../tracing/context'
import { setTraceStoreOverride } from '../tracing/store'
import { WorkerExecutionContext } from './execution-context'
import type { SerializedError, SerializedRequest, SerializedResponse, WorkerCommand, WorkerInitConfig, WorkerMessage } from './protocol'
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

	self.onmessage = async (event: MessageEvent<WorkerCommand>) => {
		const cmd = event.data
		if (rpc.handle(cmd)) return
		switch (cmd.type) {
			case 'fetch':
				try {
					const request = await deserializeRequest(cmd.request)
					const response = cmd.parent
						? await runWithContext({ traceId: cmd.parent.traceId, spanId: cmd.parent.spanId, fetchStack: { current: null }, subrequests: { count: 0 } }, () => callFetch(request))
						: await callFetch(request)
					const serialized = await serializeResponse(response, wsBridge)
					post({ type: 'fetch-result', id: cmd.id, response: serialized })
				} catch (e) {
					post({ type: 'fetch-error', id: cmd.id, error: serializeError(e) })
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
