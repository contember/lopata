export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)

		if (url.pathname === '/echo' || url.pathname === '/') {
			const body = request.method === 'POST' ? await request.text() : null
			return Response.json({
				worker: 'echo',
				method: request.method,
				url: request.url,
				headers: Object.fromEntries(request.headers),
				body,
			})
		}

		if (url.pathname === '/ping') {
			return new Response('pong from echo worker')
		}

		return new Response('echo worker: not found', { status: 404 })
	},

	/** RPC method — callable via service binding */
	greet(name: string): string {
		return `Hello, ${name}! (from echo worker)`
	},

	/** RPC method — returns structured data */
	info(): { worker: string; timestamp: number } {
		return { worker: 'echo', timestamp: Date.now() }
	},
} satisfies ExportedHandler<Env>
