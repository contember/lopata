/** Request/Response serialization helpers shared between the worker bridges. */

import type { SerializedRequest, SerializedResponse } from './protocol'

/**
 * Build the headers/method/url shell of a `SerializedRequest`. Body handling
 * is the caller's responsibility — sender code allocates a `streamId` and
 * pumps the body via channel-specific stream messages, or sets `body: null`
 * for body-less requests. (`request.body` is *never* materialised here, which
 * is what allows streaming uploads to cross the worker boundary incrementally.)
 */
export function serializeRequestShell(request: Request): Omit<SerializedRequest, 'body' | 'streamId'> {
	const headers: [string, string][] = []
	request.headers.forEach((v, k) => headers.push([k, v]))
	return { url: request.url, method: request.method, headers }
}

export function deserializeRequest(
	req: SerializedRequest,
	body?: ReadableStream<Uint8Array> | null,
	signal?: AbortSignal,
): Request {
	return new Request(req.url, {
		method: req.method,
		headers: req.headers,
		body: body !== undefined ? body : req.body,
		signal,
	})
}

/**
 * Serialize response headers to a `[k, v][]` array, emitting each `Set-Cookie`
 * as its own entry. The pair list rebuilds losslessly on the other side —
 * `new Response(body, { headers })` appends, so repeated names survive.
 *
 * What corrupts multi-cookie responses is not iteration: `forEach` already
 * yields each `Set-Cookie` separately (the WHATWG "sorted and combined" step
 * special-cases it — only `headers.get()` comma-joins). It is folding headers
 * into a keyed object, where `record[key] = value` keeps just the last cookie
 * and drops the rest — the shape every cookie-based auth library breaks on.
 * Consumers that need a `Record` have to group repeats themselves; see
 * `buildNodeHeaders` in the vite dev-server plugin. Cookies are re-added here
 * via `getSetCookie()` so that guarantee is explicit rather than resting on
 * the iteration special case.
 */
export function serializeResponseHeaders(response: Response): [string, string][] {
	const headers: [string, string][] = []
	response.headers.forEach((v, k) => {
		if (k.toLowerCase() !== 'set-cookie') headers.push([k, v])
	})
	for (const cookie of response.headers.getSetCookie()) headers.push(['set-cookie', cookie])
	return headers
}

export function deserializeResponse(serialized: SerializedResponse): Response {
	return new Response(serialized.body, {
		status: serialized.status,
		statusText: serialized.statusText,
		headers: serialized.headers,
	})
}
