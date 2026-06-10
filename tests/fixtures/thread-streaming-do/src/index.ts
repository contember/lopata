// All real work lives in the DO; the top-level worker is a thin pass-through
// that proxies the request through `env.STREAM.get(id).fetch(...)` so the test
// exercises the worker → main → DO worker → main → worker streaming round trip.

export class StreamDO {
	state: any
	cancelCount = 0

	constructor(state: any) {
		this.state = state
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)

		// Server-Sent Events: emits N events spaced out in time, then closes.
		// With a buffered DO-fetch hop this would arrive in one burst at the end;
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

		// Multi-MB chunked body — exercises chunked transfer + correctness across
		// the DO-to-main boundary.
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
			const self = this
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
					self.cancelCount++
				},
			})
			return new Response(stream, { headers: { 'content-type': 'text/plain' } })
		}

		if (url.pathname === '/cancel-count') {
			return new Response(String(this.cancelCount), { headers: { 'content-type': 'text/plain' } })
		}

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

		if (url.pathname === '/echo' && request.method === 'POST') {
			const body = await request.arrayBuffer()
			return new Response(body)
		}

		return new Response('do: not found', { status: 404 })
	}
}

export default {
	async fetch(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url)
		// All paths route to the same DO instance so `/cancel-count` reflects the
		// same DO that served `/infinite`. A `?do=<name>` override lets a test target
		// a fresh (cold) DO instance — its worker thread won't exist yet.
		const id = env.STREAM.idFromName(url.searchParams.get('do') ?? 'singleton')
		const stub = env.STREAM.get(id)
		const doUrl = `http://do${url.pathname}${url.search}`
		const init: RequestInit = { method: request.method, headers: request.headers }
		if (request.body) {
			init.body = request.body
			// @ts-expect-error half-duplex marker for streaming request body forward
			init.duplex = 'half'
		}
		const doRes = await stub.fetch(doUrl, init)
		// Forward body + headers + status without buffering.
		return new Response(doRes.body, {
			status: doRes.status,
			statusText: doRes.statusText,
			headers: doRes.headers,
		})
	},
}
