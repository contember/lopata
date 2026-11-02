interface Env {
	ASSETS: { fetch(request: Request): Promise<Response> }
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)
		// The worker owns `/f/*` and answers 404 for unknown ones; everything else goes to assets.
		if (url.pathname.startsWith('/f/')) {
			return new Response('worker-not-found', { status: 404, headers: { 'content-type': 'text/plain' } })
		}
		return env.ASSETS.fetch(request)
	},
}
