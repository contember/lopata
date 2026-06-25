// Worker with an `assets.binding` configured. Under assets-first routing the
// dev server serves existing assets before the worker for GET/HEAD, but every
// other method (POST/PUT/DELETE/…) must reach the worker even when the path
// collides with an asset like `/account/` (served from `/account/index.html`).
export default {
	async fetch(request: Request): Promise<Response> {
		// Reachable only if the method gate let the request through to the worker.
		return new Response(`worker-handled ${request.method}`, { status: 201 })
	},
}
