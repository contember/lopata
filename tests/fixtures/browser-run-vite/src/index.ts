import { DurableObject } from 'cloudflare:workers'
import { type BrowserRun, type CdpSend, openCdp } from '../cdp'

interface Env {
	BROWSER: BrowserRun
	AUX: { fetch(input: string): Promise<Response> }
	INSPECTOR: { idFromName(name: string): unknown; get(id: unknown): { fetch(input: string): Promise<Response> } }
}

/** Wait until the page finished loading and return its title. */
async function loadedTitle(send: CdpSend, sessionId: string): Promise<string> {
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

export class SessionInspector extends DurableObject<Env> {
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
			return new Response('<!doctype html><title>Hello from vite</title><p>page</p>', { headers: { 'content-type': 'text/html' } })
		}

		// Browser-level CDP from the main worker, which the Vite plugin runs in-process
		if (url.pathname === '/drive-page') {
			const connection = await env.BROWSER.launch({ keepAlive: 30_000 })
			const { socket, send } = await openCdp(connection)
			const version = await send('Browser.getVersion')
			const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
			const { sessionId: cdpSessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
			await send('Page.navigate', { url: `${url.origin}/page` }, cdpSessionId)
			const title = await loadedTitle(send, cdpSessionId)
			await send('Target.closeTarget', { targetId })
			socket.close()
			await env.BROWSER.closeSession(connection.sessionId)
			return Response.json({ product: version.product, title, afterClose: await env.BROWSER.getSession(connection.sessionId) })
		}

		if (url.pathname === '/do-shared') {
			const { sessionId } = await env.BROWSER.acquire({ keepAlive: 30_000 })
			const stub = env.INSPECTOR.get(env.INSPECTOR.idFromName('inspector'))
			const result = await (await stub.fetch(`http://do/?id=${sessionId}`)).json()
			await env.BROWSER.closeSession(sessionId)
			return Response.json(result)
		}

		// An auxiliary worker runs in its own thread and reaches the sessions over RPC
		if (url.pathname === '/aux') {
			return env.AUX.fetch('http://aux/')
		}

		return new Response('not found', { status: 404 })
	},
}
