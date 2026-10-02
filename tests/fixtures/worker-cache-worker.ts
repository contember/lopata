import { cache, WorkerEntrypoint } from 'cloudflare:workers'
import type { CacheExecutionContext } from '../../src/bindings/worker-cache'

let calls = 0
export class Backend extends WorkerEntrypoint {
	declare ctx: CacheExecutionContext
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname === '/stream') {
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('first'))
					},
				}),
				{ headers: { 'cache-control': 'max-age=60' } },
			)
		}
		if (url.pathname === '/cookies') {
			return new Response('cookies', { headers: [['set-cookie', 'a=1'], ['set-cookie', 'b=2'], ['cache-control', 'max-age=60']] })
		}
		if (url.pathname === '/swr') await new Promise(resolve => setTimeout(resolve, 200))
		return new Response(`${++calls}:${this.ctx.props.tenant ?? 'public'}`, {
			headers: { 'cache-control': url.pathname === '/swr' ? 'max-age=0, stale-while-revalidate=60' : 'max-age=60', 'cache-tag': 'Backend' },
		})
	}
	async invalidate() {
		return cache.purge({ tags: ['BACKEND'] })
	}
}

export default {
	async fetch(request: Request, env: Record<string, unknown>, ctx: CacheExecutionContext): Promise<Response> {
		const url = new URL(request.url)
		const backend = ctx.exports.Backend
		if (url.pathname === '/queue-purge') {
			const producer = env.TASKS
			if (!producer || typeof producer !== 'object') throw new Error('Missing queue producer')
			const send: unknown = Reflect.get(producer, 'send')
			if (typeof send !== 'function') throw new Error('Missing queue send')
			await Reflect.apply(send, producer, ['purge'])
			return new Response('queued')
		}
		if (url.pathname === '/queue-receipt') {
			const receipts = env.RECEIPTS
			if (!receipts || typeof receipts !== 'object') throw new Error('Missing receipt binding')
			const get: unknown = Reflect.get(receipts, 'get')
			if (typeof get !== 'function') throw new Error('Missing receipt getter')
			return new Response(await Reflect.apply(get, receipts, ['queue-cache']))
		}
		if (url.pathname === '/purge-default') return Response.json(await ctx.cache.purge({ purgeEverything: true }))
		if (url.pathname === '/service') {
			const svc = env.SELF
			if (!svc || typeof svc !== 'object') throw new Error('Missing service binding')
			const fetchService: unknown = Reflect.get(svc, 'fetch')
			if (typeof fetchService !== 'function') throw new Error('Missing service fetch')
			return Reflect.apply(fetchService, svc, ['http://internal/data'])
		}
		if (!backend || typeof backend !== 'function') throw new Error('Missing loopback')
		if (url.pathname === '/purge') {
			const invalidate = backend.invalidate
			return Response.json(await invalidate())
		}
		if (url.pathname === '/direct') return new Response(String(++calls), { headers: { 'cache-control': 'max-age=60' } })
		const binding = backend({ props: { tenant: url.searchParams.get('tenant') ?? 'public' } })
		const target = new URL(request.url)
		target.pathname = url.pathname === '/loop' ? '/data' : url.pathname
		target.searchParams.delete('tenant')
		return binding.fetch(new Request(target, request), { cf: url.searchParams.has('key') ? { cacheKey: url.searchParams.get('key') } : undefined })
	},
	async queue(_batch: unknown, env: Record<string, unknown>, ctx: CacheExecutionContext): Promise<void> {
		await ctx.cache.purge({ purgeEverything: true })
		await cache.purge({ purgeEverything: true })
		const backend = ctx.exports.Backend
		if (typeof backend !== 'function') throw new Error('Missing queue loopback')
		const invalidate: unknown = Reflect.get(backend, 'invalidate')
		if (typeof invalidate !== 'function') throw new Error('Missing invalidator')
		await Reflect.apply(invalidate, backend, [])
		const receipts = env.RECEIPTS
		if (!receipts || typeof receipts !== 'object') throw new Error('Missing receipt binding')
		const put: unknown = Reflect.get(receipts, 'put')
		if (typeof put !== 'function') throw new Error('Missing receipt writer')
		await Reflect.apply(put, receipts, ['queue-cache', 'ok'])
	},
}
