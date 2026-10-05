import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cache, WorkersCache } from '../src/bindings/worker-cache'
import { ExecutionContext, runWithExecutionContext } from '../src/execution-context'

describe('Workers Cache invalidation', () => {
	let db: Database
	let now: number
	let storage: WorkersCache
	let ctx: ExecutionContext
	const config = { name: 'invalidate', cache: { enabled: true } }
	const request = (path = '/page', headers?: RequestInit['headers']) => new Request(`https://example.com${path}`, { headers })
	const response = (body = 'original', headers?: Record<string, string>) =>
		new Response(body, { headers: { 'cache-control': 'max-age=60', etag: '"v1"', ...headers } })
	const fetchCached = (origin: (request: Request) => Promise<Response>, req = request()) => storage.fetch(req, 'default', ctx, origin)
	const text = async (result: Promise<Response>) => (await result).text()
	beforeEach(() => {
		db = new Database(':memory:')
		now = 100_000
		storage = new WorkersCache(db, config.name, 'v1', config, () => now)
		ctx = new ExecutionContext()
		ctx.cache = storage.api('default')
	})
	afterEach(async () => {
		await ctx._awaitAll()
		db.close()
	})

	for (
		const validator of [{ etag: '"v1"', conditional: 'if-none-match' }, {
			'last-modified': 'Mon, 05 Oct 2026 10:00:00 GMT',
			conditional: 'if-modified-since',
		}]
	) {
		test(`${validator.conditional} revalidates retained body and merged metadata, then hits`, async () => {
			const headers = new Headers({ 'cache-control': 'max-age=60', 'x-retained': 'yes', 'x-replaced': 'old' })
			const value = validator.etag ?? validator['last-modified']
			headers.set(validator.etag ? 'etag' : 'last-modified', value)
			await text(fetchCached(async () => new Response('original', { headers })))
			now += 5000
			expect(await runWithExecutionContext(ctx, () => cache.invalidate({ purgeEverything: true }))).toEqual({ success: true, errors: [] })
			let calls = 0
			const origin = async (req: Request) => {
				calls++
				expect(req.headers.get(validator.conditional)).toBe(value)
				return new Response(null, { status: 304, headers: { 'x-replaced': 'new', 'cache-control': 'max-age=120' } })
			}
			const revalidated = await fetchCached(origin)
			expect(revalidated.headers.get('cf-cache-status')).toBe('REVALIDATED')
			expect(revalidated.headers.get('x-retained')).toBe('yes')
			expect(revalidated.headers.get('x-replaced')).toBe('new')
			expect(await revalidated.text()).toBe('original')
			now += 61_000
			const hit = await fetchCached(origin)
			expect(hit.headers.get('cf-cache-status')).toBe('HIT')
			expect(await hit.text()).toBe('original')
			expect(calls).toBe(1)
		})
	}

	for (const validators of [true, false]) {
		test(`200 replaces invalidated content (validators ${validators})`, async () => {
			await text(fetchCached(async () =>
				new Response('old', {
					headers: {
						'cache-control': 'max-age=60',
						...(validators ? { etag: '"old"' } : {}),
					},
				})
			))
			await ctx.cache.invalidate({ pathPrefixes: ['page'] })
			const fresh = await fetchCached(async req => {
				expect(req.headers.get('if-none-match')).toBe(validators ? '"old"' : null)
				expect(req.headers.has('if-modified-since')).toBe(false)
				return response('new', { etag: '"new"' })
			})
			expect(fresh.headers.get('cf-cache-status')).toBe('EXPIRED')
			expect(await fresh.text()).toBe('new')
			const hit = await fetchCached(async () => {
				throw new Error('Unexpected fill')
			})
			expect(hit.headers.get('cf-cache-status')).toBe('HIT')
			expect(hit.headers.get('etag')).toBe('"new"')
			expect(await hit.text()).toBe('new')
		})
	}

	test('tag/prefix union covers props, versions and all variants of matching keys while isolating namespaces', async () => {
		const cases = [
			{ worker: config.name, version: 'v1', entrypoint: 'default', tenant: 'a', path: '/tag', accept: 'a', tag: 'BlOg', selected: true },
			{ worker: config.name, version: 'v1', entrypoint: 'default', tenant: 'a', path: '/tag', accept: 'b', tag: 'other', selected: true },
			{ worker: config.name, version: 'v0', entrypoint: 'default', tenant: 'a', path: '/tag', accept: 'a', tag: 'other', selected: true },
			{ worker: config.name, version: 'v0', entrypoint: 'default', tenant: 'b', path: '/tag', accept: 'a', tag: 'blog', selected: true },
			{ worker: config.name, version: 'v1', entrypoint: 'default', tenant: 'a', path: '/prefix/item', accept: 'a', tag: 'other', selected: true },
			{ worker: config.name, version: 'v1', entrypoint: 'default', tenant: 'a', path: '/untouched', accept: 'a', tag: 'other', selected: false },
			{ worker: config.name, version: 'v1', entrypoint: 'Backend', tenant: 'a', path: '/tag', accept: 'a', tag: 'blog', selected: false },
			{ worker: 'other', version: 'v1', entrypoint: 'default', tenant: 'a', path: '/prefix/item', accept: 'a', tag: 'blog', selected: false },
		]
		for (const item of cases) {
			const owner = new WorkersCache(db, item.worker, item.version, config, () => now)
			await text(
				owner.fetch(
					request(item.path, { accept: item.accept }),
					item.entrypoint,
					new ExecutionContext({ tenant: item.tenant }),
					async () => response(item.path, { vary: 'Accept', 'cache-tag': item.tag }),
				),
			)
		}
		expect(await ctx.cache.invalidate({ tags: ['BLOG'], pathPrefixes: ['prefix/'] })).toEqual({ success: true, errors: [] })
		for (const item of cases) {
			const owner = new WorkersCache(db, item.worker, item.version, config, () => now)
			const result = await owner.fetch(
				request(item.path, { accept: item.accept }),
				item.entrypoint,
				new ExecutionContext({ tenant: item.tenant }),
				async req => {
					expect(req.headers.get('if-none-match')).toBe('"v1"')
					return new Response(null, { status: 304 })
				},
			)
			expect(result.headers.get('cf-cache-status')).toBe(item.selected ? 'REVALIDATED' : 'HIT')
			expect(await result.text()).toBe(item.path)
		}
	})

	test('invalidation persists across closing and reopening SQLite', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'invalidate-'))
		let persisted = new Database(join(dir, 'cache.sqlite'))
		try {
			let owner = new WorkersCache(persisted, config.name, 'v1', config, () => now)
			await text(owner.fetch(request(), 'default', ctx, async () => response()))
			await owner.api('default').invalidate({ purgeEverything: true })
			persisted.close()
			persisted = new Database(join(dir, 'cache.sqlite'))
			owner = new WorkersCache(persisted, config.name, 'v1', config, () => now)
			const result = await owner.fetch(request(), 'default', ctx, async req => {
				expect(req.headers.get('if-none-match')).toBe('"v1"')
				return new Response(null, { status: 304 })
			})
			expect(result.headers.get('cf-cache-status')).toBe('REVALIDATED')
			expect(await result.text()).toBe('original')
		} finally {
			persisted.close()
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test('invalid options preserve entries and do not fence an in-flight fill; purge errors remain identical', async () => {
		await text(fetchCached(async () => response()))
		const gate = Promise.withResolvers<Response>()
		const pending = fetchCached(() => gate.promise, request('/pending'))
		for (
			const options of [
				null,
				[],
				'all',
				{},
				{ unknown: true },
				{ purgeEverything: false },
				{ purgeEverything: true, tags: ['x'] },
				{ tags: [] },
				{ tags: [1] },
				{ tags: ['with space'] },
				{ tags: ['a,b'] },
				{ tags: ['é'] },
				{ tags: ['x'.repeat(1025)] },
				{ tags: Array(1001).fill('x') },
				{ pathPrefixes: [] },
				{ pathPrefixes: [1] },
				{ pathPrefixes: [''] },
				{ pathPrefixes: ['//host'] },
				{ pathPrefixes: ['https://host/path'] },
				{ pathPrefixes: ['/path?q=1'] },
				{ pathPrefixes: ['/path#fragment'] },
			]
		) {
			const result = await ctx.cache.invalidate(options)
			expect(result.success).toBe(false)
			expect(result.errors[0]?.code).toBe(1000)
			expect(result).toEqual(await ctx.cache.purge(options))
		}
		gate.resolve(response('pending'))
		expect(await text(pending)).toBe('pending')
		for (const path of ['/page', '/pending']) {
			const hit = await fetchCached(async () => {
				throw new Error('Unexpected fill')
			}, request(path))
			expect(hit.headers.get('cf-cache-status')).toBe('HIT')
			expect(await hit.text()).toBe(path === '/page' ? 'original' : 'pending')
		}
	})

	test('persisted epoch fences a slow fill from another cache instance', async () => {
		const gate = Promise.withResolvers<Response>()
		const pending = fetchCached(() => gate.promise)
		const other = new WorkersCache(db, config.name, 'v1', config, () => now)
		await other.api('default').invalidate({ purgeEverything: true })
		await text(other.fetch(request(), 'default', ctx, async () => response('new')))
		gate.resolve(response('obsolete'))
		expect(await text(pending)).toBe('obsolete')
		expect(await text(fetchCached(async () => response('unexpected')))).toBe('new')
	})

	test('invalidation between stream headers and EOF prevents the old body from being stored', async () => {
		const gate = Promise.withResolvers<void>()
		const pending = await fetchCached(async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					async start(controller) {
						controller.enqueue(new TextEncoder().encode('old'))
						await gate.promise
						controller.close()
					},
				}),
				{ headers: { 'cache-control': 'max-age=60' } },
			)
		)
		await ctx.cache.invalidate({ purgeEverything: true })
		await text(fetchCached(async () => response('new')))
		gate.resolve()
		expect(await pending.text()).toBe('old')
		expect(await text(fetchCached(async () => response('unexpected')))).toBe('new')
	})

	test('invalidation fences an active SWR refresh and lets a new epoch refresh proceed', async () => {
		await text(fetchCached(async () => response('original', { 'cache-control': 'max-age=1, stale-while-revalidate=10' })))
		now += 2000
		const gate = Promise.withResolvers<Response>()
		const updating = await fetchCached(() => gate.promise)
		expect(updating.headers.get('cf-cache-status')).toBe('UPDATING')
		expect(await updating.text()).toBe('original')
		await ctx.cache.invalidate({ purgeEverything: true })
		const next = await fetchCached(async () => response('new'))
		expect(next.headers.get('cf-cache-status')).toBe('UPDATING')
		await next.text()
		gate.resolve(response('obsolete'))
		await ctx._awaitAll()
		expect(await text(fetchCached(async () => response('unexpected')))).toBe('new')
	})

	for (const elapsed of [9999, 10_000]) {
		test(`local TTL-zero policy keeps the original SWR boundary at ${elapsed}ms`, async () => {
			await text(fetchCached(async () => response('original', { 'cache-control': 'max-age=60, stale-while-revalidate=10, stale-if-error=0', age: '3' })))
			now += 1000
			await ctx.cache.invalidate({ purgeEverything: true })
			now = 100_000 + elapsed - 3000
			await ctx.cache.invalidate({ purgeEverything: true })
			const gate = Promise.withResolvers<Response>()
			const pending = fetchCached(() => gate.promise)
			gate.resolve(response('new'))
			const result = await pending
			expect(result.headers.get('cf-cache-status')).toBe(elapsed < 10_000 ? 'UPDATING' : 'EXPIRED')
			if (elapsed < 10_000) expect(result.headers.get('age')).toBe('9')
			expect(await result.text()).toBe(elapsed < 10_000 ? 'original' : 'new')
		})
	}

	for (const elapsed of [9999, 10_000]) {
		test(`local TTL-zero policy keeps the original SIE boundary at ${elapsed}ms`, async () => {
			await text(fetchCached(async () => response('original', { 'cache-control': 'max-age=60, stale-if-error=10', 'x-retained': 'yes', age: '3' })))
			now += 1000
			await ctx.cache.invalidate({ purgeEverything: true })
			now = 100_000 + elapsed - 3000
			await ctx.cache.invalidate({ purgeEverything: true })
			const result = await fetchCached(async req => {
				expect(req.headers.get('if-none-match')).toBe('"v1"')
				return new Response('unavailable', { status: 503, headers: { 'cache-control': 'no-store' } })
			})
			expect(result.status).toBe(elapsed < 10_000 ? 200 : 503)
			if (elapsed < 10_000) {
				expect(result.headers.get('cf-cache-status')).toBe('STALE')
				expect(result.headers.get('age')).toBe('9')
				expect(result.headers.get('x-retained')).toBe('yes')
			}
			expect(await result.text()).toBe(elapsed < 10_000 ? 'original' : 'unavailable')
		})
	}

	test('imported invalidate requires an active attached context', async () => {
		expect(() => cache.invalidate({ purgeEverything: true })).toThrow('cache.invalidate() requires an active Worker execution context')
		await expect(runWithExecutionContext(new ExecutionContext(), () => cache.invalidate({ purgeEverything: true })))
			.rejects.toThrow('Workers Cache is not attached to this execution context')
		await expect(new ExecutionContext().cache.invalidate({ purgeEverything: true }))
			.rejects.toThrow('Workers Cache is not attached to this execution context')
	})
})
