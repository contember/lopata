export interface CdpSocket {
	accept(): void
	send(data: string): void
	close(): void
	addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
	addEventListener(type: 'close', listener: () => void): void
}

export interface BrowserRunConnection {
	sessionId: string
	webSocket: { fetch(input: string, init?: RequestInit): Promise<Response & { webSocket?: CdpSocket }> }
}

export interface BrowserRun {
	acquire(options?: { keepAlive?: number }): Promise<{ sessionId: string }>
	launch(options?: { keepAlive?: number }): Promise<BrowserRunConnection>
	connectSession(sessionId: string, options?: { targetId?: string }): Promise<BrowserRunConnection>
	getSession(sessionId: string): Promise<{ sessionId: string } | null>
	closeSession(sessionId: string): Promise<{ status: string }>
}

export type CdpSend = (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<Record<string, any>>

export async function openCdp(connection: BrowserRunConnection): Promise<{ socket: CdpSocket; send: CdpSend }> {
	const response = await connection.webSocket.fetch('https://browser-binding.invalid', { headers: { Upgrade: 'websocket' } })
	const socket = response.webSocket
	if (!socket) throw new Error('Browser Run did not return a WebSocket')
	socket.accept()

	let nextId = 0
	const pending = new Map<number, { resolve: (value: Record<string, any>) => void; reject: (error: Error) => void }>()
	socket.addEventListener('message', event => {
		const message = JSON.parse(String(event.data))
		const entry = pending.get(message.id)
		if (!entry) return
		pending.delete(message.id)
		if (message.error) entry.reject(new Error(message.error.message))
		else entry.resolve(message.result)
	})
	socket.addEventListener('close', () => {
		for (const entry of pending.values()) entry.reject(new Error('CDP socket closed'))
		pending.clear()
	})
	const send: CdpSend = (method, params = {}, sessionId) =>
		new Promise((resolve, reject) => {
			const id = ++nextId
			pending.set(id, { resolve, reject })
			socket.send(JSON.stringify({ id, method, params, sessionId }))
		})
	return { socket, send }
}

/** Launch a session, read the browser version and open a target over CDP, close the session and confirm it is gone. */
export async function versionRoundTrip(browser: BrowserRun): Promise<{ product: string; afterClose: unknown }> {
	const connection = await browser.launch({ keepAlive: 30_000 })
	const { socket, send } = await openCdp(connection)
	const version = await send('Browser.getVersion')
	const { targetId } = await send('Target.createTarget', { url: 'about:blank#round-trip' })
	await send('Target.closeTarget', { targetId })
	socket.close()
	await browser.closeSession(connection.sessionId)
	return { product: version.product, afterClose: await browser.getSession(connection.sessionId) }
}
