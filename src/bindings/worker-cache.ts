import type { Database } from 'bun:sqlite'
import type { WranglerConfig } from '../config'
import { resolveEntrypointHandler } from '../entrypoint-handler'
import { getActiveExecutionContext, runWithExecutionContext } from '../execution-context'
import { warnInvalidRpcArgs } from '../rpc-validate'
import { serializeResponseHeaders } from '../worker-thread/serialize'
import { createRpcFunctionStub, makeBindingProxy, type RpcExecutionScope, wrapRpcReturnValue } from './rpc-stub'
import { clientCacheResponse, initialCacheAge } from './worker-cache-http'
import { migrateWorkerCache } from './worker-cache-migrations'

export interface PurgeResult {
	success: boolean
	errors: { code: number; message: string }[]
}

export interface WorkerCacheApi {
	purge(options: unknown): Promise<PurgeResult>
}

declare global {
	var __lopata_workerCacheApi: WorkerCacheApi | undefined
}

export interface CacheExecutionContext {
	readonly props: Record<string, unknown>
	cache: WorkerCacheApi
	exports: Record<string, unknown>
	waitUntil(promise: Promise<unknown>): void
	passThroughOnException(): void
}

export interface WorkerFetchOptions extends RequestInit {
	props?: Record<string, unknown>
	cf?: Record<string, unknown> & { cacheKey?: string; cacheControl?: string }
}

export const cache: WorkerCacheApi = {
	purge(options) {
		const ctx = getActiveExecutionContext()
		if (!ctx) throw new Error('cache.purge() requires an active Worker execution context')
		return ctx.cache.purge(options)
	},
}

export const unavailableWorkerCache: WorkerCacheApi = {
	async purge() {
		throw new Error('Workers Cache is not attached to this execution context')
	},
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isWorkerResponse(value: unknown): value is Response {
	let constructor: unknown = Response
	while (typeof constructor === 'function' && constructor.prototype) {
		if (value instanceof constructor) return true
		constructor = Object.getPrototypeOf(constructor)
	}
	return false
}

export function canonicalCacheProps(value: unknown, seen = new Set<object>()): string | undefined {
	if (value === null) return 'null'
	if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
	if (typeof value === 'number' && Number.isFinite(value)) return Object.is(value, -0) ? '-0' : String(value)
	if (typeof value !== 'object' || seen.has(value)) return undefined
	if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return undefined
	seen.add(value)
	const parts: string[] = []
	if (Array.isArray(value)) {
		if (Object.getPrototypeOf(value) !== Array.prototype) return undefined
		if (
			Reflect.ownKeys(value).some(key =>
				key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)
					|| Number(key) >= 4294967295 || Number(key) >= value.length)
			)
		) return undefined
		for (let index = 0; index < value.length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
			if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined
			const encoded = canonicalCacheProps(descriptor.value, seen)
			if (encoded === undefined) return undefined
			parts.push(encoded)
		}
	} else {
		if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length) return undefined
		for (const key of Object.keys(value).sort()) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor || !('value' in descriptor)) return undefined
			const encoded = canonicalCacheProps(descriptor.value, seen)
			if (encoded === undefined) return undefined
			parts.push(`${JSON.stringify(key)}:${encoded}`)
		}
		if (Object.getOwnPropertySymbols(value).length) return undefined
	}
	seen.delete(value)
	return Array.isArray(value) ? `[${parts.join(',')}]` : `{${parts.join(',')}}`
}

function validTag(value: string): boolean {
	return value.length > 0 && value.length <= 1024 && /^[\x21-\x7e]+$/.test(value) && !value.includes(',')
}

function stringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function parseList(json: string): string[] {
	const value: unknown = JSON.parse(json)
	if (!stringList(value)) throw new Error('Invalid stored Workers Cache list')
	return value
}

function parseHeaders(json: string): [string, string][] {
	const value: unknown = JSON.parse(json)
	if (!Array.isArray(value)) throw new Error('Invalid stored Workers Cache headers')
	return value.map((pair): [string, string] => {
		if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
			throw new Error('Invalid stored Workers Cache header')
		}
		return [pair[0], pair[1]]
	})
}

interface Entry {
	cache_key: string
	variant: string
	path: string
	vary: string
	headers: string
	tags: string
	status: number
	status_text: string
	body: Uint8Array
	stored_at: number
	ttl: number
	swr: number
	stale_error: number
	auth_allowed: number
}

interface Policy {
	ttl: number
	swr: number
	staleError: number
	authAllowed: boolean
	stripCookie: boolean
}

const defaultTtl: Record<number, number> = { 200: 7200, 203: 7200, 204: 7200, 300: 1200, 301: 1200, 404: 180, 405: 60, 410: 180, 414: 60, 501: 60 }
const maxBodyBytes = 512 * 1024 * 1024
const poisoningHeaders = [
	'x-http-method-override',
	'x-http-method',
	'x-method-override',
	'x-forwarded-host',
	'x-host',
	'x-forwarded-scheme',
	'x-original-url',
	'x-rewrite-url',
	'forwarded',
	'cloudflare-workers-version-key',
]

function directives(header: string): Map<string, string> {
	const result = new Map<string, string>()
	for (const match of header.matchAll(/(?:^|,)\s*([\w-]+)(?:\s*=\s*("[^"]*"|[^,]*))?/g)) {
		const name = match[1]
		if (name) result.set(name.toLowerCase(), (match[2] ?? '').trim().replace(/^"|"$/g, '').toLowerCase())
	}
	return result
}

function seconds(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value)) return undefined
	const n = Number(value)
	return Number.isSafeInteger(n) ? n * 1000 : undefined
}

function policy(response: Response, override?: string, now = Date.now()): Policy | undefined {
	if (response.status < 200 || response.status === 206 || response.status === 304 || (response.status >= 520 && response.status <= 526)) {
		return undefined
	}
	const header = override ?? response.headers.get('cloudflare-cdn-cache-control') ?? response.headers.get('cdn-cache-control')
		?? response.headers.get('cache-control')
	const d = directives(header ?? '')
	const stripCookie = d.get('private') === 'set-cookie' || d.get('no-cache') === 'set-cookie'
	if (d.has('no-store') || (d.has('private') && d.get('private') !== 'set-cookie')) return undefined
	if (response.headers.has('set-cookie') && !stripCookie) return undefined
	let ttl = seconds(d.get('s-maxage')) ?? seconds(d.get('max-age'))
	if (d.has('no-cache') && d.get('no-cache') !== 'set-cookie') ttl = 0
	if (ttl === undefined) {
		const expires = response.headers.get('expires')
		const date = Date.parse(response.headers.get('date') ?? '')
		if (expires) ttl = Math.max(0, Date.parse(expires) - (Number.isFinite(date) ? date : now))
		else if (header === null || header === undefined) ttl = (defaultTtl[response.status] ?? -1) * 1000
	}
	if (ttl === undefined || !Number.isFinite(ttl) || ttl < 0) return undefined
	const strict = d.has('s-maxage') || d.has('must-revalidate') || d.has('proxy-revalidate')
	return {
		ttl,
		swr: strict ? 0 : seconds(d.get('stale-while-revalidate')) ?? 0,
		staleError: strict ? 0 : seconds(d.get('stale-if-error')) ?? -1,
		authAllowed: d.has('public') || d.has('must-revalidate') || d.has('s-maxage'),
		stripCookie,
	}
}

function cacheDeception(request: Request, response: Response, override?: string): boolean {
	if (
		override !== undefined
		|| ['cache-control', 'cdn-cache-control', 'cloudflare-cdn-cache-control', 'expires'].some(header => response.headers.has(header))
	) return false
	const contentType = ((response.headers.get('content-type') ?? '').split(';')[0] ?? '').trim().toLowerCase()
	if (!contentType.startsWith('text/') && !contentType.startsWith('application/')) return false
	const extension = /\.[a-z\d]+$/i.exec(new URL(request.url).pathname)?.[0]
	if (!extension) return false
	const mime = Bun.file(`asset${extension}`).type.split(';')[0]
	return mime !== 'application/octet-stream' && mime !== contentType
}

export function workerRequest(input: Request | string | URL, options?: WorkerFetchOptions): Request {
	let request: Request
	if (input instanceof Request) request = options ? new Request(input, options) : input
	else request = new Request(input instanceof URL ? input.href : input, options)
	const sourceCf: unknown = input instanceof Request ? Reflect.get(input, 'cf') : undefined
	const optionCf: unknown = options?.cf
	if (sourceCf !== undefined && !record(sourceCf)) throw new TypeError('request.cf must be an object')
	if (optionCf !== undefined && !record(optionCf)) throw new TypeError('cf must be an object')
	if (record(sourceCf) || record(optionCf)) {
		const cf = { ...(record(sourceCf) ? sourceCf : {}), ...(record(optionCf) ? optionCf : {}) }
		readWorkerCf({ cf })
		if (request !== input || options?.cf !== undefined) Object.defineProperty(request, 'cf', { value: cf, configurable: true })
	}
	return request
}

export function readWorkerCf(value: unknown): WorkerFetchOptions['cf'] {
	if (!record(value) || !record(value.cf)) return undefined
	const { cacheKey, cacheControl } = value.cf
	if (cacheKey !== undefined && typeof cacheKey !== 'string') throw new TypeError('cf.cacheKey must be a string')
	if (cacheControl !== undefined && typeof cacheControl !== 'string') throw new TypeError('cf.cacheControl must be a string')
	return { ...value.cf, cacheKey, cacheControl }
}

export class WorkersCache {
	private refreshing = new Map<string, Promise<void>>()
	constructor(private db: Database, private worker: string, private version: string, private config: WranglerConfig, private now = Date.now) {
		migrateWorkerCache(db)
	}

	api(entrypoint: string): WorkerCacheApi {
		return { purge: options => this.purge(entrypoint, options) }
	}

	private epoch(entrypoint: string): number {
		return this.db.query<{ epoch: number }, [string, string]>('SELECT epoch FROM worker_cache_epochs WHERE worker = ? AND entrypoint = ?')
			.get(this.worker, entrypoint)?.epoch ?? 0
	}

	private async purge(entrypoint: string, options: unknown): Promise<PurgeResult> {
		const invalid = (message: string): PurgeResult => ({ success: false, errors: [{ code: 1000, message }] })
		if (!record(options)) return invalid('Purge options must be an object')
		if (Object.keys(options).some(key => !['purgeEverything', 'tags', 'pathPrefixes'].includes(key))) return invalid('Unknown purge option')
		const { purgeEverything, tags, pathPrefixes } = options
		if (purgeEverything !== undefined && purgeEverything !== true) return invalid('purgeEverything must be true')
		if (purgeEverything && (tags !== undefined || pathPrefixes !== undefined)) return invalid('purgeEverything is exclusive')
		if (tags !== undefined && (!stringList(tags) || !tags.length || tags.length > 1000 || tags.some(tag => !validTag(tag)))) {
			return invalid('tags must contain 1–1000 printable ASCII tags of at most 1024 characters')
		}
		if (
			pathPrefixes !== undefined
			&& (!stringList(pathPrefixes) || !pathPrefixes.length
				|| pathPrefixes.some(prefix => !prefix || prefix.startsWith('//') || /[?#\\\s]/.test(prefix) || /^[a-z][a-z\d+.-]*:/i.test(prefix)))
		) return invalid('pathPrefixes must contain paths without a scheme, host, query or fragment')
		if (!purgeEverything && tags === undefined && pathPrefixes === undefined) return invalid('Specify tags, pathPrefixes or purgeEverything')
		const requestedTags = stringList(tags) ? tags.map(tag => tag.toLowerCase()) : []
		const prefixes = stringList(pathPrefixes) ? pathPrefixes.map(prefix => prefix.startsWith('/') ? prefix : `/${prefix}`) : []
		this.db.transaction(() => {
			this.db.run(
				`INSERT INTO worker_cache_epochs (worker, entrypoint, epoch) VALUES (?, ?, 1)
				ON CONFLICT(worker, entrypoint) DO UPDATE SET epoch = epoch + 1`,
				[this.worker, entrypoint],
			)
			if (purgeEverything) {
				this.db.run('DELETE FROM worker_cache_entries WHERE worker = ? AND entrypoint = ?', [this.worker, entrypoint])
				return
			}
			const entries = this.db.query<{ cache_key: string; path: string; tags: string }, [string, string]>(
				'SELECT cache_key, path, tags FROM worker_cache_entries WHERE worker = ? AND entrypoint = ?',
			).all(this.worker, entrypoint)
			for (const entry of entries) {
				if (prefixes.some(prefix => entry.path.startsWith(prefix)) || parseList(entry.tags).some(tag => requestedTags.includes(tag))) {
					this.db.run('DELETE FROM worker_cache_entries WHERE worker = ? AND entrypoint = ? AND cache_key = ?', [this.worker, entrypoint, entry.cache_key])
				}
			}
		})()
		return { success: true, errors: [] }
	}

	async fetch(
		request: Request,
		entrypoint: string,
		ctx: CacheExecutionContext,
		invoke: (request: Request) => Promise<Response>,
		trusted = false,
	): Promise<Response> {
		const declaration = this.config.exports?.[entrypoint]
		const exportCache = declaration?.type === 'worker' ? declaration.cache : undefined
		const enabled = exportCache?.enabled ?? this.config.cache?.enabled ?? false
		const props = canonicalCacheProps(ctx.props)
		if (!enabled) return invoke(request)
		if (props === undefined || !['GET', 'HEAD'].includes(request.method) || request.headers.has('upgrade') || request.body) {
			return this.bypass(await invoke(request))
		}
		const requestDirectives = directives(request.headers.get('cache-control') ?? '')
		if (requestDirectives.has('no-store')) return this.bypass(await invoke(request))
		const url = new URL(request.url)
		const cf = trusted ? readWorkerCf(request) : undefined
		const key = JSON.stringify([
			cf?.cacheKey || url.pathname + url.search,
			props,
			poisoningHeaders.map(header => {
				const value = request.headers.get(header)
				return header === 'x-forwarded-scheme' && (value === 'http' || value === 'https') ? null : value
			}),
		])
		const version = this.config.cache?.cross_version_cache ? '' : this.version
		const entries = this.db.query<Entry, [string, string, string, string]>(
			'SELECT * FROM worker_cache_entries WHERE worker = ? AND entrypoint = ? AND version = ? AND cache_key = ? ORDER BY stored_at DESC',
		).all(this.worker, entrypoint, version, key)
		const entry = entries.find(item =>
			JSON.stringify(parseList(item.vary).map(header => request.headers.get(header))) === item.variant
			&& (!request.headers.has('authorization') || item.auth_allowed === 1)
		)
		const elapsed = entry ? this.now() - entry.stored_at : 0
		const force = requestDirectives.has('no-cache') || requestDirectives.get('max-age') === '0'
		if (entry && !force && elapsed < entry.ttl) return clientCacheResponse(this.representation(entry, 'HIT'), request, ctx)
		const fillRequest = workerRequest(request, { method: 'GET', cf })
		fillRequest.headers.delete('range')
		for (const header of ['if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since', 'if-range']) fillRequest.headers.delete(header)
		if (entry) {
			const headers = new Headers(parseHeaders(entry.headers))
			const etag = headers.get('etag')
			const modified = headers.get('last-modified')
			if (etag) fillRequest.headers.set('if-none-match', etag)
			if (modified) fillRequest.headers.set('if-modified-since', modified)
		}
		const epoch = this.epoch(entrypoint)
		const fill = async (): Promise<Response> => {
			const startedAt = this.now()
			let response = await invoke(fillRequest)
			let outcome = entry ? 'EXPIRED' : 'MISS'
			if (entry && response.status === 304) {
				response.body?.cancel().catch(() => {})
				const headers = new Headers(parseHeaders(entry.headers))
				headers.delete('age')
				headers.delete('date')
				if (!headers.has('cache-tag')) headers.set('cache-tag', parseList(entry.tags).join(','))
				const replacements = serializeResponseHeaders(response)
				for (const name of new Set(replacements.map(([name]) => name))) headers.delete(name)
				for (const [name, value] of replacements) headers.append(name, value)
				response = new Response([204, 205].includes(entry.status) ? null : entry.body, { status: entry.status, statusText: entry.status_text, headers })
				outcome = 'REVALIDATED'
			}
			if (entry && response.status >= 500 && this.canServeError(entry, elapsed)) {
				response.body?.cancel().catch(() => {})
				return this.representation(entry, 'STALE')
			}
			return this.storeResponse(
				response,
				fillRequest,
				entrypoint,
				version,
				key,
				url.pathname,
				epoch,
				cf?.cacheControl,
				outcome,
				startedAt,
			)
		}
		if (entry && !force && elapsed < entry.ttl + entry.swr) {
			const refreshKey = JSON.stringify([entrypoint, version, key, entry.variant, epoch])
			if (!this.refreshing.has(refreshKey)) {
				const refresh = fill().then(response => this.discard(response)).finally(() => this.refreshing.delete(refreshKey))
				this.refreshing.set(refreshKey, refresh)
				ctx.waitUntil(refresh)
			}
			return clientCacheResponse(this.representation(entry, 'UPDATING'), request, ctx)
		}
		try {
			return await clientCacheResponse(await fill(), request, ctx)
		} catch (error) {
			if (entry && this.canServeError(entry, elapsed)) return clientCacheResponse(this.representation(entry, 'STALE'), request, ctx)
			throw error
		}
	}

	private canServeError(entry: Entry, elapsed: number): boolean {
		return entry.stale_error === -1 || (entry.stale_error > 0 && elapsed < entry.ttl + entry.stale_error)
	}

	private representation(entry: Entry, status: string): Response {
		const headers = new Headers(parseHeaders(entry.headers))
		headers.delete('cache-tag')
		headers.delete('cloudflare-cdn-cache-control')
		headers.set('cf-cache-status', status)
		headers.set('age', String(Math.max(0, Math.floor((this.now() - entry.stored_at) / 1000))))
		const body = [204, 205, 304].includes(entry.status) ? null : entry.body
		if (body) headers.set('content-length', String(body.byteLength))
		return new Response(body, { status: entry.status, statusText: entry.status_text, headers })
	}

	private storeResponse(
		response: Response,
		fillRequest: Request,
		entrypoint: string,
		version: string,
		key: string,
		path: string,
		epoch: number,
		override: string | undefined,
		status: string,
		startedAt: number,
	): Response {
		if (response.status === 101) return response
		const p = policy(response, override, this.now())
		const vary = [...new Set((response.headers.get('vary') ?? '').split(',').map(header => header.trim().toLowerCase()).filter(Boolean))].sort()
		const allowed = p && !vary.includes('*') && (!fillRequest.headers.has('authorization') || p.authAllowed)
			&& !cacheDeception(fillRequest, response, override)
		if (!allowed && this.epoch(entrypoint) === epoch) {
			this.db.run('DELETE FROM worker_cache_entries WHERE worker = ? AND entrypoint = ? AND version = ? AND cache_key = ?', [
				this.worker,
				entrypoint,
				version,
				key,
			])
		}
		const tags = (response.headers.get('cache-tag') ?? '').split(',').map(tag => tag.trim()).filter(validTag).slice(0, 1000).map(tag =>
			tag.toLowerCase()
		)
		const headers = new Headers(response.headers)
		headers.delete('cache-tag')
		headers.delete('cloudflare-cdn-cache-control')
		headers.set('cf-cache-status', allowed ? status : 'BYPASS')
		const receivedAt = this.now()
		const initialAge = initialCacheAge(response.headers, startedAt, receivedAt)
		headers.set('age', String(Math.floor(initialAge / 1000)))
		const storedAt = receivedAt - initialAge
		const storedHeaders = new Headers(response.headers)
		if (p?.stripCookie) storedHeaders.delete('set-cookie')
		const write = (body: Uint8Array) => {
			if (!allowed) return
			this.db.transaction(() => {
				if (this.epoch(entrypoint) !== epoch) return
				this.db.run('DELETE FROM worker_cache_entries WHERE worker = ? AND entrypoint = ? AND version = ? AND cache_key = ? AND vary != ?', [
					this.worker,
					entrypoint,
					version,
					key,
					JSON.stringify(vary),
				])
				this.db.run(
					`INSERT OR REPLACE INTO worker_cache_entries
					(worker, entrypoint, version, cache_key, variant, path, vary, headers, tags, status, status_text, body, stored_at, ttl, swr, stale_error, auth_allowed)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						this.worker,
						entrypoint,
						version,
						key,
						JSON.stringify(vary.map(header => fillRequest.headers.get(header))),
						path,
						JSON.stringify(vary),
						JSON.stringify(serializeResponseHeaders(new Response(null, { headers: storedHeaders }))),
						JSON.stringify(tags),
						response.status,
						response.statusText,
						body,
						storedAt,
						p.ttl,
						p.swr,
						p.staleError,
						p.authAllowed ? 1 : 0,
					],
				)
			})()
		}
		if (!response.body) {
			write(new Uint8Array())
			return new Response(null, { status: response.status, statusText: response.statusText, headers })
		}
		return new Response(allowed ? this.capture(response.body, write) : response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		})
	}

	private capture(body: ReadableStream<Uint8Array>, write: (body: Uint8Array) => void): ReadableStream<Uint8Array> {
		const reader = body.getReader()
		let chunks: Uint8Array[] = []
		let size = 0
		let abandoned = false
		return new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const result = await reader.read()
					if (result.done) {
						if (!abandoned) {
							const bytes = new Uint8Array(size)
							let offset = 0
							for (const chunk of chunks) {
								bytes.set(chunk, offset)
								offset += chunk.byteLength
							}
							write(bytes)
						}
						chunks = []
						controller.close()
						reader.releaseLock()
						return
					}
					size += result.value.byteLength
					if (size > maxBodyBytes) {
						abandoned = true
						chunks = []
					}
					if (!abandoned) chunks.push(result.value.slice())
					controller.enqueue(result.value)
				} catch (error) {
					chunks = []
					controller.error(error)
					reader.releaseLock()
				}
			},
			cancel(reason) {
				chunks = []
				return reader.cancel(reason).finally(() => reader.releaseLock())
			},
		})
	}

	private bypass(response: Response): Response {
		if (response.status === 101) return response
		const headers = new Headers(response.headers)
		headers.set('cf-cache-status', 'BYPASS')
		headers.delete('cache-tag')
		headers.delete('cloudflare-cdn-cache-control')
		return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
	}

	private async discard(response: Response): Promise<void> {
		if (!response.body) return
		const reader = response.body.getReader()
		const timer = setTimeout(() => {
			reader.cancel().catch(() => {})
		}, 30_000)
		try {
			while (!(await reader.read()).done) {}
		} finally {
			clearTimeout(timer)
			reader.releaseLock()
		}
	}
}

export type ContextFactory = (props?: Record<string, unknown>) => CacheExecutionContext
const dispatchers = new WeakMap<object, WorkerDispatcher>()

export function getWorkerDispatcher(module: object): WorkerDispatcher | undefined {
	return dispatchers.get(module)
}

export class WorkerDispatcher {
	private attachedContexts = new WeakSet<CacheExecutionContext>()
	constructor(
		private module: Record<string, unknown>,
		private env: Record<string, unknown>,
		private storage: WorkersCache,
		private createContext: ContextFactory,
		private legacyFetch?: (request: Request, ctx: CacheExecutionContext) => Promise<Response>,
	) {
		dispatchers.set(module, this)
	}

	context(entrypoint = 'default', props?: Record<string, unknown>): CacheExecutionContext {
		const ctx = this.createContext(props)
		return this.attachContext(ctx, entrypoint)
	}

	attachContext(ctx: CacheExecutionContext, entrypoint = 'default'): CacheExecutionContext {
		const parent = getActiveExecutionContext()
		if (parent && parent !== ctx && !this.attachedContexts.has(ctx)) {
			const waitUntil = ctx.waitUntil.bind(ctx)
			ctx.waitUntil = promise => {
				waitUntil(promise)
				parent.waitUntil(promise)
			}
		}
		this.attachedContexts.add(ctx)
		ctx.cache = this.storage.api(entrypoint)
		ctx.exports = this.loopbacks()
		return ctx
	}

	async fetch(
		request: Request,
		entrypoint = 'default',
		props?: Record<string, unknown>,
		trusted = false,
		context?: CacheExecutionContext,
	): Promise<Response> {
		const ctx = context ? this.attachContext(context, entrypoint) : this.context(entrypoint, props)
		return runWithExecutionContext(ctx, () =>
			this.storage.fetch(request, entrypoint, ctx, async input => {
				const handler = resolveEntrypointHandler(this.module[entrypoint], 'fetch', ctx, this.env)
				if (!handler && entrypoint === 'default' && this.legacyFetch) return this.legacyFetch(input, ctx)
				if (!handler) throw new Error(`Entrypoint "${entrypoint}" does not export a fetch handler`)
				const response = await handler(input, this.env, ctx)
				if (!isWorkerResponse(response)) throw new TypeError('Worker fetch must return a Response')
				return response
			}, trusted))
	}

	private loopbacks(): Record<string, unknown> {
		const exports: Record<string, unknown> = {}
		for (const [name, value] of Object.entries(this.module)) {
			if (typeof value !== 'function' || !value.prototype || !(Symbol.for('lopata.WorkerEntrypoint') in value.prototype)) continue
			const binding = (props?: Record<string, unknown>): Record<string, unknown> =>
				makeBindingProxy({
					fetch: (input, init) => this.fetch(workerRequest(input, init), name, init && 'props' in init && record(init.props) ? init.props : props, true),
					call: async (method, args) => {
						warnInvalidRpcArgs(args, method)
						return this.rpc(name, method, args, props)
					},
					getProperty: property => this.property(name, property, props),
				})
			const defaultBinding = binding()
			exports[name] = new Proxy((options?: { props?: Record<string, unknown> }) => binding(options?.props), {
				get: (_target, property) => typeof property === 'string' ? defaultBinding[property] : undefined,
			})
		}
		return exports
	}

	async rpc(entrypoint: string | undefined, method: string, args: unknown[], props?: Record<string, unknown>): Promise<unknown> {
		const name = entrypoint ?? 'default'
		const ctx = this.context(name, props)
		return runWithExecutionContext(ctx, async () => {
			const value = this.module[name]
			const target: unknown = typeof value === 'function' ? Reflect.construct(value, [ctx, this.env]) : value
			if (!record(target) || typeof target[method] !== 'function') throw new Error(`Entrypoint "${name}" has no RPC method "${method}"`)
			return wrapRpcReturnValue(await Reflect.apply(target[method], target, args), method, this.scope(ctx))
		})
	}

	async property(entrypoint: string | undefined, property: string, props?: Record<string, unknown>): Promise<unknown> {
		const name = entrypoint ?? 'default'
		const ctx = this.context(name, props)
		return runWithExecutionContext(ctx, () => {
			const value = this.module[name]
			const target: unknown = typeof value === 'function' ? Reflect.construct(value, [ctx, this.env]) : value
			if (!record(target)) throw new Error('Invalid WorkerEntrypoint instance')
			const member = target[property]
			if (typeof member === 'function') {
				return createRpcFunctionStub(member, target, this.scope(ctx))
			}
			return wrapRpcReturnValue(member, property, this.scope(ctx))
		})
	}

	private scope(ctx: CacheExecutionContext): RpcExecutionScope {
		return { run: callback => runWithExecutionContext(ctx, callback) }
	}
}
