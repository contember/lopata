import { WorkerEntrypoint } from 'cloudflare:workers'

// The class-based entrypoint shape: handlers live on the prototype, and env/ctx arrive
// through the constructor rather than the argument list. `this.env.GREETING` and the
// waitUntil below are reported back over fetch, so the test can tell a constructed
// instance from a prototype method called with the wrong `this`.
let ticks = 0
const mails: unknown[] = []
let waitUntilRan = false

export default class extends WorkerEntrypoint<{ GREETING: string }> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname === '/state') {
			return Response.json({ greeting: this.env.GREETING, ticks, mails, waitUntilRan })
		}
		return new Response('Not found', { status: 404 })
	}

	async scheduled(controller: any): Promise<void> {
		ticks++
		this.ctx.waitUntil(
			Promise.resolve().then(() => {
				waitUntilRan = true
			}),
		)
	}

	async email(message: any): Promise<void> {
		mails.push({ from: message.from, to: message.to, greeting: this.env.GREETING })
	}
}
