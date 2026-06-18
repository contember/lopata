import { DurableObject } from 'cloudflare:workers'

// COMP-1: a DO's `this.env.<WORKFLOW>` must reach the live worker-side state
// machine (DO worker → main → thread router → user worker).
export class WfCaller extends DurableObject {
	async startWorkflow(name: string): Promise<string> {
		const instance = await (this.env as any).GREETER.create({ params: { name } })
		return instance.id
	}

	async workflowStatus(id: string): Promise<unknown> {
		const instance = await (this.env as any).GREETER.get(id)
		return instance.status()
	}
}

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

		if (url.pathname === '/do-start') {
			const name = url.searchParams.get('name') ?? 'anon'
			const stub = env.WF_CALLER.getByName('caller')
			const id = await stub.startWorkflow(name)
			return new Response(id)
		}

		if (url.pathname.startsWith('/do-status/')) {
			const id = url.pathname.slice('/do-status/'.length)
			const stub = env.WF_CALLER.getByName('caller')
			return Response.json(await stub.workflowStatus(id))
		}

		return new Response('not found', { status: 404 })
	},
}
