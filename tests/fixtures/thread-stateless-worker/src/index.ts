export default {
	async fetch(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url)

		if (url.pathname === '/vars') {
			return new Response(env.GREETING ?? 'missing')
		}

		if (url.pathname === '/kv/put') {
			await env.MY_KV.put('key', 'kv-value')
			return new Response('ok')
		}
		if (url.pathname === '/kv/get') {
			return new Response((await env.MY_KV.get('key')) ?? 'missing')
		}

		if (url.pathname === '/r2/put') {
			await env.MY_R2.put('key', 'r2-bytes')
			return new Response('ok')
		}
		if (url.pathname === '/r2/get') {
			const obj = await env.MY_R2.get('key')
			return new Response(obj ? await obj.text() : 'missing')
		}

		if (url.pathname === '/d1') {
			await env.MY_D1.exec('CREATE TABLE IF NOT EXISTS t (v TEXT)')
			await env.MY_D1.prepare('INSERT INTO t (v) VALUES (?)').bind('d1-row').run()
			const row = await env.MY_D1.prepare('SELECT v FROM t LIMIT 1').first()
			return new Response(row?.v ?? 'missing')
		}

		if (url.pathname === '/cache') {
			const cache = (globalThis as any).caches.default
			const cacheKey = new Request('https://cache.test/key')
			let hit = await cache.match(cacheKey)
			if (!hit) {
				await cache.put(cacheKey, new Response('cache-value'))
				hit = await cache.match(cacheKey)
			}
			return new Response(hit ? await hit.text() : 'missing')
		}

		if (url.pathname === '/throw') {
			throw new Error('user-fetch-kaboom')
		}

		return new Response('not found', { status: 404 })
	},
}
