// Side-effect counter — observable to the test via `/cancel-count`. Each time
// an `/infinite` source stream is cancelled the counter increments.
let cancelCount = 0

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)

		// Server-Sent Events: emits N events spaced out in time, then closes.
		// With a buffered cross-thread bridge this would arrive in one burst at
		// the end; with streaming it must arrive incrementally.
		if (url.pathname === '/sse') {
			const count = Number(url.searchParams.get('count') ?? '5')
			const delayMs = Number(url.searchParams.get('delay') ?? '30')
			const encoder = new TextEncoder()
			const stream = new ReadableStream<Uint8Array>({
				async start(controller) {
					for (let i = 0; i < count; i++) {
						controller.enqueue(encoder.encode(`data: event-${i}\n\n`))
						await new Promise(r => setTimeout(r, delayMs))
					}
					controller.close()
				},
			})
			return new Response(stream, {
				headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
			})
		}

		// Multi-MB chunked body — exercises chunked transfer + correctness across
		// the worker-to-worker boundary.
		if (url.pathname === '/large') {
			const size = Number(url.searchParams.get('size') ?? String(4 * 1024 * 1024))
			const chunk = new Uint8Array(64 * 1024).fill(67) // 'C'
			let sent = 0
			const stream = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (sent >= size) {
						controller.close()
						return
					}
					const remaining = size - sent
					const out = remaining < chunk.length ? chunk.subarray(0, remaining) : chunk
					controller.enqueue(out)
					sent += out.length
				},
			})
			return new Response(stream, { headers: { 'content-type': 'application/octet-stream' } })
		}

		// Never-ending stream with a `cancel()` callback — the test asserts the
		// callback fires (cancelCount bumps) once the caller drops the body.
		if (url.pathname === '/infinite') {
			const encoder = new TextEncoder()
			let timer: ReturnType<typeof setInterval>
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					let n = 0
					timer = setInterval(() => {
						try {
							controller.enqueue(encoder.encode(`tick-${n++}\n`))
						} catch {
							clearInterval(timer)
						}
					}, 10)
				},
				cancel() {
					clearInterval(timer)
					cancelCount++
				},
			})
			return new Response(stream, { headers: { 'content-type': 'text/plain' } })
		}

		if (url.pathname === '/cancel-count') {
			return new Response(String(cancelCount), { headers: { 'content-type': 'text/plain' } })
		}

		return new Response('aux: not found', { status: 404 })
	},
}
