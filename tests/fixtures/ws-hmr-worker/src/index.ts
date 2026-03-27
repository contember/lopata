import { DurableObject } from 'cloudflare:workers'

export const VERSION = 'v1'

export class EchoDO extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected websocket', { status: 426 })
		}
		const pair = new WebSocketPair()
		const [client, server] = Object.values(pair)
		this.ctx.acceptWebSocket(server)
		return new Response(null, { status: 101, webSocket: client } as any)
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message === 'string') {
			ws.send(`${VERSION}:${message}`)
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
		ws.close(code, reason)
	}
}

interface Env {
	ECHO_DO: DurableObjectNamespace
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)

		if (url.pathname === '/version') {
			return new Response(VERSION)
		}

		if (url.pathname.startsWith('/ws/')) {
			const name = url.pathname.slice(4)
			const id = env.ECHO_DO.idFromName(name)
			const stub = env.ECHO_DO.get(id)
			return stub.fetch(request)
		}

		return new Response('Not found', { status: 404 })
	},
}
