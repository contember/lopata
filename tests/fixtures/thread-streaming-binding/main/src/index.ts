// All real work lives in the `aux` worker; main is a thin pass-through that
// proxies the request through the AUX service binding so the test exercises
// the worker-A → main → worker-B → main → worker-A streaming round trip.
//
// Critically for the request-body streaming tests, both the request body and
// the response body flow as streams: the incoming `request.body` is handed
// straight to `env.AUX.fetch`, so chunks pulled by main's pump A → user-worker
// (top-level streaming) are re-pumped over the RPC channel to the aux worker
// without ever buffering.
export default {
	async fetch(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url)
		const auxUrl = `http://aux.internal${url.pathname}${url.search}`
		const init: RequestInit = { method: request.method, headers: request.headers }
		if (request.body) {
			init.body = request.body
			// @ts-expect-error half-duplex marker for forwarding a request body
			init.duplex = 'half'
		}
		const auxRes = await env.AUX.fetch(auxUrl, init)
		// Forward body + headers + status without buffering — passing the stream
		// directly into `new Response` keeps backpressure semantics if the runtime
		// supports them, and at minimum doesn't add a buffering hop.
		return new Response(auxRes.body, {
			status: auxRes.status,
			statusText: auxRes.statusText,
			headers: auxRes.headers,
		})
	},
}
