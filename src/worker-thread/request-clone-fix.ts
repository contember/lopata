/**
 * Bun bug workaround, installed as a global in every thread that runs user code.
 *
 * `new Request(existingRequest, init)` HANGS on read in Bun when
 * `existingRequest.body` is a JS `ReadableStream` — which is exactly what every
 * bridged incoming request body is (top-level fetch, DO fetch, binding fetch). So
 * Worker code that re-wraps its incoming request to forward it —
 * `stub.fetch(new Request(request, { headers }))`, the canonical proxy-to-DO /
 * service pattern — would deadlock the downstream `await request.json()`.
 *
 * The native `(Request, init)` clone is the only broken construction form (and
 * only when the source body is a JS `ReadableStream`; string/Blob/ArrayBuffer
 * bodies re-clone fine). We replace the global `Request` with a subclass that
 * rebuilds that form from the source's URL + body directly (the construction Bun
 * handles correctly), which ALSO preserves incremental streaming (the body is
 * forwarded, not buffered). Every other construction form delegates to the native
 * constructor unchanged.
 *
 * TODO: remove once the upstream Bun bug is fixed — delete this file and its two
 * side-effect imports (entry.ts, do-worker-entry.ts); the e2e test
 * `a re-wrapped incoming request body survives the worker → DO hop` guards the
 * removal. Track: https://github.com/oven-sh/bun/issues (clone hang on stream body).
 */

const Native: typeof Request = globalThis.Request

class LopataRequest extends Native {
	constructor(input: Request | string | URL, init?: RequestInit) {
		// Only special-case `new Request(request, init)` where the source carries a
		// (stream) body and `init` does NOT supply its own `body` — the form Bun
		// mis-clones. Test for the `body` KEY's presence, not `init.body == null`: an
		// explicit `{ body: null }` is a deliberate "drop the body" override and must
		// reach the native path so the result is body-less (matching Bun/workerd).
		const overridesBody = init != null && 'body' in init
		if (input instanceof Native && input.body != null && !overridesBody) {
			const headers = new Headers(input.headers)
			if (init?.headers) { for (const [k, v] of new Headers(init.headers)) headers.set(k, v) }
			super(input.url, {
				// Carry the source's settable fields so the rebuilt request matches what
				// a native `(req, init)` clone would have preserved — Bun otherwise resets
				// e.g. `cache` to its default on this reconstructed path.
				method: input.method,
				redirect: input.redirect,
				signal: input.signal,
				cache: input.cache,
				credentials: input.credentials,
				integrity: input.integrity,
				keepalive: input.keepalive,
				referrer: input.referrer,
				referrerPolicy: input.referrerPolicy,
				...init, // explicit init fields win over the inherited defaults above...
				headers, // ...except headers (merged) and body (forwarded), set explicitly
				body: input.body,
				// a stream body requires duplex: 'half' (not in the lib's RequestInit type)
				duplex: 'half',
			} as RequestInit)
			return
		}
		// Native path for every other form (string/URL input, no source body, or an
		// explicit `body` override). Narrow so the call matches a native overload.
		if (input instanceof Native) super(input, init)
		else super(input instanceof URL ? input.href : input, init)
	}
}

// Idempotent: only install once, and only over the native constructor.
if ((globalThis.Request as unknown) === (Native as unknown)) {
	globalThis.Request = LopataRequest as unknown as typeof Request
}
