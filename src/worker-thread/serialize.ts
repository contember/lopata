/** Request/Response serialization helpers shared between the worker bridges. */

import type { SerializedRequest, SerializedResponse } from './protocol'

export async function serializeRequest(request: Request): Promise<SerializedRequest> {
	const headers: [string, string][] = []
	request.headers.forEach((v, k) => headers.push([k, v]))
	const body = request.body ? await request.arrayBuffer() : null
	return { url: request.url, method: request.method, headers, body }
}

export function deserializeRequest(req: SerializedRequest): Request {
	return new Request(req.url, { method: req.method, headers: req.headers, body: req.body })
}

export async function serializeResponse(response: Response): Promise<SerializedResponse> {
	const headers: [string, string][] = []
	response.headers.forEach((v, k) => headers.push([k, v]))
	const body = response.body ? await response.arrayBuffer() : null
	return { status: response.status, statusText: response.statusText, headers, body }
}

export function deserializeResponse(serialized: SerializedResponse): Response {
	return new Response(serialized.body, {
		status: serialized.status,
		statusText: serialized.statusText,
		headers: serialized.headers,
	})
}
