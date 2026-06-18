export default {
	async fetch(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url)

		if (url.pathname === '/local') {
			return new Response('main says hi')
		}

		if (url.pathname.startsWith('/via-aux/')) {
			// Forward to aux through the service binding, preserving query string.
			const auxUrl = `http://aux.internal${url.pathname.replace('/via-aux', '')}${url.search}`
			const auxRes = await env.AUX.fetch(auxUrl)
			const auxText = await auxRes.text()
			return new Response(`main->aux: ${auxText}`)
		}

		if (url.pathname.startsWith('/aux-rpc/')) {
			const method = url.pathname.slice('/aux-rpc/'.length)
			if (method === 'double') {
				const n = Number(url.searchParams.get('n') ?? '0')
				const result = await env.AUX.double(n)
				return new Response(String(result))
			}
			if (method === 'greet') {
				const name = url.searchParams.get('name') ?? 'world'
				const result = await env.AUX.greet(name)
				return Response.json(result)
			}
			if (method === 'fail-rich') {
				// Report what actually survived the cross-worker RPC error path.
				try {
					await env.AUX.failRich()
					return new Response('did not throw', { status: 500 })
				} catch (e: any) {
					return Response.json({
						name: e?.name,
						message: e?.message,
						code: e?.code,
						status: e?.status,
						causeMessage: e?.cause?.message ?? null,
					})
				}
			}
		}

		return new Response('not found', { status: 404 })
	},
}
