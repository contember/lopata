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

	// Throws an error carrying custom props + a cause chain — the caller must
	// receive them intact across the thread boundary (entrypoint-rpc-error path).
	async failRich(): Promise<never> {
		throw Object.assign(new Error('rich failure'), {
			code: 'E_RICH',
			status: 422,
			cause: new Error('root cause'),
		})
	},
}
