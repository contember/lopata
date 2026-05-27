// Upstream worker the DO talks to via env.AUX.fetch(...). Exposes a small set
// of /ws/* endpoints that return Response{status:101, webSocket} so the
// env-binding WS bridge can be exercised end-to-end.

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)

		if (url.pathname === '/ws/echo') {
			const pair = new WebSocketPair()
			const [client, server] = Object.values(pair)
			server.accept()
			server.addEventListener('message', (event: MessageEvent) => {
				const data = event.data
				if (typeof data === 'string') server.send(`echo:${data}`)
				else server.send(data)
			})
			return new Response(null, { status: 101, webSocket: client } as any)
		}

		if (url.pathname === '/ws/push') {
			const pair = new WebSocketPair()
			const [client, server] = Object.values(pair)
			server.accept()
			setTimeout(() => server.send('hello-from-aux'), 10)
			return new Response(null, { status: 101, webSocket: client } as any)
		}

		if (url.pathname === '/ws/close') {
			const pair = new WebSocketPair()
			const [client, server] = Object.values(pair)
			server.accept()
			server.addEventListener('message', () => {
				server.close(4010, 'aux-closing')
			})
			return new Response(null, { status: 101, webSocket: client } as any)
		}

		return new Response('aux: not found', { status: 404 })
	},
}
