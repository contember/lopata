export default {
	async fetch(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url)

		// Fetch an asset from the assets-only worker over a service binding — it has
		// no script, so this must be answered by its static-asset layer.
		if (url.pathname === '/via-site') {
			const res = await env.SITE.fetch('http://site.internal/hello.txt')
			return new Response(`api->site: ${(await res.text()).trim()} (${res.status})`)
		}

		// RPC into an assets-only worker: there is no script, so this must fail with a
		// message that says so rather than something about thread isolation.
		if (url.pathname === '/rpc-site') {
			try {
				await env.SITE.someMethod()
				return new Response('did not throw', { status: 500 })
			} catch (e: any) {
				return new Response(String(e?.message ?? e))
			}
		}

		return new Response('api root')
	},
}
