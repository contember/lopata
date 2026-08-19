// Module-level state, read back over fetch: the dashboard trigger and the fetch hit the
// same module instance, so a message observed here proves email() ran.
const received: unknown[] = []

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname === '/received') {
			return Response.json(received)
		}
		return new Response('Not found', { status: 404 })
	},

	async email(message: any): Promise<void> {
		// Reading `raw` back proves the ForwardableEmailMessage was built from the real bytes.
		const raw = await new Response(message.raw).text()
		received.push({
			from: message.from,
			to: message.to,
			subject: message.headers.get('subject'),
			rawSize: message.rawSize,
			body: raw.split('\r\n\r\n')[1] ?? '',
		})
	},
}
