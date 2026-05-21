export class Greeter {
	ctx: any
	env: any

	constructor(ctx: any, env: any) {
		this.ctx = ctx
		this.env = env
	}

	async run(event: any, step: any): Promise<unknown> {
		const greeting = await step.do('greet', async () => {
			return `hello ${event.payload?.name ?? 'world'}`
		})
		const length = await step.do('measure', async () => {
			return greeting.length
		})
		return { greeting, length }
	}
}

export default {
	async fetch(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url)

		if (url.pathname === '/start') {
			const name = url.searchParams.get('name') ?? 'anon'
			const instance = await env.GREETER.create({ params: { name } })
			return new Response(instance.id)
		}

		if (url.pathname.startsWith('/status/')) {
			const id = url.pathname.slice('/status/'.length)
			const instance = await env.GREETER.get(id)
			const status = await instance.status()
			return Response.json(status)
		}

		return new Response('not found', { status: 404 })
	},
}
