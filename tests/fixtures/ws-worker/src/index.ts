export { EchoHibernationDO } from './echo-do-hibernation'
export { EchoStandardDO } from './echo-do-standard'

interface Env {
	ECHO_STANDARD: DurableObjectNamespace
	ECHO_HIBERNATION: DurableObjectNamespace
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)
		const parts = url.pathname.split('/')
		// parts: ['', 'ws', '<type>', '<name>', '<sub-route>?']

		// Plain worker WebSocket — echo
		if (url.pathname === '/ws/plain') {
			if (request.headers.get('Upgrade') !== 'websocket') {
				return new Response('Expected websocket', { status: 426 })
			}
			const pair = new WebSocketPair()
			const [client, server] = Object.values(pair)
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

		// Plain WS with server-initiated message
		if (url.pathname === '/ws/plain-server-push') {
			if (request.headers.get('Upgrade') !== 'websocket') {
				return new Response('Expected websocket', { status: 426 })
			}
			const pair = new WebSocketPair()
			const [client, server] = Object.values(pair)
			server.accept()
			server.send('hello-from-server')
			server.addEventListener('message', (event: MessageEvent) => {
				server.send(`echo:${event.data}`)
			})
			return new Response(null, { status: 101, webSocket: client } as any)
		}

		// Plain WS with server-initiated close
		if (url.pathname === '/ws/plain-server-close') {
			if (request.headers.get('Upgrade') !== 'websocket') {
				return new Response('Expected websocket', { status: 426 })
			}
			const pair = new WebSocketPair()
			const [client, server] = Object.values(pair)
			server.accept()
			server.addEventListener('message', (event: MessageEvent) => {
				if (event.data === 'close-me') {
					server.close(4000, 'server-closed')
				}
			})
			return new Response(null, { status: 101, webSocket: client } as any)
		}

		// DO Standard API
		if (parts[2] === 'do-standard' && parts[3]) {
			const name = parts[3]
			const id = env.ECHO_STANDARD.idFromName(name)
			const stub = env.ECHO_STANDARD.get(id)
			return stub.fetch(request)
		}

		// DO Hibernation API
		if (parts[2] === 'do-hibernation' && parts[3]) {
			const name = parts[3]
			const id = env.ECHO_HIBERNATION.idFromName(name)
			const stub = env.ECHO_HIBERNATION.get(id)
			return stub.fetch(request)
		}

		return new Response('Not found', { status: 404 })
	},
}
