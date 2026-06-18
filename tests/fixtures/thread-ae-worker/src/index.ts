const SQL_API = 'https://api.cloudflare.com/client/v4/accounts/test-account/analytics_engine/sql'

export default {
	async fetch(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url)

		if (url.pathname === '/write') {
			env.ANALYTICS.writeDataPoint({ blobs: ['GET', '/a'], doubles: [10], indexes: ['k'] })
			env.ANALYTICS.writeDataPoint({ blobs: ['GET', '/a'], doubles: [20] })
			env.ANALYTICS.writeDataPoint({ blobs: ['POST', '/b'], doubles: [100] })
			return new Response('ok')
		}

		if (url.pathname === '/query') {
			// Same code path that runs in production — Lopata intercepts this fetch.
			const res = await fetch(SQL_API, {
				method: 'POST',
				headers: { Authorization: 'Bearer local' },
				body: 'SELECT blob1 AS method, count() AS n, quantile(0.5)(double1) AS p50 FROM my_metrics GROUP BY blob1 ORDER BY n DESC',
			})
			return new Response(await res.text(), {
				status: res.status,
				headers: { 'content-type': res.headers.get('content-type') ?? 'text/plain' },
			})
		}

		return new Response('not found', { status: 404 })
	},
}
