import { registerSection } from '../registry'

registerSection({
	slug: 'queue',
	title: 'Queue',
	html: `
  <form onsubmit="api('POST','/queue/send',JSON.parse(formVal('q-body')));return false">
    <label>Message body (JSON) <textarea id="q-body">{"event":"test","ts":0}</textarea></label>
    <button type="submit">Send message</button>
  </form>
  <form onsubmit="api('POST','/queue/send-batch',JSON.parse(formVal('q-batch')));return false">
    <label>Batch (JSON array) <textarea id="q-batch">[{"body":{"n":1}},{"body":{"n":2}},{"body":{"n":3}}]</textarea></label>
    <button type="submit">Send batch</button>
  </form>
  `,
	async handle(request, env) {
		const url = new URL(request.url)
		const path = url.pathname
		const method = request.method

		if (path === '/queue/send' && method === 'POST') {
			const body = await request.json()
			await env.MY_QUEUE.send(body)
			return Response.json({ success: true }, { status: 201 })
		}
		if (path === '/queue/send-batch' && method === 'POST') {
			const messages = (await request.json()) as { body: unknown }[]
			await env.MY_QUEUE.sendBatch(messages)
			return Response.json({ success: true, count: messages.length }, { status: 201 })
		}
		return null
	},
})
