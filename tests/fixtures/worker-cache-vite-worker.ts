import { cache } from 'cloudflare:workers'
import type { CacheExecutionContext } from '../../src/bindings/worker-cache'

let calls = 0
let completed = 0
export default {
	async fetch(request: Request, _env: unknown, ctx: CacheExecutionContext): Promise<Response> {
		const path = new URL(request.url).pathname
		if (path === '/state') return new Response(JSON.stringify({ calls, completed }), { headers: { 'cache-control': 'no-store' } })
		if (path === '/purge') {
			return new Response(JSON.stringify(await cache.purge({ purgeEverything: true })), { headers: { 'cache-control': 'no-store' } })
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
			return new Response('queued', { headers: { 'cache-control': 'no-store' } })
		}
		const invocation = ++calls
		if (invocation > 1) await new Promise(resolve => setTimeout(resolve, 100))
		return new Response(String(invocation), { headers: { 'cache-control': 'max-age=0, stale-while-revalidate=60' } })
	},
}
