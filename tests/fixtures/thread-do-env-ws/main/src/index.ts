// Test fixture for env-binding WS upgrade returned to a DO.
//
// The DO opens an upstream WebSocket via `this.env.AUX.fetch('/ws/...')`,
// asserts the returned Response carries a usable `.webSocket`, and bridges
// messages between the client (connected to the DO's own /bridge route) and
// the upstream peer. Each /bridge-* route covers one envelope (echo, push,
// close) so the e2e test can isolate failure modes.

// Second DO class, sitting on a different env binding. Used to exercise the
// chained case: BridgeDO calls env.UPSTREAM.get(id).fetch('/ws') → main
// adopts the upgrade returned from the UpstreamDO's fetch handler → ships it
// back to BridgeDO as a synthetic peer.
export class UpstreamDO {
	state: any
	constructor(state: any) {
		this.state = state
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname === '/ws/echo') {
			const pair = new WebSocketPair()
			const [client, server] = Object.values(pair)
			server.accept()
			server.addEventListener('message', (ev: MessageEvent) => {
				const data = ev.data
				if (typeof data === 'string') server.send(`do-echo:${data}`)
				else server.send(data)
			})
			return new Response(null, { status: 101, webSocket: client } as any)
		}
		return new Response('upstream-do: not found', { status: 404 })
	}
}

export class BridgeDO {
	state: any
	env: any
	collected: string[] = []

	constructor(state: any, env: any) {
		this.state = state
		this.env = env
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)

		// Echo path: client sends a message → DO forwards to aux → aux echoes →
		// DO relays to client. Exercises both directions of the env-binding bridge.
		if (url.pathname === '/bridge-echo') {
			const upstreamRes = await this.env.AUX.fetch('http://aux.internal/ws/echo')
			if (upstreamRes.status !== 101) {
				return new Response(`upstream status ${upstreamRes.status}`, { status: 500 })
			}
			if (!upstreamRes.webSocket) {
				return new Response('upstream Response.webSocket missing', { status: 500 })
			}
			const upstream: WebSocket = upstreamRes.webSocket
			upstream.accept()

			const pair = new WebSocketPair()
			const [client, server] = Object.values(pair)
			server.accept()

			// client → server → upstream
			server.addEventListener('message', (ev: MessageEvent) => {
				upstream.send(ev.data)
			})
			server.addEventListener('close', () => upstream.close())

			// upstream → server → client
			upstream.addEventListener('message', (ev: MessageEvent) => {
				server.send(ev.data)
			})
			upstream.addEventListener('close', (ev: CloseEvent) => {
				server.close(ev.code, ev.reason)
			})

			return new Response(null, { status: 101, webSocket: client } as any)
		}

		// Push path: aux sends an unsolicited message; verify it reaches the client
		// through the bridge.
		if (url.pathname === '/bridge-push') {
			const upstreamRes = await this.env.AUX.fetch('http://aux.internal/ws/push')
			const upstream: WebSocket = (upstreamRes as any).webSocket
			upstream.accept()

			const pair = new WebSocketPair()
			const [client, server] = Object.values(pair)
			server.accept()

			upstream.addEventListener('message', (ev: MessageEvent) => server.send(ev.data))
			upstream.addEventListener('close', () => server.close())
			server.addEventListener('close', () => upstream.close())

			return new Response(null, { status: 101, webSocket: client } as any)
		}

		// Chained DO path: BridgeDO opens a WS against UpstreamDO via the env DO
		// binding. Exercises the env-binding WS bridge chained through the DO
		// fetch WS bridge (DO-worker A → main → DO-worker B → main → DO-worker A).
		if (url.pathname === '/bridge-do-echo') {
			const id = this.env.UPSTREAM.idFromName('peer')
			const stub = this.env.UPSTREAM.get(id)
			const upstreamRes = await stub.fetch('http://do/ws/echo')
			if (upstreamRes.status !== 101 || !upstreamRes.webSocket) {
				return new Response(`upstream-do bad: ${upstreamRes.status}`, { status: 500 })
			}
			const upstream: WebSocket = upstreamRes.webSocket
			upstream.accept()

			const pair = new WebSocketPair()
			const [client, server] = Object.values(pair)
			server.accept()

			server.addEventListener('message', (ev: MessageEvent) => upstream.send(ev.data))
			server.addEventListener('close', () => upstream.close())
			upstream.addEventListener('message', (ev: MessageEvent) => server.send(ev.data))
			upstream.addEventListener('close', (ev: CloseEvent) => server.close(ev.code, ev.reason))

			return new Response(null, { status: 101, webSocket: client } as any)
		}

		// Close path: aux closes with a specific code; verify it propagates.
		if (url.pathname === '/bridge-close') {
			const upstreamRes = await this.env.AUX.fetch('http://aux.internal/ws/close')
			const upstream: WebSocket = (upstreamRes as any).webSocket
			upstream.accept()

			const pair = new WebSocketPair()
			const [client, server] = Object.values(pair)
			server.accept()

			server.addEventListener('message', (ev: MessageEvent) => upstream.send(ev.data))
			upstream.addEventListener('close', (ev: CloseEvent) => server.close(ev.code, ev.reason))

			return new Response(null, { status: 101, webSocket: client } as any)
		}

		return new Response('do: not found', { status: 404 })
	}
}

export default {
	async fetch(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname === '/health') return new Response('ok')
		// Route every /bridge-* to the singleton BridgeDO.
		const id = env.BRIDGE.idFromName('singleton')
		const stub = env.BRIDGE.get(id)
		return stub.fetch(`http://do${url.pathname}${url.search}`, {
			method: request.method,
			headers: request.headers,
		})
	},
}
