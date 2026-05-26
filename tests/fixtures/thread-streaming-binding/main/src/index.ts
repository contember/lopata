// All real work lives in the `aux` worker; main is a thin pass-through that
// proxies the request through the AUX service binding so the test exercises
// the worker-A → main → worker-B → main → worker-A streaming round trip.
export default {
	async fetch(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url)
		const auxUrl = `http://aux.internal${url.pathname}${url.search}`
		const auxRes = await env.AUX.fetch(auxUrl)
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
