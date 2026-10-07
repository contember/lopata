import { cache } from 'cloudflare:workers'
import type { DispatchExecutionContext } from '../../src/bindings/worker-dispatcher'

let calls = 0
let completed = 0
export default {
	async fetch(request: Request, _env: unknown, ctx: DispatchExecutionContext): Promise<Response> {
		const path = new URL(request.url).pathname
		if (path === '/state') return Response.json({ completed })
		if (path === '/purge') {
			return Response.json([await cache.purge({ purgeEverything: true }), await ctx.cache.invalidate({ tags: ['page'] })])
		}
		if (path === '/wait-until') {
			ctx.waitUntil(
				new Promise<void>(resolve =>
					setTimeout(() => {
						completed++
						resolve()
					}, 100)
				),
			)
			return new Response('queued')
		}
		return new Response(String(++calls), { headers: { 'cache-control': 'public, max-age=3600' } })
	},
}
