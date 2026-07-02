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
 * as its own entry. `Headers.forEach` folds same-name headers into one
 * comma-joined value, which corrupts multiple `Set-Cookie` (the shape every
 * cookie-based auth library produces); `getSetCookie()` gives them back
 * individually, and appending each pair round-trips through
 * `new Response(body, { headers })` on the other side.
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
