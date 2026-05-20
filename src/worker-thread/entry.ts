/** Worker-thread entry: imports user module, builds env, dispatches fetch. */

import type { SerializedError, SerializedRequest, SerializedResponse, WorkerCommand, WorkerInitConfig, WorkerMessage } from './protocol'

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

async function serializeResponse(response: Response): Promise<SerializedResponse> {
	const headers: [string, string][] = []
	response.headers.forEach((v, k) => headers.push([k, v]))
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

	const { buildThreadEnv } = await import('./thread-env')
	const { RpcClient } = await import('./rpc-client')
	const { WorkerExecutionContext } = await import('./execution-context')
	const rpc = new RpcClient(post)
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
		if (cmd.type === 'fetch') {
			try {
				const request = await deserializeRequest(cmd.request)
				const response = await callFetch(request)
				const serialized = await serializeResponse(response)
				post({ type: 'fetch-result', id: cmd.id, response: serialized })
			} catch (e) {
				post({ type: 'fetch-error', id: cmd.id, error: serializeError(e) })
			}
		}
	}

	post({ type: 'ready' })
}
