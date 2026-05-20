/**
 * Worker-thread entry point.
 *
 * Phase 0: imports the user module with env = {} and dispatches `fetch`
 * commands. No bindings, no tracing, no waitUntil. Bindings + ctx wiring
 * land in later phases.
 */

import type { SerializedError, SerializedRequest, SerializedResponse, WorkerCommand, WorkerMessage } from './protocol'

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
		await initRuntime(msg.config.modulePath)
	} catch (e) {
		post({ type: 'init-error', error: serializeError(e) })
	}
}

post({ type: 'need-init' })

async function initRuntime(modulePath: string) {
	// Register Bun plugins for cloudflare:workers, cloudflare:workflows, etc.
	await import('../plugin')

	const workerModule = await import(modulePath)
	const defaultExport = workerModule.default

	const env: Record<string, unknown> = {}

	const callFetch = async (request: Request): Promise<Response> => {
		if (typeof defaultExport === 'function' && defaultExport.prototype?.fetch) {
			// Class-based entrypoint
			const Ctor = defaultExport as new(ctx: unknown, env: unknown) => { fetch: (r: Request) => Promise<Response> }
			const ctx = {} // placeholder until Phase 3
			const instance = new Ctor(ctx, env)
			return instance.fetch(request)
		}
		if (defaultExport && typeof defaultExport.fetch === 'function') {
			return defaultExport.fetch(request, env, {}) as Promise<Response>
		}
		throw new Error('Worker module does not export a fetch handler')
	}

	self.onmessage = async (event: MessageEvent<WorkerCommand>) => {
		const cmd = event.data
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
