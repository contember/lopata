export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname === '/version') {
			return new Response('v1')
		}
		// Paced streamed body — outlives a reload triggered mid-stream.
		if (url.pathname === '/slow-stream') {
			const count = Number(url.searchParams.get('count') ?? '10')
			const delay = Number(url.searchParams.get('delay') ?? '100')
			const enc = new TextEncoder()
			const stream = new ReadableStream<Uint8Array>({
				async start(controller) {
					for (let i = 0; i < count; i++) {
						controller.enqueue(enc.encode(`chunk-${i};`))
						await new Promise(r => setTimeout(r, delay))
					}
					controller.close()
				},
			})
			return new Response(stream, { headers: { 'content-type': 'text/plain' } })
		}
		// Slow handler that hasn't produced its Response yet when the reload lands.
		if (url.pathname === '/slow-body') {
			await new Promise(r => setTimeout(r, Number(url.searchParams.get('ms') ?? '800')))
			return new Response('slow-done-v1')
		}
		return new Response('not found', { status: 404 })
	},
}
