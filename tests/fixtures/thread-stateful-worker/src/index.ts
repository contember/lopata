export default {
	async fetch(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url)

		if (url.pathname === '/queue/send') {
			await env.MY_QUEUE.send({ hello: 'world' })
			return new Response('sent')
		}

		if (url.pathname === '/queue/send-batch') {
			await env.MY_QUEUE.sendBatch([
				{ body: { item: 1 } },
				{ body: { item: 2 } },
			])
			return new Response('batched')
		}

		return new Response('not found', { status: 404 })
	},
}
