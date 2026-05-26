export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)

		// Server-Sent Events: emit N events spaced out in time, then close. With a
		// buffering bridge this would hang until the stream closed (or forever);
		// with streaming it must arrive incrementally.
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

		// Never-ending stream — used to verify client disconnect propagates a
		// cancel to the worker instead of pumping forever.
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
				},
			})
			return new Response(stream, { headers: { 'content-type': 'text/plain' } })
		}

		// Large body — exercises chunked transfer of a multi-MB payload across the
		// worker boundary (correctness + no truncation).
		if (url.pathname === '/large') {
			const size = Number(url.searchParams.get('size') ?? String(8 * 1024 * 1024))
			// Deterministic, verifiable content: repeating byte pattern.
			const chunk = new Uint8Array(64 * 1024).fill(65) // 'A'
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

		// Echo a (possibly large) request body back — exercises the request-body path.
		if (url.pathname === '/echo' && request.method === 'POST') {
			const body = await request.arrayBuffer()
			return new Response(body)
		}

		// Crash the worker thread mid-request: schedule an uncaught throw and never
		// resolve. The executor's onerror must reject the in-flight request instead
		// of leaving it to hang forever.
		if (url.pathname === '/crash') {
			setTimeout(() => {
				throw new Error('intentional worker crash')
			}, 50)
			return new Promise<Response>(() => {})
		}

		return new Response('not found', { status: 404 })
	},
}
