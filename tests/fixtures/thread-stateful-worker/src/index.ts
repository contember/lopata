import { EmailMessage } from 'cloudflare:email'

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

		if (url.pathname === '/email/send') {
			const raw = 'From: a@example.com\r\nTo: b@example.com\r\nSubject: hi\r\n\r\nhello'
			await env.MY_EMAIL.send(new EmailMessage('a@example.com', 'b@example.com', raw))
			return new Response('emailed')
		}

		return new Response('not found', { status: 404 })
	},
}
