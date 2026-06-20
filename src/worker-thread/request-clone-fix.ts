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
 * The native `(Request, init)` clone is the only broken construction form. We
 * replace the global `Request` with a subclass that rebuilds that form from the
 * source's URL + body directly (the construction Bun handles correctly), which
 * ALSO preserves incremental streaming (the body is forwarded, not buffered).
 * Every other construction form delegates to the native constructor unchanged.
 */

const Native: typeof Request = globalThis.Request

class LopataRequest extends Native {
	constructor(input: Request | string | URL, init?: RequestInit) {
		// Only special-case `new Request(request, init)` where the source carries a
		// (stream) body and `init` doesn't override it — the form Bun mis-clones.
		const initBody = (init as { body?: unknown } | undefined)?.body
		if (input instanceof Native && input.body != null && initBody == null) {
			const headers = new Headers(input.headers)
			if (init?.headers) for (const [k, v] of new Headers(init.headers)) headers.set(k, v)
			const rest = { ...init } as RequestInit
			delete (rest as { body?: unknown }).body
			delete (rest as { headers?: unknown }).headers
			super(input.url, {
				method: input.method,
				redirect: input.redirect,
				signal: input.signal,
				...rest, // any explicit init overrides win over the inherited defaults
				headers,
				body: input.body,
				// a stream body requires duplex: 'half' (not in the lib's RequestInit type)
				duplex: 'half',
			} as RequestInit)
			return
		}
		// Native path for every other form. Narrow so the call matches an overload.
		if (input instanceof Native) super(input, init)
		else super(input instanceof URL ? input.href : input, init)
	}
}

// Idempotent: only install once, and only over the native constructor.
if ((globalThis.Request as unknown) === (Native as unknown)) {
	globalThis.Request = LopataRequest as unknown as typeof Request
}
