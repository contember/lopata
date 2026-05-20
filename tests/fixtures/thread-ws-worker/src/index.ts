export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)

		if (url.pathname === '/ws/echo') {
			if (request.headers.get('Upgrade') !== 'websocket') {
				return new Response('Expected websocket', { status: 426 })
			}
			const pair = new (globalThis as any).WebSocketPair()
			const [client, server] = Object.values(pair) as [any, any]
			server.accept()
			server.addEventListener('message', (event: MessageEvent) => {
				const data = event.data
				if (typeof data === 'string') {
					server.send(`echo:${data}`)
				} else {
					server.send(data)
				}
			})
			return new Response(null, { status: 101, webSocket: client } as any)
		}

		if (url.pathname === '/ws/server-push') {
			if (request.headers.get('Upgrade') !== 'websocket') {
				return new Response('Expected websocket', { status: 426 })
			}
			const pair = new (globalThis as any).WebSocketPair()
			const [client, server] = Object.values(pair) as [any, any]
			server.accept()
			// Server initiates a message after a tick
			setTimeout(() => server.send('hello-from-server'), 10)
			return new Response(null, { status: 101, webSocket: client } as any)
		}

		if (url.pathname === '/ws/server-close') {
			if (request.headers.get('Upgrade') !== 'websocket') {
				return new Response('Expected websocket', { status: 426 })
			}
			const pair = new (globalThis as any).WebSocketPair()
			const [client, server] = Object.values(pair) as [any, any]
			server.accept()
			server.addEventListener('message', () => {
				server.close(4000, 'server-closed')
			})
			return new Response(null, { status: 101, webSocket: client } as any)
		}

		return new Response('not found', { status: 404 })
	},
}
