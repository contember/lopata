/**
 * Local implementation of the Cloudflare `worker_loaders` binding.
 *
 * Exposes `env.LOADER.load(code)` / `env.LOADER.get(id, callback)`. Each load
 * spawns a Bun Worker thread (see `worker-loader-entry.ts`) that runs the
 * supplied code with its own module graph. Isolation is "fuzzy" — worker
 * threads share the process with the parent but have separate heaps.
 *
 * Modules are written to a random `.lopata/worker-loader/<uuid>/` directory per
 * stub before the Worker imports the entry point; a `get()` id is only a cache
 * key. This keeps the implementation simple at the cost of not supporting
 * languages Bun can't execute directly (CF's `py`, Rust, etc. are rejected in v1).
 */

import { randomUUIDv7 } from 'bun'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isProxy } from 'node:util/types'
import { type CompatibilitySelection, resolveCompatibility } from '../compatibility'
import { serializeError } from '../worker-thread/protocol'
import { serializeResponseHeaders } from '../worker-thread/serialize'
import { isLoopbackServiceStub } from './loopback-exports'
import { FETCHER_BRAND, isFetcher } from './rpc-stub'
import type { LoaderCommand, LoaderInitMessage, LoaderResult, MainToWorker, WorkerToMain } from './worker-loader-entry'
import { ENV_FETCHER_KEY, type EnvFetcherPlaceholder, type LoaderEnvRequest, type LoaderEnvResult } from './worker-loader-env'

export type WorkerCodeModule =
	| string
	| { js: string }
	| { cjs: string }
	| { text: string }
	| { data: ArrayBuffer }
	| { json: unknown }

export interface WorkerCode {
	compatibilityDate: string
	compatibilityFlags?: string[]
	mainModule: string
	modules: Record<string, WorkerCodeModule>
	env?: Record<string, unknown>
	globalOutbound?: unknown | null
	allowExperimental?: boolean
	tails?: unknown[]
	limits?: { cpuMs?: number; subRequests?: number }
}

const WORKER_ENTRY_PATH = resolve(dirname(new URL(import.meta.url).pathname), 'worker-loader-entry.ts')

interface PendingCommand {
	resolve: (result: LoaderResult) => void
	reject: (err: Error) => void
}

type CodeSource = WorkerCode | (() => WorkerCode | Promise<WorkerCode>)

/** Fetchers the dynamic worker reaches through placeholders in its env and in entrypoint props, indexed by slot. */
type FetcherTable = Record<string | symbol, unknown>[]

interface ResolvedCode {
	code: WorkerCode
	env: Record<string, unknown>
}

export interface EntrypointOptions {
	props?: Record<string, unknown>
	limits?: { cpuMs?: number; subRequests?: number }
}

export class WorkerStub {
	private readonly codeSource: CodeSource
	private readonly _fetchers: FetcherTable = []
	private _resolved: ResolvedCode | null = null
	private readonly workDir: string
	private _worker: Worker | null = null
	private _ready: Promise<void> | null = null
	/** Rejects the Worker's pending `ready` handshake; set while it is outstanding. */
	private _rejectReady: ((err: Error) => void) | null = null
	private _pending = new Map<number, PendingCommand>()
	private _nextCmdId = 1
	private _disposed = false
	/** Aborted by `dispose()`, so work that runs before a call is registered (reading a request body) stops too. */
	private readonly _disposal = new AbortController()
	private _disposeTimer: Timer | null = null

	constructor(code: CodeSource, baseDir: string) {
		this.codeSource = code
		this.workDir = join(baseDir, randomUUIDv7())
		if (typeof code !== 'function') {
			this._resolved = { code, env: encodeLoaderEnv(code.env, this._fetchers) }
		}
	}

	/** @internal Start loading now, as workerd does; a failure stays cached and surfaces on each request. */
	_startLoading(): void {
		this._ensureReady().catch(() => {})
	}

	private async _resolveCode(): Promise<ResolvedCode> {
		if (this._resolved) return this._resolved
		const code = await (this.codeSource as () => WorkerCode | Promise<WorkerCode>)()
		validateCode(code)
		this._resolved = { code, env: encodeLoaderEnv(code.env, this._fetchers) }
		return this._resolved
	}

	private async _ensureReady(): Promise<void> {
		if (this._ready) return this._ready
		this._ready = this._boot()
		return this._ready
	}

	private async _boot(): Promise<void> {
		try {
			const { code, env } = await this._resolveCode()
			const { compatibility, modules } = validateCode(code)
			this._assertNotDisposed()
			mkdirSync(this.workDir, { recursive: true })
			const mainPath = await writeModules(this.workDir, modules, code.mainModule)
			this._assertNotDisposed()
			await this._spawn(mainPath, env, code.globalOutbound === null ? 'block' : 'allow', compatibility)
		} catch (err) {
			// Leave nothing behind from a partial materialization or a failed init; the failure stays cached, as on Cloudflare.
			this._release()
			throw err
		}
	}

	private _spawn(
		mainPath: string,
		env: Record<string, unknown>,
		globalOutbound: 'allow' | 'block',
		compatibility: CompatibilitySelection,
	): Promise<void> {
		const worker = new Worker(WORKER_ENTRY_PATH)
		this._worker = worker

		const { promise: ready, resolve: readyResolve, reject: readyReject } = Promise.withResolvers<void>()
		this._rejectReady = readyReject
		void ready.then(() => {
			this._rejectReady = null
		}, () => {
			this._rejectReady = null
		})

		worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
			const msg = event.data
			if (msg.type === 'need-init') {
				const init: LoaderInitMessage = {
					type: 'init',
					mainModulePath: mainPath,
					env,
					globalOutbound,
					compatibility,
				}
				worker.postMessage({ type: 'init', data: init } satisfies MainToWorker)
				return
			}
			if (msg.type === 'ready') {
				readyResolve()
				return
			}
			if (msg.type === 'env-call' || msg.type === 'env-get' || msg.type === 'env-fetch') {
				void answerEnvRequest(worker, this._fetchers, msg)
				return
			}
			if (msg.type === 'result') {
				if (msg.id === -1 && msg.result.type === 'error') {
					readyReject(new Error(msg.result.message))
					return
				}
				const pending = this._pending.get(msg.id)
				if (!pending) return
				this._pending.delete(msg.id)
				if (msg.result.type === 'error') {
					const err = new Error(msg.result.message)
					if (msg.result.stack) err.stack = msg.result.stack
					if (msg.result.name) err.name = msg.result.name
					pending.reject(err)
				} else {
					pending.resolve(msg.result)
				}
			}
		}

		worker.onerror = (err: ErrorEvent) => {
			readyReject(new Error(err.message || 'Worker error'))
			for (const pending of this._pending.values()) {
				pending.reject(new Error(err.message || 'Worker error'))
			}
			this._pending.clear()
		}

		return ready
	}

	private _assertNotDisposed(): void {
		if (this._disposed) throw new Error('WorkerStub has been disposed')
	}

	/** Terminate the Worker and remove the module directory. */
	private _release(): void {
		if (this._worker) {
			try {
				this._worker.terminate()
			} catch {}
			this._worker = null
		}
		try {
			rmSync(this.workDir, { recursive: true, force: true })
		} catch {}
	}

	private _send(command: LoaderCommand): Promise<LoaderResult> {
		if (this._disposed) throw new Error('WorkerStub has been disposed')
		const id = this._nextCmdId++
		return new Promise((resolve, reject) => {
			this._pending.set(id, { resolve, reject })
			this._ensureReady()
				.then(() => {
					this._assertNotDisposed()
					this._worker?.postMessage({ type: 'command', id, command } satisfies MainToWorker)
				})
				.catch(err => {
					this._pending.delete(id)
					reject(err)
				})
		})
	}

	/** Props are validated and snapshotted now, so later changes to the caller's object do not reach the entrypoint. */
	getEntrypoint(name?: string | null, options?: EntrypointOptions): EntrypointProxy {
		validateLimits(options?.limits)
		const props = encodeEnvObject(options?.props ?? {}, 'props', this._fetchers)
		return createEntrypointProxy(this, { entrypoint: name === null || name === 'default' ? undefined : name, props: structuredClone(props) })
	}

	/** @internal */
	async _fetch(handle: EntrypointHandle, request: Request): Promise<Response> {
		this._assertNotDisposed()
		const body = request.body ? await readBodyUntilAborted(request.body, this._disposal.signal) : null
		const result = await this._send({
			type: 'fetch',
			...handle,
			url: request.url,
			method: request.method,
			headers: Array.from(request.headers.entries()),
			body,
		})
		if (result.type !== 'fetch') throw new Error(`Unexpected result type: ${result.type}`)
		return new Response(result.body, {
			status: result.status,
			statusText: result.statusText,
			headers: result.headers,
		})
	}

	/** @internal */
	async _scheduled(handle: EntrypointHandle, cron: string, scheduledTime: number): Promise<void> {
		const result = await this._send({ type: 'scheduled', ...handle, cron, scheduledTime })
		if (result.type !== 'scheduled') throw new Error(`Unexpected result type: ${result.type}`)
	}

	/** @internal */
	async _rpcCall(handle: EntrypointHandle, method: string, args: unknown[]): Promise<unknown> {
		const result = await this._send({ type: 'rpc-call', ...handle, method, args })
		if (result.type !== 'rpc-call') throw new Error(`Unexpected result type: ${result.type}`)
		return result.value
	}

	dispose(): void {
		if (this._disposed) return
		this._disposed = true
		if (this._disposeTimer) clearTimeout(this._disposeTimer)
		const error = new Error('WorkerStub has been disposed')
		this._disposal.abort(error)
		this._rejectReady?.(error)
		for (const pending of this._pending.values()) pending.reject(error)
		this._pending.clear()
		this._release()
	}
}

/** What a `getEntrypoint()` handle sends with each invocation: `entrypoint` is undefined for the default export. */
interface EntrypointHandle {
	entrypoint: string | undefined
	props: Record<string, unknown>
}

export interface EntrypointProxy {
	fetch(request: Request | string | URL, init?: RequestInit): Promise<Response>
	scheduled(event: { cron: string; scheduledTime?: number }): Promise<void>
	[method: string]: unknown
}

function createEntrypointProxy(stub: WorkerStub, handle: EntrypointHandle): EntrypointProxy {
	const target = Object.create(null) as EntrypointProxy
	return new Proxy(target, {
		get(_t, prop: string | symbol) {
			if (prop === FETCHER_BRAND) return true
			if (typeof prop !== 'string') return undefined
			if (prop === 'fetch') {
				return async (input: Request | string | URL, init?: RequestInit) => {
					const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init)
					return stub._fetch(handle, request)
				}
			}
			if (prop === 'scheduled') {
				return async (event: { cron?: string; scheduledTime?: number }) => {
					return stub._scheduled(handle, event.cron ?? '* * * * *', event.scheduledTime ?? Date.now())
				}
			}
			if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined
			return (...args: unknown[]) => stub._rpcCall(handle, prop, args)
		},
	}) as EntrypointProxy
}

export class WorkerLoaderBinding {
	private readonly baseDir: string
	private readonly cache = new Map<string, WorkerStub>()

	constructor(baseDir: string) {
		this.baseDir = baseDir
		mkdirSync(this.baseDir, { recursive: true })
	}

	load(code: WorkerCode): WorkerStub {
		validateCode(code)
		const stub = new WorkerStub(code, this.baseDir)
		stub._startLoading()
		return stub
	}

	get(id: string, getCodeCallback: () => Promise<WorkerCode> | WorkerCode): WorkerStub {
		const existing = this.cache.get(id)
		if (existing) return existing
		const stub = new WorkerStub(getCodeCallback, this.baseDir)
		this.cache.set(id, stub)
		stub._startLoading()
		return stub
	}

	disposeAll(): void {
		for (const stub of this.cache.values()) stub.dispose()
		this.cache.clear()
	}
}

interface ValidatedCode {
	compatibility: CompatibilitySelection
	/** The modules map read once; the files are written from this snapshot, so every written name was validated. */
	modules: [string, WorkerCodeModule][]
}

function validateCode(code: WorkerCode): ValidatedCode {
	if (!code.compatibilityDate) throw new Error('WorkerCode.compatibilityDate is required')
	const compatibility = resolveCompatibility({ date: code.compatibilityDate, flags: code.compatibilityFlags })
	if (!code.mainModule) throw new Error('WorkerCode.mainModule is required')
	if (!code.modules || typeof code.modules !== 'object') throw new Error('WorkerCode.modules must be an object')
	const modules = Object.entries(code.modules)
	for (const [name] of modules) validateModuleName(name)
	if (!modules.some(([name]) => name === code.mainModule)) throw new Error(`mainModule "${code.mainModule}" not present in modules map`)
	return { compatibility, modules }
}

/** Module names become paths under the stub directory, so each must stay inside it. */
function validateModuleName(name: string): void {
	const segments = name.split('/')
	if (name.includes('\\') || name.includes('\0') || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
		throw new TypeError(
			`Invalid module name ${JSON.stringify(name)}: use a relative path of non-empty segments without ".", "..", backslashes or NUL characters`,
		)
	}
}

function validateLimits(limits: EntrypointOptions['limits']): void {
	if (limits === undefined) return
	for (const key of ['cpuMs', 'subRequests'] as const) {
		const value = limits[key]
		if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
			throw new TypeError(`limits.${key} must be a non-negative number`)
		}
	}
}

/**
 * Validate and encode `env` the way workerd serializes it for a dynamic worker: data that
 * structured clone accepts, plus Fetchers, each swapped for a placeholder indexing `fetchers`.
 * Anything else — functions, class instances, Durable Object stubs, other bindings — throws a
 * DataCloneError naming the offending path. Entrypoint props follow the same policy.
 */
function encodeLoaderEnv(env: Record<string, unknown> | undefined, fetchers: FetcherTable): Record<string, unknown> {
	return encodeEnvObject(env ?? {}, 'env', fetchers)
}

function encodeEnvObject(value: object, path: string, fetchers: FetcherTable): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [key, entry] of Object.entries(value)) {
		out[key] = encodeEnvValue(entry, `${path}.${key}`, fetchers)
	}
	return out
}

function encodeEnvValue(value: unknown, path: string, fetchers: FetcherTable): unknown {
	if (isLoopbackServiceStub(value)) {
		throw envCloneError(path, 'a ctx.exports loopback must be specialized first, e.g. ctx.exports.Name({ props })')
	}
	if (isFetcher(value)) {
		// One slot per binding, so handles created per request with the same binding do not grow the table.
		const known = fetchers.indexOf(value)
		const placeholder: EnvFetcherPlaceholder = { [ENV_FETCHER_KEY]: known === -1 ? fetchers.push(value) - 1 : known }
		return placeholder
	}
	if (typeof value === 'function') throw envCloneError(path, 'functions cannot be serialized')
	if (typeof value !== 'object' || value === null) return cloneOrThrow(value, path)
	if (isProxy(value)) {
		throw envCloneError(path, 'only service bindings and ctx.exports loopbacks can be passed; Durable Object stubs and other bindings cannot')
	}
	if (Array.isArray(value)) return value.map((item, index) => encodeEnvValue(item, `${path}[${index}]`, fetchers))
	const proto = Object.getPrototypeOf(value)
	if (proto === Object.prototype || proto === null) return encodeEnvObject(value, path, fetchers)
	// Built-ins (Date, Map, ArrayBuffer, …) report their own tag; a user class instance reports
	// `[object Object]` and workerd refuses it rather than flattening it to a plain object.
	if (Object.prototype.toString.call(value) === '[object Object]') throw envCloneError(path, 'class instances cannot be serialized')
	return cloneOrThrow(value, path)
}

function cloneOrThrow(value: unknown, path: string): unknown {
	try {
		structuredClone(value)
	} catch (e) {
		throw envCloneError(path, e instanceof Error ? e.message : String(e))
	}
	return value
}

function envCloneError(path: string, reason: string): DOMException {
	return new DOMException(`Worker Loader value at ${path} could not be serialized: ${reason}`, 'DataCloneError')
}

/** Run a dynamic worker's call on one of its env Fetchers and post the outcome back. */
async function answerEnvRequest(worker: Worker, fetchers: FetcherTable, request: LoaderEnvRequest): Promise<void> {
	let result: LoaderEnvResult
	try {
		result = await invokeEnvFetcher(fetchers[request.slot], request)
	} catch (e) {
		result = { type: 'error', error: serializeError(e) }
	}
	try {
		worker.postMessage({ type: 'env-result', id: request.id, result } satisfies MainToWorker)
	} catch (e) {
		// The value isn't structured-clonable (e.g. an RPC stub came back) — report that instead.
		worker.postMessage({ type: 'env-result', id: request.id, result: { type: 'error', error: serializeError(e) } } satisfies MainToWorker)
	}
}

async function invokeEnvFetcher(fetcher: Record<string | symbol, unknown> | undefined, request: LoaderEnvRequest): Promise<LoaderEnvResult> {
	if (!fetcher) throw new Error(`Worker Loader env has no binding in slot ${request.slot}`)
	if (request.type === 'env-get') {
		return { type: 'value', value: await fetcher[request.property] }
	}
	const name = request.type === 'env-fetch' ? 'fetch' : request.method
	const member = fetcher[name]
	if (typeof member !== 'function') throw new Error(`"${name}" is not a method on the binding`)
	if (request.type === 'env-call') {
		return { type: 'value', value: await member.apply(fetcher, request.args) }
	}
	const { url, method, headers, body } = request.request
	const response: unknown = await member.call(fetcher, new Request(url, { method, headers, body }))
	if (!(response instanceof Response)) throw new Error('Binding fetch() did not return a Response')
	const buffer = await response.arrayBuffer()
	return {
		type: 'response',
		status: response.status,
		statusText: response.statusText,
		headers: serializeResponseHeaders(response),
		body: buffer.byteLength ? buffer : null,
	}
}

/** Buffer a request body; an abort cancels the stream at once instead of waiting for its source to finish. */
async function readBodyUntilAborted(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<ArrayBuffer> {
	const reader = body.getReader()
	const cancel = () => {
		reader.cancel(signal.reason).catch(() => {})
	}
	signal.addEventListener('abort', cancel, { once: true })
	try {
		const chunks: Uint8Array[] = []
		for (;;) {
			const { done, value } = await reader.read()
			signal.throwIfAborted()
			if (done) return Bun.concatArrayBuffers(chunks)
			chunks.push(value)
		}
	} finally {
		signal.removeEventListener('abort', cancel)
	}
}

async function writeModules(
	workDir: string,
	modules: [string, WorkerCodeModule][],
	mainModule: string,
): Promise<string> {
	let mainPath = ''
	for (const [name, content] of modules) {
		const filePath = join(workDir, name)
		mkdirSync(dirname(filePath), { recursive: true })
		const resolved = resolveModuleContent(name, content)
		if (resolved.kind === 'binary') {
			await Bun.write(filePath, resolved.body)
		} else {
			await Bun.write(filePath, resolved.body)
		}
		if (name === mainModule) mainPath = filePath
	}
	if (!mainPath) throw new Error(`mainModule "${mainModule}" could not be written`)
	return mainPath
}

type ResolvedModule = { kind: 'text'; body: string } | { kind: 'binary'; body: ArrayBuffer }

function resolveModuleContent(name: string, mod: WorkerCodeModule): ResolvedModule {
	if (typeof mod === 'string') return { kind: 'text', body: mod }
	if ('js' in mod) return { kind: 'text', body: mod.js }
	if ('cjs' in mod) return { kind: 'text', body: mod.cjs }
	if ('text' in mod) return { kind: 'text', body: mod.text }
	if ('json' in mod) {
		// Write raw JSON so the `.json` suffix triggers Bun's built-in JSON import; for
		// non-.json names, fall back to an ES module default export.
		if (name.endsWith('.json')) return { kind: 'text', body: JSON.stringify(mod.json) }
		return { kind: 'text', body: `export default ${JSON.stringify(mod.json)}` }
	}
	if ('data' in mod) return { kind: 'binary', body: mod.data }
	throw new Error(`Unsupported module type for "${name}": ${JSON.stringify(Object.keys(mod))}`)
}
