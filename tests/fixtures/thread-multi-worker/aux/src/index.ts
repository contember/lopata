export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname === '/ping') {
			return new Response('aux pong')
		}
		if (url.pathname === '/echo') {
			return new Response(`aux echo ${url.search}`)
		}
		return new Response('aux: not found', { status: 404 })
	},

	// Service-binding RPC methods invoked from worker A via `env.AUX.<method>()`.
	async double(n: number): Promise<number> {
		return n * 2
	},

	async greet(name: string): Promise<{ greeting: string }> {
		return { greeting: `aux greets ${name}` }
	},
}
