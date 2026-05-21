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

		return new Response('not found', { status: 404 })
	},
}
