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

import { type CompatibilitySelection, resolveCompatibility } from '../compatibility'
import { initializeIsolateCompatibility } from '../compatibility-context'
import { constructEntrypoint, type EntrypointHandlerName, handlerFromInstance, isClassEntrypoint } from '../entrypoint-handler'
import { setGlobalEnv } from '../env'
import { ExecutionContext } from '../execution-context'
import { registerModuleRules } from '../module-rules'
import { setGlobalExports } from '../worker-exports'
import { deserializeError } from '../worker-thread/protocol'
import { serializeResponseHeaders } from '../worker-thread/serialize'
import { buildLoopbackExports } from './loopback-exports'
import { FETCHER_BRAND, makeBindingProxy } from './rpc-stub'
import { isWorkerResponse } from './worker-dispatcher'
import { ENV_FETCHER_KEY, type LoaderEnvReply, type LoaderEnvRequest, type LoaderEnvResult } from './worker-loader-env'

declare var self: Worker

export interface LoaderInitMessage {
	type: 'init'
	mainModulePath: string
	env: Record<string, unknown>
	globalOutbound: 'allow' | 'block'
	compatibility: CompatibilitySelection
}

/** `entrypoint` is undefined for the default export; `props` is the handle's encoded snapshot. */
export type LoaderCommand =
	& { entrypoint?: string; props: Record<string, unknown> }
	& (
		| { type: 'fetch'; url: string; method: string; headers: [string, string][]; body: ArrayBuffer | null }
		| { type: 'scheduled'; cron: string; scheduledTime: number }
		| { type: 'rpc-call'; method: string; args: unknown[] }
	)

export type LoaderResult =
	| { type: 'fetch'; status: number; statusText: string; headers: [string, string][]; body: ArrayBuffer | null }
	| { type: 'scheduled' }
	| { type: 'rpc-call'; value: unknown }
	| { type: 'error'; message: string; stack?: string; name?: string }

export type MainToWorker = { type: 'init'; data: LoaderInitMessage } | { type: 'command'; id: number; command: LoaderCommand } | LoaderEnvReply
export type WorkerToMain = { type: 'need-init' } | { type: 'ready' } | { type: 'result'; id: number; result: LoaderResult } | LoaderEnvRequest

let loadedModule: Record<string, unknown> | null = null
let loaderEnv: Record<string, unknown> = {}
let networkBlocked = false
let ctxExportsEnabled = false

self.onmessage = async (event: MessageEvent<MainToWorker>) => {
	const msg = event.data
	if (msg.type === 'env-result') {
		settleEnvRequest(msg)
		return
	}
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

interface PendingEnvRequest {
	resolve: (result: LoaderEnvResult) => void
}

const pendingEnvRequests = new Map<number, PendingEnvRequest>()
let nextEnvRequestId = 1

function requestHost(build: (id: number) => LoaderEnvRequest): Promise<LoaderEnvResult> {
	const id = nextEnvRequestId++
	return new Promise(resolve => {
		pendingEnvRequests.set(id, { resolve })
		self.postMessage(build(id) satisfies WorkerToMain)
	})
}

function settleEnvRequest(reply: LoaderEnvReply): void {
	const pending = pendingEnvRequests.get(reply.id)
	if (!pending) return
	pendingEnvRequests.delete(reply.id)
	pending.resolve(reply.result)
}

function unwrapValue(result: LoaderEnvResult): unknown {
	if (result.type === 'error') throw deserializeError(result.error)
	if (result.type !== 'value') throw new Error(`Unexpected env reply "${result.type}"`)
	return result.value
}

/** Stub for a Fetcher the host kept: every fetch, call and property read goes back to the host. */
function makeHostFetcher(slot: number): Record<string, unknown> {
	return makeBindingProxy(
		{
			fetch: async (input, init) => {
				const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init)
				const body = request.body ? await request.arrayBuffer() : null
				const result = await requestHost(id => ({
					type: 'env-fetch',
					id,
					slot,
					request: { url: request.url, method: request.method, headers: Array.from(request.headers.entries()), body },
				}))
				if (result.type === 'error') throw deserializeError(result.error)
				if (result.type !== 'response') throw new Error(`Unexpected env reply "${result.type}"`)
				return new Response(result.body, { status: result.status, statusText: result.statusText, headers: result.headers })
			},
			call: async (method, args) => unwrapValue(await requestHost(id => ({ type: 'env-call', id, slot, method, args }))),
			getProperty: async property => unwrapValue(await requestHost(id => ({ type: 'env-get', id, slot, property }))),
		},
		{ [FETCHER_BRAND]: true },
	)
}

function decodeEnvObject(value: object): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [key, entry] of Object.entries(value)) {
		out[key] = decodeEnv(entry)
	}
	return out
}

function decodeEnv(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(decodeEnv)
	if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) return value
	const slot: unknown = Reflect.get(value, ENV_FETCHER_KEY)
	if (typeof slot === 'number') return makeHostFetcher(slot)
	return decodeEnvObject(value)
}

async function init(data: LoaderInitMessage): Promise<void> {
	const compatibility = resolveCompatibility({ date: data.compatibility.date ?? undefined, flags: data.compatibility.flags })
	initializeIsolateCompatibility(compatibility)
	// Plugins are per thread: `cloudflare:workers`, `caches`, `HTMLRewriter` and `WebSocketPair` must be registered here.
	await import('../plugin')
	registerModuleRules(undefined)
	ctxExportsEnabled = compatibility.ctxExports === 'enabled'
	loaderEnv = decodeEnvObject(data.env)
	setGlobalEnv(loaderEnv)
	networkBlocked = data.globalOutbound === 'block'
	if (networkBlocked) {
		const originalFetch = globalThis.fetch
		globalThis.fetch = ((() => {
			throw new Error('Dynamic Worker has globalOutbound=null — fetch() is blocked')
		}) as unknown) as typeof globalThis.fetch // Keep reference so any test that stubs fetch is still observable
		;(globalThis as unknown as { __lopata_original_fetch?: typeof originalFetch }).__lopata_original_fetch = originalFetch
	}
	const workerModule: Record<string, unknown> = await import(data.mainModulePath)
	setGlobalExports(buildLoopbackExports(workerModule, loaderEnv, []))
	loadedModule = workerModule
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

/** The per-invocation `ctx`; `ctx.exports` exists only when the dynamic worker's compatibility enables it. */
function createExecutionContext(props: Record<string, unknown>): ExecutionContext {
	const ctx = new ExecutionContext(props)
	if (!ctxExportsEnabled) Object.defineProperty(ctx, 'exports', { value: undefined })
	return ctx
}

/** Construct a class entrypoint for this invocation, as workerd does, or return the handler object. */
function instantiateEntrypoint(name: string | undefined, ctx: ExecutionContext): Record<string, unknown> {
	if (!loadedModule) throw new Error('Worker not initialized')
	const exported = name === undefined ? loadedModule.default : Object.hasOwn(loadedModule, name) ? loadedModule[name] : undefined
	if (isClassEntrypoint(exported)) return constructEntrypoint(exported, ctx, loaderEnv)
	if (isRecord(exported)) return exported
	throw new Error(name === undefined ? 'Worker has no default entrypoint.' : `Worker has no such entrypoint: ${name}`)
}

function requireHandler(instance: Record<string, unknown>, name: EntrypointHandlerName): (...args: unknown[]) => unknown {
	const handler = handlerFromInstance(instance, name)
	if (!handler) throw new Error(`Handler does not export a ${name}() function.`)
	return handler
}

async function handleCommand(cmd: LoaderCommand): Promise<LoaderResult> {
	try {
		const ctx = createExecutionContext(decodeEnvObject(cmd.props))
		const entrypoint = instantiateEntrypoint(cmd.entrypoint, ctx)
		if (cmd.type === 'fetch') {
			const request = new Request(cmd.url, {
				method: cmd.method,
				headers: cmd.headers,
				body: cmd.body ? cmd.body : null,
			})
			const response = await requireHandler(entrypoint, 'fetch')(request, loaderEnv, ctx)
			if (!isWorkerResponse(response)) throw new TypeError('Worker fetch must return a Response')
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
			const event = { cron: cmd.cron, scheduledTime: cmd.scheduledTime, type: 'scheduled' }
			await requireHandler(entrypoint, 'scheduled')(event, loaderEnv, ctx)
			return { type: 'scheduled' }
		}
		const method = entrypoint[cmd.method]
		if (typeof method !== 'function') throw new Error(`Method "${cmd.method}" is not a function on entrypoint`)
		const value: unknown = await Reflect.apply(method, entrypoint, cmd.args)
		return { type: 'rpc-call', value }
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err))
		return { type: 'error', message: error.message, stack: error.stack, name: error.name }
	}
}
