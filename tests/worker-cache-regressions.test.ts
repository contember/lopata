import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { RPC_TARGET_BRAND } from '../src/bindings/rpc-stub'
import { createServiceBinding } from '../src/bindings/service-binding'
import { cache, type CacheExecutionContext, canonicalCacheProps, WorkerDispatcher, workerRequest, WorkersCache } from '../src/bindings/worker-cache'
import { ExecutionContext, runWithExecutionContext } from '../src/execution-context'

describe('Workers Cache review regressions', () => {
	let db: Database
	let now: number
	let ctx: ExecutionContext
	let storage: WorkersCache
	const request = (headers?: RequestInit['headers']) => new Request('https://example.com/data', { headers })
	const fetchCached = (invoke: (request: Request) => Promise<Response>, req = request()) => storage.fetch(req, 'default', ctx, invoke)
	const text = async (response: Promise<Response>) => (await response).text()
	beforeEach(() => {
		db = new Database(':memory:')
		now = Date.UTC(2026, 9, 2, 12)
		ctx = new ExecutionContext()
		storage = new WorkersCache(db, 'review', 'v1', { name: 'review', cache: { enabled: true } }, () => now)
	})
	afterEach(async () => {
		await ctx._awaitAll()
		db.close()
	})

	for (const change of [{ 'cache-control': 'private, max-age=60' }, { 'cache-control': 'no-store, max-age=60' }, { 'set-cookie': 'session=secret' }]) {
		test(`304 evicts uncacheable merged metadata ${JSON.stringify(change)}`, async () => {
			let calls = 0
			const origin = async () => {
				calls++
				if (calls === 2) return new Response(null, { status: 304, headers: new Headers(Object.entries(change)) })
				return new Response(String(calls), { headers: { 'cache-control': 'max-age=1, must-revalidate', etag: '"v1"' } })
			}
			expect(await text(fetchCached(origin))).toBe('1')
			now += 2000
			const revalidated = await fetchCached(origin)
			expect(revalidated.headers.get('cf-cache-status')).toBe('BYPASS')
			await revalidated.text()
			const next = await fetchCached(origin)
			expect(next.headers.get('cf-cache-status')).toBe('MISS')
			expect(next.headers.getSetCookie()).toEqual([])
			expect(await next.text()).toBe('3')
		})
	}

	test('304 field-specific Set-Cookie rules retain live cookies but strip cached cookies', async () => {
		let calls = 0
		const origin = async () =>
			++calls === 1
				? new Response('body', { headers: { 'cache-control': 'max-age=1', etag: '"v1"' } })
				: new Response(null, {
					status: 304,
					headers: [['cache-control', 'max-age=60, private="set-cookie"'], ['set-cookie', 'a=1'], ['set-cookie', 'b=2']],
				})
		await text(fetchCached(origin))
		now += 2000
		const renewed = await fetchCached(origin)
		expect(renewed.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
		await renewed.text()
		const hit = await fetchCached(origin)
		expect(hit.headers.get('cf-cache-status')).toBe('HIT')
		expect(hit.headers.getSetCookie()).toEqual([])
		await hit.text()
	})

	test('304 rebuilds Vary identity and purge tags', async () => {
		let calls = 0
		const origin = async (req: Request) => {
			calls++
			if (calls === 2) return new Response(null, { status: 304, headers: { vary: 'X-Tenant', 'cache-tag': 'new-tag', 'cache-control': 'max-age=60' } })
			return new Response(`body:${req.headers.get('x-tenant')}`, {
				headers: {
					'cache-control': 'max-age=1',
					etag: '"v1"',
					vary: calls === 1 ? 'Accept-Language' : 'X-Tenant',
					'cache-tag': calls === 1 ? 'old-tag' : 'new-tag',
				},
			})
		}
		const a = request({ 'accept-language': 'en', 'x-tenant': 'a' })
		await text(fetchCached(origin, a))
		now += 2000
		expect(await text(fetchCached(origin, a))).toBe('body:a')
		expect(await text(fetchCached(origin, request({ 'accept-language': 'en', 'x-tenant': 'b' })))).toBe('body:b')
		await storage.api('default').purge({ tags: ['new-tag'] })
		const next = await fetchCached(origin, a)
		expect(next.headers.get('cf-cache-status')).toBe('MISS')
		await next.text()
	})

	test('304 replaces stale-if-error and authorization policy', async () => {
		let calls = 0
		const origin = async () => {
			calls++
			if (calls === 1) return new Response('body', { headers: { 'cache-control': 'public, max-age=1', etag: '"v1"' } })
			if (calls === 2) return new Response(null, { status: 304, headers: { 'cache-control': 'max-age=1, stale-if-error=0' } })
			return new Response('failure', { status: 503 })
		}
		await text(fetchCached(origin))
		now += 2000
		await text(fetchCached(origin))
		const auth = await fetchCached(origin, request({ authorization: 'Bearer b' }))
		expect(auth.status).toBe(503)
		await auth.text()
		await storage.api('default').purge({ purgeEverything: true })
		calls = 0
		await text(fetchCached(origin))
		now += 2000
		await text(fetchCached(origin))
		now += 2000
		const error = await fetchCached(origin)
		expect(error.status).toBe(503)
		expect(await error.text()).toBe('failure')
	})

	test('cold conditional requests fill full representations and fresh hits evaluate client conditions', async () => {
		let calls = 0
		const origin = async (req: Request) => {
			calls++
			return req.headers.has('if-none-match')
				? new Response(null, { status: 304 })
				: new Response('body', { headers: { 'cache-control': 'max-age=60', etag: '"v1"', 'last-modified': new Date(now - 10_000).toUTCString() } })
		}
		const cold = await fetchCached(origin, request({ 'if-none-match': '"v1"' }))
		expect(cold.status).toBe(304)
		expect(await cold.text()).toBe('')
		await ctx._awaitAll()
		expect(await text(fetchCached(origin))).toBe('body')
		const fresh = await fetchCached(origin, request({ 'if-none-match': 'W/"v1"' }))
		expect(fresh.status).toBe(304)
		const modified = await fetchCached(origin, request({ 'if-modified-since': new Date(now).toUTCString() }))
		expect(modified.status).toBe(304)
		expect(calls).toBe(1)
	})

	test('an unsolicited standalone 304 is never stored', async () => {
		let calls = 0
		const origin = async () =>
			++calls === 1
				? new Response(null, { status: 304, headers: { 'cache-control': 'max-age=60' } })
				: new Response('complete', { headers: { 'cache-control': 'max-age=60' } })
		expect((await fetchCached(origin)).status).toBe(304)
		expect(await text(fetchCached(origin))).toBe('complete')
		expect(calls).toBe(2)
	})

	test('unsafe array indices and getters bypass without invoking getters', async () => {
		const nonIndex: unknown[] = []
		Object.defineProperty(nonIndex, '4294967295', { value: 'tenant-a', enumerable: true })
		let reads = 0
		const getter: unknown[] = []
		Object.defineProperty(getter, '0', {
			get() {
				reads++
				return 'tenant-a'
			},
			enumerable: true,
		})
		expect(canonicalCacheProps({ tenants: nonIndex })).toBeUndefined()
		expect(canonicalCacheProps({ tenants: getter })).toBeUndefined()
		expect(reads).toBe(0)
		let calls = 0
		const origin = async () => new Response(String(++calls), { headers: { 'cache-control': 'max-age=60' } })
		ctx = new ExecutionContext({ tenants: nonIndex })
		expect(await text(fetchCached(origin))).toBe('1')
		expect(await text(fetchCached(origin))).toBe('2')
	})

	test('request.cf metadata survives cloning and cache option merging without mutating the input', () => {
		const original = new Request('https://example.com/data')
		const metadata = { country: 'CZ', colo: 'PRG', clientAcceptEncoding: 'gzip, br', cacheKey: 'one' }
		Object.defineProperty(original, 'cf', { value: metadata, configurable: true })
		expect(workerRequest(original)).toBe(original)
		expect(Reflect.get(original, 'cf')).toBe(metadata)
		const forwarded = workerRequest(original, { cf: { cacheControl: 'max-age=60' } })
		expect(Reflect.get(forwarded, 'cf')).toEqual({ ...metadata, cacheControl: 'max-age=60' })
		expect(Reflect.get(original, 'cf')).toBe(metadata)
	})

	test('initial Age and apparent Date age reduce freshness and remain visible on hits', async () => {
		let calls = 0
		const origin = async () =>
			new Response(String(++calls), {
				headers: { 'cache-control': 'max-age=60, must-revalidate', age: '50', date: new Date(now - 40_000).toUTCString() },
			})
		const first = await fetchCached(origin)
		expect(first.headers.get('age')).toBe('50')
		await first.text()
		now += 5000
		const hit = await fetchCached(origin)
		expect(hit.headers.get('age')).toBe('55')
		expect(await hit.text()).toBe('1')
		now += 6000
		expect(await text(fetchCached(origin))).toBe('2')
		await storage.api('default').purge({ purgeEverything: true })
		const dated = async () =>
			new Response(String(++calls), { headers: { 'cache-control': 'max-age=60, must-revalidate', date: new Date(now - 70_000).toUTCString() } })
		await text(fetchCached(dated))
		await text(fetchCached(dated))
		expect(calls).toBe(4)
	})

	test('cold and warm ranges slice full cached bodies, handle suffixes, unsatisfiable ranges and If-Range', async () => {
		let calls = 0
		const origin = async (req: Request) => {
			expect(req.headers.has('range')).toBe(false)
			calls++
			return new Response('0123456789', { headers: { 'cache-control': 'max-age=60', 'content-length': '10', etag: '"v1"' } })
		}
		const cold = await fetchCached(origin, request({ range: 'bytes=2-4' }))
		expect(cold.status).toBe(206)
		expect(cold.headers.get('content-range')).toBe('bytes 2-4/10')
		expect(await cold.text()).toBe('234')
		await ctx._awaitAll()
		const warm = await fetchCached(origin, request({ range: 'bytes=-3' }))
		expect(warm.status).toBe(206)
		expect(await warm.text()).toBe('789')
		const invalid = await fetchCached(origin, request({ range: 'bytes=20-30' }))
		expect(invalid.status).toBe(416)
		expect(invalid.headers.get('content-range')).toBe('bytes */10')
		expect(await text(fetchCached(origin, request({ range: 'bytes=2-4', 'if-range': '"other"' })))).toBe('0123456789')
		expect(await text(fetchCached(origin, request({ range: 'bytes=6-', 'if-range': '"v1"' })))).toBe('6789')
		expect(calls).toBe(1)
	})

	test('ranges without Content-Length and multipart ranges preserve full fills', async () => {
		let calls = 0
		const origin = async () => new Response(`${++calls}:abcdef`, { headers: { 'cache-control': 'max-age=60' } })
		const cold = await fetchCached(origin, request({ range: 'bytes=2-3' }))
		expect(cold.status).toBe(206)
		expect(await cold.text()).toBe('ab')
		const multi = await fetchCached(origin, request({ range: 'bytes=2-3,6-7' }))
		expect(multi.status).toBe(206)
		expect(multi.headers.get('content-type')).toStartWith('multipart/byteranges; boundary=')
		const body = await multi.text()
		expect(body).toContain('Content-Range: bytes 2-3/8\r\n\r\nab')
		expect(body).toContain('Content-Range: bytes 6-7/8\r\n\r\nef')
		expect(calls).toBe(1)
	})

	test('returned functions, returned RpcTargets and their descendants retain callee purge scope', async () => {
		class Capability {
			[RPC_TARGET_BRAND] = true
			invalidate() {
				return cache.purge({ purgeEverything: true })
			}
			child() {
				return () => new Capability()
			}
		}
		class Backend {
			get [Symbol.for('lopata.WorkerEntrypoint')]() {
				return true
			}
			constructorReceipt: ReturnType<typeof cache.purge>
			constructor(ctx: CacheExecutionContext) {
				this.constructorReceipt = ctx.props.constructorScope
					? cache.purge({ pathPrefixes: ['/data'] })
					: Promise.resolve({ success: true, errors: [] })
			}
			fetch() {
				return new Response('backend', { headers: { 'cache-control': 'max-age=60' } })
			}
			capability() {
				return new Capability()
			}
			fn() {
				return () => () => cache.purge({ purgeEverything: true })
			}
			verifyConstructor() {
				return this.constructorReceipt
			}
		}
		const dispatcher = new WorkerDispatcher(
			{ default: { fetch: async () => new Response('default', { headers: { 'cache-control': 'max-age=60' } }) }, Backend },
			{},
			storage,
			props => new ExecutionContext(props),
		)
		const call = async (target: unknown, method: string, args: unknown[] = []): Promise<unknown> => {
			if (!target || (typeof target !== 'object' && typeof target !== 'function')) throw new Error('Missing capability')
			const member: unknown = Reflect.get(target, method)
			if (typeof member !== 'function') throw new Error('Missing capability method')
			return Reflect.apply(member, target, args)
		}
		const invoke = async (fn: unknown): Promise<unknown> => {
			if (typeof fn !== 'function') throw new Error('Missing returned function')
			return Reflect.apply(fn, undefined, [])
		}
		const outer = dispatcher.context()
		await (await dispatcher.fetch(request())).text()
		await (await dispatcher.fetch(request(), 'Backend')).text()
		await runWithExecutionContext(outer, async () => {
			expect(await dispatcher.rpc('Backend', 'verifyConstructor', [], { constructorScope: true })).toEqual({ success: true, errors: [] })
		})
		const defaultAfterConstructor = await dispatcher.fetch(request())
		expect(defaultAfterConstructor.headers.get('cf-cache-status')).toBe('HIT')
		await defaultAfterConstructor.text()
		const backendAfterConstructor = await dispatcher.fetch(request(), 'Backend')
		expect(backendAfterConstructor.headers.get('cf-cache-status')).toBe('MISS')
		await backendAfterConstructor.text()
		await runWithExecutionContext(outer, async () => {
			const fn = await dispatcher.rpc('Backend', 'fn', [])
			await invoke(await invoke(fn))
		})
		expect((await dispatcher.fetch(request())).headers.get('cf-cache-status')).toBe('HIT')
		const backend = await dispatcher.fetch(request(), 'Backend')
		expect(backend.headers.get('cf-cache-status')).toBe('MISS')
		await backend.text()
		await runWithExecutionContext(outer, async () => {
			const cap = await dispatcher.rpc('Backend', 'capability', [])
			const child = await invoke(await call(cap, 'child'))
			await call(child, 'invalidate')
		})
		const next = await dispatcher.fetch(request(), 'Backend')
		expect(next.headers.get('cf-cache-status')).toBe('MISS')
		await next.text()
	})

	test('nested loopback and in-process service waitUntil work belongs to the outer drain', async () => {
		let finished = 0
		let release: (() => void) | undefined
		const gate = new Promise<void>(resolve => {
			release = resolve
		})
		class Backend {
			get [Symbol.for('lopata.WorkerEntrypoint')]() {
				return true
			}
			constructor(private ctx: CacheExecutionContext) {}
			fetch() {
				this.ctx.waitUntil(gate.then(() => {
					this.ctx.waitUntil(
						Promise.resolve().then(() => {
							finished++
						}),
					)
				}))
				return new Response('child', { headers: { 'cache-control': 'no-store' } })
			}
		}
		const module = { Backend }
		const dispatcher = new WorkerDispatcher(module, {}, storage, props => new ExecutionContext(props))
		const service = createServiceBinding('self', 'Backend')
		const wire = service._wire
		if (typeof wire !== 'function') throw new Error('Missing service wire')
		Reflect.apply(wire, service, [module, {}])
		await runWithExecutionContext(ctx, async () => {
			await (await dispatcher.fetch(request(), 'Backend')).text()
			const fn = service.fetch
			if (typeof fn !== 'function') throw new Error('Missing service fetch')
			const response: unknown = await Reflect.apply(fn, service, [request()])
			if (!(response instanceof Response)) throw new Error('Missing service response')
			await response.text()
		})
		let settled = false
		const drained = ctx._awaitAll().then(() => {
			settled = true
		})
		await Promise.resolve()
		try {
			expect(settled).toBe(false)
		} finally {
			release?.()
		}
		await drained
		expect(finished).toBe(2)
	})

	test('nested cached entrypoint SWR is tracked by the outer request drain', async () => {
		let release: (() => void) | undefined
		const gate = new Promise<void>(resolve => {
			release = resolve
		})
		let calls = 0
		class Backend {
			get [Symbol.for('lopata.WorkerEntrypoint')]() {
				return true
			}
			async fetch() {
				const invocation = ++calls
				if (invocation > 1) await gate
				return new Response(String(invocation), { headers: { 'cache-control': 'max-age=0, stale-while-revalidate=60' } })
			}
		}
		const dispatcher = new WorkerDispatcher({ Backend }, {}, storage, props => new ExecutionContext(props))
		await runWithExecutionContext(ctx, async () => {
			const binding = dispatcher.context().exports.Backend
			if (typeof binding !== 'function') throw new Error('Missing loopback')
			const fetchBackend: unknown = Reflect.get(binding, 'fetch')
			if (typeof fetchBackend !== 'function') throw new Error('Missing loopback fetch')
			const fill: unknown = await Reflect.apply(fetchBackend, binding, [request()])
			if (!(fill instanceof Response)) throw new Error('Missing fill response')
			await fill.text()
			const stale: unknown = await Reflect.apply(fetchBackend, binding, [request()])
			if (!(stale instanceof Response)) throw new Error('Missing stale response')
			expect(stale.headers.get('cf-cache-status')).toBe('UPDATING')
			expect(await stale.text()).toBe('1')
		})
		let settled = false
		const drained = ctx._awaitAll().then(() => {
			settled = true
		})
		await Promise.resolve()
		try {
			expect(settled).toBe(false)
		} finally {
			release?.()
		}
		await drained
		const refreshed = await dispatcher.fetch(request(), 'Backend')
		expect(await refreshed.text()).toBe('2')
		await ctx._awaitAll()
	})
})
