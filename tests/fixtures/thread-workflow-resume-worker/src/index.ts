export class SlowFlow {
	ctx: any
	env: any

	constructor(ctx: any, env: any) {
		this.ctx = ctx
		this.env = env
	}

	async run(event: any, step: any): Promise<unknown> {
		return step.do('slow-step', async () => {
			// Record every EXECUTION of the step callback — the step cache row is
			// only written after the callback completes, so a duplicate concurrent
			// run of this instance re-executes it and leaves a second marker.
			await this.env.RUNS.put(`run:${crypto.randomUUID()}`, String(Date.now()))
			await new Promise(r => setTimeout(r, Number(event.payload?.ms ?? 3000)))
			return 'done'
		})
	}
}

export default {
	async fetch(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url)

		if (url.pathname === '/start') {
			const ms = Number(url.searchParams.get('ms') ?? '3000')
			const instance = await env.SLOW_FLOW.create({ params: { ms } })
			return new Response(instance.id)
		}

		if (url.pathname.startsWith('/status/')) {
			const instance = await env.SLOW_FLOW.get(url.pathname.slice('/status/'.length))
			return Response.json(await instance.status())
		}

		if (url.pathname === '/runs') {
			const list = await env.RUNS.list({ prefix: 'run:' })
			return new Response(String(list.keys.length))
		}

		// Long-lived streamed body — pins its generation non-idle (openStreamCount)
		// until the client disconnects, like a real SSE subscription would.
		if (url.pathname === '/sse') {
			const enc = new TextEncoder()
			const stream = new ReadableStream<Uint8Array>({
				async start(controller) {
					try {
						controller.enqueue(enc.encode('open\n'))
						for (let i = 0; i < 300; i++) {
							await new Promise(r => setTimeout(r, 100))
							controller.enqueue(enc.encode('tick\n'))
						}
						controller.close()
					} catch {
						// Client disconnected — cancel propagated.
					}
				},
			})
			return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
		}

		if (url.pathname === '/version') {
			return new Response('v1')
		}

		return new Response('not found', { status: 404 })
	},
}
