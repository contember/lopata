export default {
	async fetch(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url)

		if (url.pathname === '/send') {
			const body = url.searchParams.get('body') ?? 'default'
			await env.WORK_QUEUE.send({ body, ts: Date.now() })
			return new Response('queued')
		}

		if (url.pathname === '/receipts') {
			const list = await env.MY_KV.list({ prefix: 'receipt:' })
			return Response.json(list.keys.map((k: any) => k.name))
		}

		return new Response('not found', { status: 404 })
	},

	async queue(batch: any, env: any): Promise<void> {
		for (const message of batch.messages) {
			const key = `receipt:${message.body.body}`
			await env.MY_KV.put(key, JSON.stringify({ id: message.id, attempts: message.attempts }))
			message.ack()
		}
	},
}
