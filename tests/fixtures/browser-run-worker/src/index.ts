import puppeteer from '@cloudflare/puppeteer'

interface CdpSocket {
	accept(): void
	send(data: string): void
	close(): void
	addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
	addEventListener(type: 'close', listener: () => void): void
}

interface BrowserRunConnection {
	sessionId: string
	webSocket: { fetch(input: string, init?: RequestInit): Promise<Response & { webSocket?: CdpSocket }> }
	targets?: { id: string; type: string; url: string }[]
}

interface BrowserRun {
	acquire(options?: { keepAlive?: number; targets?: boolean }): Promise<{ sessionId: string; targets?: { id: string }[] }>
	launch(options?: { keepAlive?: number }): Promise<BrowserRunConnection>
	connectSession(sessionId: string, options?: { targetId?: string }): Promise<BrowserRunConnection>
	getSession(sessionId: string): Promise<{ sessionId: string } | null>
	listSessions(): Promise<{ sessionId: string }[]>
	history(): Promise<{ sessionId: string; closeReasonText?: string }[]>
	closeSession(sessionId: string): Promise<{ status: string }>
}

interface Env {
	BROWSER: BrowserRun
	INSPECTOR: { idFromName(name: string): unknown; get(id: unknown): { fetch(input: string): Promise<Response> } }
}

type CdpSend = (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<Record<string, any>>

async function openCdp(connection: BrowserRunConnection): Promise<{ socket: CdpSocket; send: CdpSend }> {
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

/** Wait until the page finished loading and return its title. */
async function loadedTitle(send: CdpSend, sessionId?: string): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const { result } = await send(
			'Runtime.evaluate',
			{ expression: `document.readyState === 'complete' && location.pathname === '/page' ? document.title : ''`, returnByValue: true },
			sessionId,
		)
		if (result.value) return result.value
		await new Promise(resolve => setTimeout(resolve, 100))
	}
	throw new Error('The page did not load')
}

export class SessionInspector {
	constructor(_state: unknown, private env: Env) {}

	async fetch(request: Request): Promise<Response> {
		const sessionId = new URL(request.url).searchParams.get('id') ?? ''
		const session = await this.env.BROWSER.getSession(sessionId)
		const { socket, send } = await openCdp(await this.env.BROWSER.connectSession(sessionId))
		const version = await send('Browser.getVersion')
		socket.close()
		return Response.json({ found: session?.sessionId === sessionId, product: version.product })
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)

		if (url.pathname === '/page') {
			return new Response('<!doctype html><title>Hello from lopata</title><p>page</p>', { headers: { 'content-type': 'text/html' } })
		}

		// Browser-level CDP: create a target, attach to it and navigate it
		if (url.pathname === '/cdp') {
			const connection = await env.BROWSER.launch({ keepAlive: 30_000 })
			const { socket, send } = await openCdp(connection)
			const version = await send('Browser.getVersion')
			const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
			const { sessionId: cdpSessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
			await send('Page.navigate', { url: `${url.origin}/page` }, cdpSessionId)
			const title = await loadedTitle(send, cdpSessionId)
			const activeBeforeClose = (await env.BROWSER.getSession(connection.sessionId))?.sessionId === connection.sessionId
			socket.close()
			const closed = await env.BROWSER.closeSession(connection.sessionId)
			const afterClose = await env.BROWSER.getSession(connection.sessionId)
			const history = await env.BROWSER.history()
			return Response.json({
				product: version.product,
				title,
				activeBeforeClose,
				closeStatus: closed.status,
				afterClose,
				closeReasonText: history.find(session => session.sessionId === connection.sessionId)?.closeReasonText,
			})
		}

		// Page-level CDP: connectSession with a targetId opens the page's own endpoint
		if (url.pathname === '/cdp-target') {
			const acquired = await env.BROWSER.acquire({ keepAlive: 30_000, targets: true })
			const browserLevel = await openCdp(await env.BROWSER.connectSession(acquired.sessionId))
			const { targetId } = await browserLevel.send('Target.createTarget', { url: `${url.origin}/page` })
			browserLevel.socket.close()
			const pageLevel = await openCdp(await env.BROWSER.connectSession(acquired.sessionId, { targetId }))
			const title = await loadedTitle(pageLevel.send)
			pageLevel.socket.close()
			const listed = (await env.BROWSER.listSessions()).some(session => session.sessionId === acquired.sessionId)
			await env.BROWSER.closeSession(acquired.sessionId)
			return Response.json({ targetsListed: Array.isArray(acquired.targets), title, listed })
		}

		// A session acquired by the worker is visible to a Durable Object running in its own thread
		if (url.pathname === '/do-shared') {
			const { sessionId } = await env.BROWSER.acquire({ keepAlive: 30_000 })
			const stub = env.INSPECTOR.get(env.INSPECTOR.idFromName('inspector'))
			const result = await (await stub.fetch(`http://do/?id=${sessionId}`)).json()
			await env.BROWSER.closeSession(sessionId)
			return Response.json(result)
		}

		// The legacy @cloudflare/puppeteer shim keeps working next to the Browser Run API
		if (url.pathname === '/puppeteer') {
			const browser = await puppeteer.launch(env.BROWSER)
			const page = await browser.newPage()
			await page.goto(`${url.origin}/page`)
			const title = await page.title()
			await browser.close()
			return new Response(title)
		}

		return new Response('not found', { status: 404 })
	},
}
