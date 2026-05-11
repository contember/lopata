import { depValue } from './dep'

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname === '/version') {
			return new Response('v1')
		}
		if (url.pathname === '/dep') {
			return new Response(depValue)
		}
		return new Response('Not found', { status: 404 })
	},
}
