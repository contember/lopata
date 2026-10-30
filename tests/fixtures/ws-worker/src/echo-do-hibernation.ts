import { DurableObject } from 'cloudflare:workers'
import { binaryProbe } from './binary-probe'
import { closeObservations, recordClose } from './close-probe'
import { compatibilityProbe } from './compatibility-probe'

export class EchoHibernationDO extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (url.searchParams.has('close-observations')) return closeObservations(url.searchParams.get('close-observations') ?? '')
		const tag = url.searchParams.get('tag')

		if (url.pathname.endsWith('/queued-binary')) {
			const pair = new WebSocketPair()
			const [client, server] = Object.values(pair)
			server.serializeAttachment({ binaryProbe: true })
			const result = new Promise<Response>(resolve => {
				client.addEventListener('message', (event: MessageEvent) => {
					if (typeof event.data === 'string') resolve(new Response(event.data))
				})
			})
			client.accept()
			client.send(new Uint8Array([4, 5, 6]))
			this.ctx.acceptWebSocket(server)
			const response = await result
			client.close()
			return response
		}

		// Configure auto-response (HTTP)
		if (url.pathname.endsWith('/setup-auto-response')) {
			this.ctx.setWebSocketAutoResponse(
				new WebSocketRequestResponsePair('ping', 'pong'),
			)
			return new Response('auto-response configured')
		}

		// Get connected count (HTTP)
		if (url.pathname.endsWith('/count')) {
			const tagParam = url.searchParams.get('tag')
			const sockets = tagParam
				? this.ctx.getWebSockets(tagParam)
				: this.ctx.getWebSockets()
			return new Response(String(sockets.length))
		}

		// Broadcast to connections (HTTP POST)
		if (url.pathname.endsWith('/broadcast') && request.method === 'POST') {
			const body = await request.text()
			const tagParam = url.searchParams.get('tag')
			const sockets = tagParam
				? this.ctx.getWebSockets(tagParam)
				: this.ctx.getWebSockets()
			for (const ws of sockets) {
				ws.send(`broadcast:${body}`)
			}
			return new Response(`Sent to ${sockets.length} clients`)
		}

		// WebSocket upgrade
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected websocket', { status: 426 })
		}

		const pair = new WebSocketPair()
		const [client, server] = Object.values(pair)
		if (url.searchParams.has('binary-probe')) server.serializeAttachment({ binaryProbe: true })
		const closeToken = url.searchParams.get('close-probe')
		if (closeToken) server.serializeAttachment({ closeToken })
		const tags = tag ? [tag] : []
		this.ctx.acceptWebSocket(server, tags)

		return new Response(null, { status: 101, webSocket: client } as any)
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const attachment: unknown = ws.deserializeAttachment()
		if (attachment && typeof attachment === 'object' && 'binaryProbe' in attachment && attachment.binaryProbe === true) {
			await binaryProbe(ws, message)
			return
		}
		if (message === 'compatibility-probe') {
			await compatibilityProbe(ws)
			return
		}
		if (typeof message === 'string') {
			// Attachment set
			if (message.startsWith('set-attachment:')) {
				ws.serializeAttachment({ value: message.slice('set-attachment:'.length) })
				ws.send('attachment-set')
				return
			}
			// Attachment get
			if (message === 'get-attachment') {
				const attachment = ws.deserializeAttachment()
				ws.send(`attachment:${JSON.stringify(attachment)}`)
				return
			}
			// Echo
			ws.send(`echo:${message}`)
		} else {
			// Binary echo
			ws.send(message)
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
		const attachment: unknown = ws.deserializeAttachment()
		if (attachment && typeof attachment === 'object' && 'closeToken' in attachment && typeof attachment.closeToken === 'string') {
			recordClose(attachment.closeToken, 'hibernation', ws.readyState, code, reason)
		}
		// Must call ws.close() to complete the close handshake
		ws.close(code, reason)
	}

	async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		// Cleanup on error
	}
}
