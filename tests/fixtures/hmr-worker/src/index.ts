export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname === '/version') {
			return new Response('v1')
		}
		return new Response('Not found', { status: 404 })
	},
}
