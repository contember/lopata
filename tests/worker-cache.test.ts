import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createServiceBinding } from '../src/bindings/service-binding'
import { cache, type CacheExecutionContext, canonicalCacheProps, WorkerDispatcher, workerRequest, WorkersCache } from '../src/bindings/worker-cache'
import { migrateWorkerCache } from '../src/bindings/worker-cache-migrations'
import type { WranglerConfig } from '../src/config'
import { ExecutionContext } from '../src/execution-context'

describe('Workers Cache', () => {
	let db: Database
	let now: number
	let calls: number
	let ctx: ExecutionContext
	let storage: WorkersCache
	const config: WranglerConfig = { name: 'cache-test', cache: { enabled: true } }
	const req = (path = '/page', headers?: RequestInit['headers']) => new Request(`https://example.com${path}`, { headers })
	const origin = async () =>
		new Response(String(++calls), { headers: { 'cache-control': 'public, max-age=2, stale-while-revalidate=10', 'cache-tag': 'Blog' } })
	const fetchCached = (request = req(), invoke: (request: Request) => Promise<Response> = origin, entrypoint = 'default') =>
		storage.fetch(request, entrypoint, ctx, invoke)
	const text = async (response: Promise<Response>) => (await response).text()

	beforeEach(() => {
		db = new Database(':memory:')
		now = 100_000
		calls = 0
		ctx = new ExecutionContext()
		storage = new WorkersCache(db, 'cache-test', 'v1', config, () => now)
		ctx.cache = storage.api('default')
	})
	afterEach(async () => {
		await ctx._awaitAll()
		db.close()
	})

	test('hit skips the handler, ignores hostname, and includes query order', async () => {
		expect(await text(fetchCached())).toBe('1')
		const hit = await fetchCached(new Request('https://other.example/page'))
		expect(hit.headers.get('cf-cache-status')).toBe('HIT')
		expect(hit.headers.has('cache-tag')).toBe(false)
		expect(await hit.text()).toBe('1')
		expect(calls).toBe(1)
		expect(await text(fetchCached(req('/page?a=1&b=2')))).toBe('2')
		expect(await text(fetchCached(req('/page?b=2&a=1')))).toBe('3')
	})

	test('SWR returns immediately, deduplicates refresh, and expires outside the stale window', async () => {
		await text(fetchCached())
		now += 2500
		let release: (() => void) | undefined
		const pending = new Promise<void>(resolve => {
			release = resolve
		})
		const refresh = async () => {
			++calls
			await pending
			return new Response('fresh', { headers: { 'cache-control': 'max-age=2, stale-while-revalidate=10' } })
		}
		const first = await fetchCached(req(), refresh)
		expect(first.headers.get('cf-cache-status')).toBe('UPDATING')
		expect(await first.text()).toBe('1')
		expect(await text(fetchCached(req(), refresh))).toBe('1')
		expect(calls).toBe(2)
		release?.()
		await ctx._awaitAll()
		expect(await text(fetchCached())).toBe('fresh')
		now += 20_000
		const expired = await fetchCached()
		expect(expired.headers.get('cf-cache-status')).toBe('EXPIRED')
		expect(await expired.text()).toBe('3')
	})

	test('s-maxage forbids SWR', async () => {
		const strict = async () => new Response(String(++calls), { headers: { 'cache-control': 'public, s-maxage=1, stale-while-revalidate=60' } })
		await text(fetchCached(req(), strict))
		now += 1500
		expect(await text(fetchCached(req(), strict))).toBe('2')
	})

	test('Vary uses verbatim header values, and wildcard bypasses', async () => {
		const vary = async (request: Request) =>
			new Response(`${++calls}:${request.headers.get('accept-language')}`, { headers: { 'cache-control': 'max-age=30', vary: 'Accept-Language' } })
		expect(await text(fetchCached(req('/vary', { 'accept-language': 'en' }), vary))).toBe('1:en')
		expect(await text(fetchCached(req('/vary', { 'accept-language': 'fr' }), vary))).toBe('2:fr')
		expect(await text(fetchCached(req('/vary', { 'accept-language': 'en' }), vary))).toBe('1:en')
		const wildcard = async () => new Response(String(++calls), { headers: { 'cache-control': 'max-age=30', vary: '*' } })
		await text(fetchCached(req('/wild'), wildcard))
		await text(fetchCached(req('/wild'), wildcard))
		expect(calls).toBe(4)
	})

	test('tenant props are canonical and unsafe or cyclic props bypass', async () => {
		ctx = new ExecutionContext({ tenant: 'a', settings: { b: 2, a: 1 } })
		await text(fetchCached())
		ctx = new ExecutionContext({ settings: { a: 1, b: 2 }, tenant: 'a' })
		expect(await text(fetchCached())).toBe('1')
		ctx = new ExecutionContext({ tenant: 'b' })
		expect(await text(fetchCached())).toBe('2')
		ctx = new ExecutionContext({ tenant: undefined })
		await text(fetchCached())
		await text(fetchCached())
		expect(calls).toBe(4)
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		expect(canonicalCacheProps(cyclic)).toBeUndefined()
		expect(canonicalCacheProps({ date: new Date() })).toBeUndefined()
		expect(canonicalCacheProps({ n: NaN })).toBeUndefined()
	})

	test('worker and entrypoint cache namespaces are isolated', async () => {
		await text(fetchCached())
		expect(await text(fetchCached(req(), origin, 'Backend'))).toBe('2')
		const other = new WorkersCache(db, 'other-worker', 'v1', config, () => now)
		expect(await text(other.fetch(req(), 'default', ctx, origin))).toBe('3')
		expect(await text(fetchCached())).toBe('1')
	})

	test('purge unions tags and prefixes across props, versions, and Vary variants but isolates entrypoints', async () => {
		const tagged = async (request: Request) =>
			new Response(String(++calls), { headers: { 'cache-control': 'max-age=60', 'cache-tag': 'BlOg', vary: 'Accept' } })
		await text(fetchCached(req('/tag', { accept: 'a' }), tagged))
		await text(fetchCached(req('/tag', { accept: 'b' }), tagged))
		await text(fetchCached(req('/prefix/item')))
		await text(fetchCached(req('/tag'), tagged, 'Backend'))
		const older = new WorkersCache(db, 'cache-test', 'v0', config, () => now)
		await text(older.fetch(req('/tag'), 'default', new ExecutionContext({ tenant: 'x' }), tagged))
		expect(await ctx.cache.purge({ tags: ['BLOG'], pathPrefixes: ['prefix/'] })).toEqual({ success: true, errors: [] })
		expect(await text(fetchCached(req('/tag', { accept: 'a' }), tagged))).toBe('6')
		expect(await text(fetchCached(req('/tag', { accept: 'b' }), tagged))).toBe('7')
		expect(await text(fetchCached(req('/prefix/item')))).toBe('8')
		expect(await text(fetchCached(req('/tag'), tagged, 'Backend'))).toBe('4')
		expect(await text(older.fetch(req('/tag'), 'default', new ExecutionContext({ tenant: 'x' }), tagged))).toBe('9')
	})

	test('purge rejects invalid modes and tags without changing stored entries', async () => {
		await text(fetchCached())
		for (
			const options of [
				{},
				{ purgeEverything: false },
				{ purgeEverything: true, tags: [] },
				{ tags: ['with space'] },
				{ tags: ['é'] },
				{ tags: ['x'.repeat(1025)] },
				{ pathPrefixes: ['https://host/x'] },
				{ pathPrefixes: ['//host/x'] },
				{ pathPrefixes: ['/x?q=1'] },
				{ pathPrefixes: ['/x#hash'] },
			]
		) {
			const result = await ctx.cache.purge(options)
			expect(result.success).toBe(false)
			expect(result.errors[0]?.code).toBeNumber()
		}
		expect(await text(fetchCached())).toBe('1')
		await ctx.cache.purge({ purgeEverything: true })
		expect(await text(fetchCached())).toBe('2')
	})

	test('purge fences slow fills and SWR refreshes', async () => {
		const response = await fetchCached()
		await ctx.cache.purge({ tags: ['blog'] })
		await response.text()
		expect(await text(fetchCached())).toBe('2')
		now += 2500
		let release: (() => void) | undefined
		const gate = new Promise<void>(resolve => {
			release = resolve
		})
		await text(fetchCached(req(), async () => {
			await gate
			return origin()
		}))
		await ctx.cache.purge({ purgeEverything: true })
		release?.()
		await ctx._awaitAll()
		expect(await text(fetchCached())).toBe('4')
	})

	test('request method, upgrade, no-store, private responses and Set-Cookie bypass', async () => {
		for (
			const request of [
				new Request('https://example.com/a', { method: 'POST' }),
				req('/a', { upgrade: 'websocket' }),
				req('/a', { 'cache-control': 'no-store' }),
			]
		) {
			await text(fetchCached(request))
			await text(fetchCached(request))
		}
		expect(calls).toBe(6)
		const headerSets: Record<string, string>[] = [
			{ 'cache-control': 'private, max-age=60' },
			{ 'cache-control': 'no-store, max-age=60' },
			{ 'cache-control': 'max-age=60', 'set-cookie': 'session=private' },
		]
		for (const headers of headerSets) {
			const uncached = async () => new Response(String(++calls), { headers })
			await text(fetchCached(req('/private'), uncached))
			await text(fetchCached(req('/private'), uncached))
		}
		expect(calls).toBe(12)
	})

	test('authorization requires explicit public/must-revalidate/s-maxage and does not hit unauthenticated-only entries', async () => {
		const auth = req('/auth', { authorization: 'Bearer token' })
		const implicit = async () => new Response(String(++calls), { headers: { 'cache-control': 'max-age=60' } })
		await text(fetchCached(req('/auth'), implicit))
		await text(fetchCached(auth, implicit))
		await text(fetchCached(auth, implicit))
		expect(calls).toBe(3)
		await text(fetchCached(auth, origin))
		await text(fetchCached(auth, origin))
		expect(calls).toBe(4)
	})

	test('field-specific cookie directives strip only the cached copy', async () => {
		const cookie = async () =>
			new Response(String(++calls), { headers: [['set-cookie', 'a=1'], ['set-cookie', 'b=2'], ['cache-control', 'private="set-cookie", max-age=60']] })
		const miss = await fetchCached(req('/cookie-field'), cookie)
		expect(miss.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
		await miss.text()
		const hit = await fetchCached(req('/cookie-field'), cookie)
		expect(hit.headers.getSetCookie()).toEqual([])
		expect(await hit.text()).toBe('1')
	})

	test('no-cache stores for conditional revalidation, rather than bypassing', async () => {
		const conditional = async (request: Request) => {
			++calls
			return request.headers.get('if-none-match') === 'v1'
				? new Response(null, { status: 304 })
				: new Response('body', { headers: { 'cache-control': 'no-cache', etag: 'v1' } })
		}
		await text(fetchCached(req(), conditional))
		const revalidated = await fetchCached(req(), conditional)
		expect(revalidated.headers.get('cf-cache-status')).toBe('REVALIDATED')
		expect(await revalidated.text()).toBe('body')
		expect(calls).toBe(2)
	})

	test('HEAD fills GET and strips its body, request revalidation bypasses fresh hits', async () => {
		const head = await fetchCached(new Request('https://example.com/page', { method: 'HEAD' }))
		expect(await head.text()).toBe('')
		await ctx._awaitAll()
		expect(await text(fetchCached())).toBe('1')
		expect(await text(fetchCached(req('/page', { 'cache-control': 'no-cache' })))).toBe('2')
	})

	test('specific CDN directives take precedence and heuristic freshness guards MIME deception', async () => {
		const headers = { 'cache-control': 'no-store', 'cdn-cache-control': 'max-age=5', 'cloudflare-cdn-cache-control': 'max-age=60' }
		const cdn = async () => new Response(String(++calls), { headers })
		const response = await fetchCached(req('/cdn'), cdn)
		expect(response.headers.has('cloudflare-cdn-cache-control')).toBe(false)
		await response.text()
		now += 10_000
		expect(await text(fetchCached(req('/cdn'), cdn))).toBe('1')
		const heuristic = async () => new Response(String(++calls), { headers: { 'content-type': 'text/html' } })
		await text(fetchCached(req('/page.css'), heuristic))
		await text(fetchCached(req('/page.css'), heuristic))
		expect(calls).toBe(3)
		await text(fetchCached(req('/plain'), heuristic))
		await text(fetchCached(req('/plain'), heuristic))
		expect(calls).toBe(4)
	})

	test('changing Vary schema replaces incompatible variants', async () => {
		await text(fetchCached(req('/vary-schema')))
		const varied = async (request: Request) =>
			new Response(`${++calls}:${request.headers.get('accept')}`, { headers: { 'cache-control': 'max-age=60', vary: 'Accept' } })
		await text(fetchCached(req('/vary-schema', { accept: 'a', 'cache-control': 'no-cache' }), varied))
		expect(await text(fetchCached(req('/vary-schema', { accept: 'b' }), varied))).toBe('3:b')
	})

	test('reload starts cold unless cross-version caching is enabled, and migrations preserve data', async () => {
		await text(fetchCached())
		migrateWorkerCache(db)
		expect(await text(new WorkersCache(db, 'cache-test', 'v2', config, () => now).fetch(req(), 'default', ctx, origin))).toBe('2')
		const shared: WranglerConfig = { ...config, cache: { enabled: true, cross_version_cache: true } }
		await text(new WorkersCache(db, 'cache-test', 'v3', shared, () => now).fetch(req(), 'default', ctx, origin))
		expect(await text(new WorkersCache(db, 'cache-test', 'v4', shared, () => now).fetch(req(), 'default', ctx, origin))).toBe('3')
	})

	test('streaming returns headers before EOF, cancellation prevents partial storage, and preserves all cookies', async () => {
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined
		let cancelled = false
		const streaming = async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(c) {
						controller = c
					},
					cancel() {
						cancelled = true
					},
				}),
				{ headers: { 'cache-control': 'max-age=60' } },
			)
		const response = await fetchCached(req('/stream'), streaming)
		controller?.enqueue(new TextEncoder().encode('first'))
		const reader = response.body?.getReader()
		expect(new TextDecoder().decode((await reader?.read())?.value)).toBe('first')
		await reader?.cancel()
		expect(cancelled).toBe(true)
		expect(await text(fetchCached(req('/stream')))).toBe('1')
		const cookies = async () => new Response('cookies', { headers: [['set-cookie', 'a=1'], ['set-cookie', 'b=2'], ['cache-control', 'max-age=30']] })
		expect((await fetchCached(req('/cookies'), cookies)).headers.getSetCookie()).toEqual(['a=1', 'b=2'])
	})

	test('dispatcher loopback, service fetch, RPC purge, and imported cache use the target context', async () => {
		class Backend {
			get [Symbol.for('lopata.WorkerEntrypoint')]() {
				return true
			}
			constructor(private ctx: CacheExecutionContext) {}
			fetch() {
				return new Response(`${++calls}:${this.ctx.props.tenant}`, { headers: { 'cache-control': 'max-age=60', 'cache-tag': 'Blog' } })
			}
			invalidate() {
				return cache.purge({ tags: ['BLOG'] })
			}
		}
		const module = { default: { fetch: origin }, Backend }
		const dispatcher = new WorkerDispatcher(module, {}, storage, props => new ExecutionContext(props))
		const exports = dispatcher.context().exports
		const backend = exports.Backend
		if (typeof backend !== 'function') throw new Error('Missing loopback factory')
		const loopback: unknown = Reflect.apply(backend, undefined, [{ props: { tenant: 'a' } }])
		if (typeof loopback !== 'object' || !loopback) throw new Error('Missing loopback')
		const loopbackFetch: unknown = Reflect.get(loopback, 'fetch')
		if (typeof loopbackFetch !== 'function') throw new Error('Missing loopback fetch')
		const fetchLoop = async () => {
			const response: unknown = await Reflect.apply(loopbackFetch, loopback, [req()])
			if (!(response instanceof Response)) throw new Error('Invalid loopback response')
			return response.text()
		}
		expect(await fetchLoop()).toBe('1:a')
		expect(await fetchLoop()).toBe('1:a')
		const service = createServiceBinding('self', 'Backend', undefined, { tenant: 'a' })
		if (typeof service._wire !== 'function' || typeof service.fetch !== 'function') throw new Error('Invalid service binding')
		Reflect.apply(service._wire, service, [module, {}])
		const bound: unknown = await Reflect.apply(service.fetch, service, [req()])
		if (!(bound instanceof Response)) throw new Error('Invalid service response')
		expect(await bound.text()).toBe('1:a')
		await dispatcher.rpc('Backend', 'invalidate', [])
		expect(await fetchLoop()).toBe('2:a')
	})

	test('trusted custom keys replace only URL components and cannot escape tenant identity', async () => {
		const request = (path: string) => workerRequest(`https://example.com${path}`, { cf: { cacheKey: 'custom' } })
		await text(storage.fetch(request('/one'), 'default', ctx, origin, true))
		expect(await text(storage.fetch(request('/two'), 'default', ctx, origin, true))).toBe('1')
		expect(await text(storage.fetch(request('/three'), 'default', new ExecutionContext({ tenant: 'b' }), origin, true))).toBe('2')
		expect(await text(storage.fetch(request('/four'), 'default', ctx, origin, false))).toBe('3')
	})
})
