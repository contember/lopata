// Side-effect counter — observable to the test via `/cancel-count`. Each time
// an `/infinite` source stream is cancelled the counter increments.
let cancelCount = 0

// Highest SSE event the caller has confirmed receiving, via `/sse-ack`. `/sse`
// gates each event on it so incrementality is proven causally rather than by a
// wall-clock threshold — see the comment on the endpoint below.
let sseAck = -1

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)

		// Server-Sent Events, ack-gated: event i+1 is only emitted once the caller
		// has acked event i via `/sse-ack`. That makes incrementality causal — if
		// any hop in worker → main → worker → main → caller buffered the body, the
		// caller could not see event 0, would never ack, and this stalls. Timing
		// thresholds cannot express that: a descheduled caller reads a perfectly
		// streamed response in one burst and looks identical to a buffered one.
		// A stall emits a marker rather than hanging, so the caller fails loudly.
		if (url.pathname === '/sse') {
			const count = Number(url.searchParams.get('count') ?? '5')
			const encoder = new TextEncoder()
			sseAck = -1
			const stream = new ReadableStream<Uint8Array>({
				async start(controller) {
					for (let i = 0; i < count; i++) {
						controller.enqueue(encoder.encode(`data: event-${i}\n\n`))
						if (i === count - 1) break
						const deadline = Date.now() + 5000
						while (sseAck < i && Date.now() < deadline) await new Promise(r => setTimeout(r, 5))
						if (sseAck < i) {
							controller.enqueue(encoder.encode(`data: stalled-waiting-ack-${i}\n\n`))
							break
						}
					}
					controller.close()
				},
			})
			return new Response(stream, {
				headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
			})
		}

		// Caller confirms it has actually received SSE event `n`. Served while the
		// `/sse` stream is still open, so it must not queue behind it.
		if (url.pathname === '/sse-ack') {
			const n = Number(url.searchParams.get('n') ?? '-1')
			if (n > sseAck) sseAck = n
			return new Response(String(sseAck), { headers: { 'content-type': 'text/plain' } })
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

		// Read the request body chunk-by-chunk and echo per-chunk arrival times.
		// Used to prove that request bodies cross the service-binding boundary
		// incrementally instead of buffering at the rpc-fetch hop.
		if (url.pathname === '/echo-incremental' && request.method === 'POST') {
			if (!request.body) return new Response('no body', { status: 400 })
			const reader = request.body.getReader()
			const encoder = new TextEncoder()
			const stream = new ReadableStream<Uint8Array>({
				async start(controller) {
					try {
						let n = 0
						while (true) {
							const { done, value } = await reader.read()
							if (done) break
							if (value?.length) {
								controller.enqueue(encoder.encode(`chunk-${n++}-len-${value.length}-at-${Date.now()}\n`))
							}
						}
						controller.close()
					} catch (e) {
						controller.error(e)
					}
				},
			})
			return new Response(stream, { headers: { 'content-type': 'text/plain' } })
		}

		// Read the full body for round-trip-intact verification on the binding hop.
		if (url.pathname === '/echo' && request.method === 'POST') {
			const body = await request.arrayBuffer()
			return new Response(body)
		}

		return new Response('aux: not found', { status: 404 })
	},
}
