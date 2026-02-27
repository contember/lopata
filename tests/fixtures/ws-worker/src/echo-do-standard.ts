import { DurableObject } from 'cloudflare:workers'

export class EchoStandardDO extends DurableObject {
	connections: WebSocket[] = []

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)

		// Broadcast endpoint (HTTP POST) — sends a message to all connected WS clients
		if (url.pathname.endsWith('/broadcast') && request.method === 'POST') {
			const body = await request.text()
			for (const ws of this.connections) {
				ws.send(`broadcast:${body}`)
			}
			return new Response(`Sent to ${this.connections.length} clients`)
		}

		// WebSocket upgrade
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected websocket', { status: 426 })
		}

		const pair = new WebSocketPair()
		const [client, server] = Object.values(pair)
		server.accept()
		this.connections.push(server)

		server.addEventListener('message', (event: MessageEvent) => {
			const data = event.data
			if (typeof data === 'string') {
				server.send(`echo:${data}`)
			} else {
				server.send(data)
			}
		})

		server.addEventListener('close', () => {
			this.connections = this.connections.filter(c => c !== server)
		})

		return new Response(null, { status: 101, webSocket: client } as any)
	}
}
