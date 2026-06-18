// Module-level counter incremented every time the worker's 404-with-streaming-body
// branch sees its source pump fully drain. Exposed via /counter so the test can
// prove the fallback path properly cancelled the body (counter stays 0) instead
// of letting the source pump run to completion (counter would tick).
let drainedCount = 0

export default {
	async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
		const url = new URL(request.url)

		if (url.pathname === '/counter') {
			return new Response(String(drainedCount))
		}

		if (url.pathname === '/hello.txt') {
			// Return a 404 with a slow streaming body — the dev server must
			// CANCEL this body (not drain it) when falling back to assets.
			let cancelled = false
			let interval: ReturnType<typeof setInterval> | null = null
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					let n = 0
					interval = setInterval(() => {
						try {
							controller.enqueue(new TextEncoder().encode(`tick-${n++}\n`))
							if (n >= 50) {
								// Source ran to completion without being cancelled — leak signal.
								controller.close()
								drainedCount++
								if (interval) clearInterval(interval)
							}
						} catch {
							if (interval) clearInterval(interval)
						}
					}, 10)
				},
				cancel() {
					cancelled = true
					if (interval) clearInterval(interval)
				},
			})
			// Hide unused lint noise — `cancelled` is observed via the absence of
			// drainedCount ticks; we don't expose it directly.
			void cancelled
			return new Response(stream, { status: 404, headers: { 'content-type': 'text/plain' } })
		}

		return new Response('worker default', { status: 200 })
	},
}
