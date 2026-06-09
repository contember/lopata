// Fixture for the thread-mode dashboard workflow-control regression test.
// Both workflows block on something the live worker-side state machine owns
// (an event waiter / a long sleep), so dashboard control ops only work if they
// reach the worker rather than main's hollow binding.

export class Waiter {
	ctx: any
	env: any
	constructor(ctx: any, env: any) {
		this.ctx = ctx
		this.env = env
	}

	async run(_event: any, step: any): Promise<unknown> {
		const ev = await step.waitForEvent('await-go', { type: 'go', timeout: '1 hour' })
		const result = await step.do('finish', async () => {
			return { got: ev.payload }
		})
		return result
	}
}

export class Sleeper {
	ctx: any
	env: any
	constructor(ctx: any, env: any) {
		this.ctx = ctx
		this.env = env
	}

	async run(_event: any, step: any): Promise<unknown> {
		await step.sleep('long-nap', '1 hour')
		return { woke: true }
	}
}

export default {
	async fetch(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url)

		// Direct (in-worker) create so the test can spin up an instance without the
		// dashboard. The dashboard control ops are what's under test.
		if (url.pathname === '/start-waiter') {
			const instance = await env.WAITER.create({ params: {} })
			return new Response(instance.id)
		}
		if (url.pathname === '/start-sleeper') {
			const instance = await env.SLEEPER.create({ params: {} })
			return new Response(instance.id)
		}

		return new Response('ok')
	},
}
