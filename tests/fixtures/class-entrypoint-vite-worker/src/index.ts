import { WorkerEntrypoint } from 'cloudflare:workers'

// The class-based entrypoint shape: handlers live on the prototype, and env/ctx arrive
// through the constructor rather than the argument list. `this.env.GREETING` and the
// waitUntil below are reported back over fetch, so the test can tell a constructed
// instance from a prototype method called with the wrong `this`.
let ticks = 0
const mails: unknown[] = []
let waitUntilRan = false

// Arming this makes every *subsequent* construction throw — the request that sets it is
// already past its own constructor. Kept last in the test file, since nothing recovers.
let constructorShouldThrow = false

export default class extends WorkerEntrypoint<{ GREETING: string }> {
	constructor(ctx: any, env: any) {
		super(ctx, env)
		if (constructorShouldThrow) throw new Error('constructor blew up')
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname === '/state') {
			return Response.json({ greeting: this.env.GREETING, ticks, mails, waitUntilRan })
		}
		if (url.pathname === '/arm-constructor-throw') {
			constructorShouldThrow = true
			return new Response('armed')
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

	// Deliberately a class *field* rather than a prototype method: the initialiser only
	// exists on a constructed instance, so a resolver that inspects the prototype misses
	// it. workerd accepts this shape, so lopata has to as well.
	email = async (message: any): Promise<void> => {
		mails.push({ from: message.from, to: message.to, greeting: this.env.GREETING })
	}
}
