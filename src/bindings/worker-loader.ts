/**
 * Local implementation of the Cloudflare `worker_loaders` binding.
 *
 * Exposes `env.LOADER.load(code)` / `env.LOADER.get(id, callback)`. Each load
 * spawns a Bun Worker thread (see `worker-loader-entry.ts`) that runs the
 * supplied code with its own module graph. Isolation is "fuzzy" — worker
 * threads share the process with the parent but have separate heaps.
 *
 * Modules are written to `.lopata/worker-loader/<stub-id>/` before the Worker
 * imports the entry point. This keeps the implementation simple at the cost
 * of not supporting languages Bun can't execute directly (CF's `py`, Rust,
 * etc. are rejected in v1).
 */

import { randomUUIDv7 } from 'bun'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { LoaderCommand, LoaderInitMessage, LoaderResult, MainToWorker, WorkerToMain } from './worker-loader-entry'

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

export class WorkerStub {
	private readonly id: string
	private readonly codeSource: CodeSource
	private _resolvedCode: WorkerCode | null = null
	private readonly workDir: string
	private _worker: Worker | null = null
	private _ready: Promise<void> | null = null
	private _pending = new Map<number, PendingCommand>()
	private _nextCmdId = 1
	private _disposed = false
	private _disposeTimer: Timer | null = null

	constructor(id: string, code: CodeSource, baseDir: string) {
		this.id = id
		this.codeSource = code
		this.workDir = join(baseDir, id)
		if (typeof code !== 'function') {
			this._resolvedCode = code
		}
	}

	private async _resolveCode(): Promise<WorkerCode> {
		if (this._resolvedCode) return this._resolvedCode
		const code = await (this.codeSource as () => WorkerCode | Promise<WorkerCode>)()
		validateCode(code)
		this._resolvedCode = code
		return code
	}

	private async _ensureReady(): Promise<void> {
		if (this._ready) return this._ready
		this._ready = this._boot()
		return this._ready
	}

	private async _boot(): Promise<void> {
		const code = await this._resolveCode()
		mkdirSync(this.workDir, { recursive: true })
		const mainPath = await writeModules(this.workDir, code.modules, code.mainModule)

		const worker = new Worker(WORKER_ENTRY_PATH)
		this._worker = worker

		let readyResolve: () => void
		let readyReject: (err: Error) => void
		const ready = new Promise<void>((res, rej) => {
			readyResolve = res
			readyReject = rej
		})

		worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
			const msg = event.data
			if (msg.type === 'need-init') {
				const init: LoaderInitMessage = {
					type: 'init',
					mainModulePath: mainPath,
					env: sanitizeEnv(code.env),
					globalOutbound: code.globalOutbound === null ? 'block' : 'allow',
				}
				worker.postMessage({ type: 'init', data: init } satisfies MainToWorker)
				return
			}
			if (msg.type === 'ready') {
				readyResolve()
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

		await ready
	}

	private _send(command: LoaderCommand): Promise<LoaderResult> {
		if (this._disposed) throw new Error('WorkerStub has been disposed')
		const id = this._nextCmdId++
		return new Promise((resolve, reject) => {
			this._pending.set(id, { resolve, reject })
			this._ensureReady()
				.then(() => {
					this._worker!.postMessage({ type: 'command', id, command } satisfies MainToWorker)
				})
				.catch(err => {
					this._pending.delete(id)
					reject(err)
				})
		})
	}

	getEntrypoint(name?: string): EntrypointProxy {
		return createEntrypointProxy(this, name)
	}

	/** @internal */
	async _fetch(entrypoint: string | undefined, request: Request): Promise<Response> {
		const body = request.body ? await request.arrayBuffer() : null
		const result = await this._send({
			type: 'fetch',
			entrypoint,
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
	async _scheduled(entrypoint: string | undefined, cron: string, scheduledTime: number): Promise<void> {
		const result = await this._send({ type: 'scheduled', entrypoint, cron, scheduledTime })
		if (result.type !== 'scheduled') throw new Error(`Unexpected result type: ${result.type}`)
	}

	/** @internal */
	async _rpcCall(entrypoint: string | undefined, method: string, args: unknown[]): Promise<unknown> {
		const result = await this._send({ type: 'rpc-call', entrypoint, method, args })
		if (result.type !== 'rpc-call') throw new Error(`Unexpected result type: ${result.type}`)
		return result.value
	}

	dispose(): void {
		if (this._disposed) return
		this._disposed = true
		if (this._disposeTimer) clearTimeout(this._disposeTimer)
		if (this._worker) {
			try {
				this._worker.terminate()
			} catch {}
		}
		try {
			rmSync(this.workDir, { recursive: true, force: true })
		} catch {}
	}
}

export interface EntrypointProxy {
	fetch(request: Request | string | URL, init?: RequestInit): Promise<Response>
	scheduled(event: { cron: string; scheduledTime?: number }): Promise<void>
	[method: string]: unknown
}

function createEntrypointProxy(stub: WorkerStub, entrypoint?: string): EntrypointProxy {
	const target = Object.create(null) as EntrypointProxy
	return new Proxy(target, {
		get(_t, prop: string | symbol) {
			if (typeof prop !== 'string') return undefined
			if (prop === 'fetch') {
				return async (input: Request | string | URL, init?: RequestInit) => {
					const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init)
					return stub._fetch(entrypoint, request)
				}
			}
			if (prop === 'scheduled') {
				return async (event: { cron?: string; scheduledTime?: number }) => {
					return stub._scheduled(entrypoint, event.cron ?? '* * * * *', event.scheduledTime ?? Date.now())
				}
			}
			if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined
			return (...args: unknown[]) => stub._rpcCall(entrypoint, prop, args)
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
		const id = randomUUIDv7()
		return new WorkerStub(id, code, this.baseDir)
	}

	get(id: string, getCodeCallback: () => Promise<WorkerCode> | WorkerCode): WorkerStub {
		const existing = this.cache.get(id)
		if (existing) return existing
		// Defer invoking the callback until the stub is first used — matches
		// Cloudflare's behavior (get() returns synchronously, code resolution
		// happens lazily on first fetch/rpc call).
		const stub = new WorkerStub(id, getCodeCallback, this.baseDir)
		this.cache.set(id, stub)
		return stub
	}

	disposeAll(): void {
		for (const stub of this.cache.values()) stub.dispose()
		this.cache.clear()
	}
}

function validateCode(code: WorkerCode): void {
	if (!code.compatibilityDate) throw new Error('WorkerCode.compatibilityDate is required')
	if (!code.mainModule) throw new Error('WorkerCode.mainModule is required')
	if (!code.modules || typeof code.modules !== 'object') throw new Error('WorkerCode.modules must be an object')
	if (!(code.mainModule in code.modules)) throw new Error(`mainModule "${code.mainModule}" not present in modules map`)
}

function sanitizeEnv(env: unknown): unknown {
	if (env == null) return {}
	try {
		// Drop values that can't be structured-cloned (functions, classes, etc.)
		return JSON.parse(JSON.stringify(env))
	} catch {
		return {}
	}
}

async function writeModules(
	workDir: string,
	modules: Record<string, WorkerCodeModule>,
	mainModule: string,
): Promise<string> {
	let mainPath = ''
	for (const [name, content] of Object.entries(modules)) {
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
