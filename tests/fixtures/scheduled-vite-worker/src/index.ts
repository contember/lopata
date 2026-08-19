// Module-level state, read back over fetch: the dashboard trigger and the fetch
// hit the same module instance, so a tick observed here proves scheduled() ran.
let ticks = 0
let lastCron: string | null = null
let waitUntilRan = false

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname === '/ticks') {
			return Response.json({ ticks, lastCron, waitUntilRan })
		}
		return new Response('Not found', { status: 404 })
	},

	async scheduled(controller: { cron: string }, _env: unknown, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
		ticks++
		lastCron = controller.cron
		ctx.waitUntil(
			Promise.resolve().then(() => {
				waitUntilRan = true
			}),
		)
	},
}
