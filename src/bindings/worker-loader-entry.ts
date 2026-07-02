/**
 * Worker-thread entry for the `worker_loaders` binding.
 *
 * The main thread spawns this file as a Worker, sends an init message with
 * the path to the dynamically-written main module + a serializable `env`
 * object, then dispatches RPC commands. Each command invokes either the
 * default export's `fetch()` (HTTP), `scheduled()` (cron), or a named method
 * on a named entrypoint class.
 *
 * This is "fuzzy" isolation — the worker thread has its own heap and module
 * graph but shares the same process, so `fetch()` / `connect()` / filesystem
 * access behave identically to the parent.
 */

import { serializeResponseHeaders } from '../worker-thread/serialize'

declare var self: Worker

export interface LoaderInitMessage {
	type: 'init'
	mainModulePath: string
	env: unknown
	globalOutbound: 'allow' | 'block'
}

export type LoaderCommand =
	| { type: 'fetch'; entrypoint?: string; url: string; method: string; headers: [string, string][]; body: ArrayBuffer | null }
	| { type: 'scheduled'; entrypoint?: string; cron: string; scheduledTime: number }
	| { type: 'rpc-call'; entrypoint?: string; method: string; args: unknown[] }

export type LoaderResult =
	| { type: 'fetch'; status: number; statusText: string; headers: [string, string][]; body: ArrayBuffer | null }
	| { type: 'scheduled' }
	| { type: 'rpc-call'; value: unknown }
	| { type: 'error'; message: string; stack?: string; name?: string }

export type MainToWorker = { type: 'init'; data: LoaderInitMessage } | { type: 'command'; id: number; command: LoaderCommand }
export type WorkerToMain = { type: 'need-init' } | { type: 'ready' } | { type: 'result'; id: number; result: LoaderResult }

let loadedModule: Record<string, unknown> | null = null
let loaderEnv: unknown = {}
let networkBlocked = false

self.onmessage = async (event: MessageEvent<MainToWorker>) => {
	const msg = event.data
	if (msg.type === 'init') {
		try {
			await init(msg.data)
			self.postMessage({ type: 'ready' } satisfies WorkerToMain)
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			self.postMessage(
				{
					type: 'result',
					id: -1,
					result: { type: 'error', message: `Worker init failed: ${error.message}`, stack: error.stack, name: error.name },
				} satisfies WorkerToMain,
			)
		}
		return
	}
	if (msg.type === 'command') {
		const result = await handleCommand(msg.command)
		self.postMessage({ type: 'result', id: msg.id, result } satisfies WorkerToMain)
	}
}

self.postMessage({ type: 'need-init' } satisfies WorkerToMain)

async function init(data: LoaderInitMessage): Promise<void> {
	loaderEnv = data.env ?? {}
	networkBlocked = data.globalOutbound === 'block'
	if (networkBlocked) {
		const originalFetch = globalThis.fetch
		globalThis.fetch = ((() => {
			throw new Error('Dynamic Worker has globalOutbound=null — fetch() is blocked')
		}) as unknown) as typeof globalThis.fetch // Keep reference so any test that stubs fetch is still observable
		;(globalThis as unknown as { __lopata_original_fetch?: typeof originalFetch }).__lopata_original_fetch = originalFetch
	}
	loadedModule = await import(data.mainModulePath) as Record<string, unknown>
}

function resolveEntrypoint(name?: string): Record<string, unknown> {
	if (!loadedModule) throw new Error('Worker not initialized')
	if (name) {
		const exp = loadedModule[name]
		if (!exp) throw new Error(`Entrypoint "${name}" not exported from main module`)
		// If the export is a class, instantiate it (WorkerEntrypoint-style)
		if (typeof exp === 'function') {
			const ctx = { waitUntil() {}, passThroughOnException() {} }
			try {
				return new (exp as new(ctx: unknown, env: unknown) => Record<string, unknown>)(ctx, loaderEnv)
			} catch {
				return exp as unknown as Record<string, unknown>
			}
		}
		return exp as Record<string, unknown>
	}
	const def = loadedModule.default
	if (!def) throw new Error('Main module has no default export')
	return def as Record<string, unknown>
}

async function handleCommand(cmd: LoaderCommand): Promise<LoaderResult> {
	try {
		const entrypoint = resolveEntrypoint(cmd.entrypoint)
		if (cmd.type === 'fetch') {
			const handler = entrypoint.fetch as ((req: Request, env: unknown, ctx: unknown) => Response | Promise<Response>) | undefined
			if (typeof handler !== 'function') throw new Error('Entrypoint has no fetch() handler')
			const request = new Request(cmd.url, {
				method: cmd.method,
				headers: cmd.headers,
				body: cmd.body ? cmd.body : null,
			})
			const ctx = { waitUntil(_p: Promise<unknown>) {}, passThroughOnException() {} }
			const response = await handler.call(entrypoint, request, loaderEnv, ctx)
			const buf = await response.arrayBuffer()
			return {
				type: 'fetch',
				status: response.status,
				statusText: response.statusText,
				headers: serializeResponseHeaders(response),
				body: buf.byteLength ? buf : null,
			}
		}
		if (cmd.type === 'scheduled') {
			const handler = entrypoint.scheduled as ((event: unknown, env: unknown, ctx: unknown) => unknown) | undefined
			if (typeof handler !== 'function') throw new Error('Entrypoint has no scheduled() handler')
			const event = { cron: cmd.cron, scheduledTime: cmd.scheduledTime, type: 'scheduled' }
			const ctx = { waitUntil(_p: Promise<unknown>) {}, passThroughOnException() {} }
			await handler.call(entrypoint, event, loaderEnv, ctx)
			return { type: 'scheduled' }
		}
		if (cmd.type === 'rpc-call') {
			const fn = entrypoint[cmd.method]
			if (typeof fn !== 'function') throw new Error(`Method "${cmd.method}" is not a function on entrypoint`)
			const value = await (fn as (...args: unknown[]) => unknown).apply(entrypoint, cmd.args)
			return { type: 'rpc-call', value }
		}
		throw new Error(`Unknown command type: ${(cmd as { type: string }).type}`)
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err))
		return { type: 'error', message: error.message, stack: error.stack, name: error.name }
	}
}
