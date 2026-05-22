/** Request/Response serialization helpers shared between the worker bridges. */

import type { SerializedRequest, SerializedResponse } from './protocol'

const warned = new Set<string>()
function warnOnce(key: string, message: string): void {
	if (warned.has(key)) return
	warned.add(key)
	console.warn(message)
}

function isStreamingResponse(response: Response): boolean {
	if (!response.body) return false
	const contentType = response.headers.get('content-type') ?? ''
	if (contentType.startsWith('text/event-stream')) return true
	if (response.headers.get('transfer-encoding') === 'chunked') return true
	return false
}

function isStreamingRequest(request: Request): boolean {
	if (!request.body) return false
	const contentType = request.headers.get('content-type') ?? ''
	if (contentType.startsWith('text/event-stream')) return true
	if (request.headers.get('transfer-encoding') === 'chunked') return true
	return false
}

export async function serializeRequest(request: Request): Promise<SerializedRequest> {
	const headers: [string, string][] = []
	request.headers.forEach((v, k) => headers.push([k, v]))
	if (isStreamingRequest(request)) {
		warnOnce(
			`req:${request.url}`,
			`[lopata] streaming request body for ${request.method} ${request.url} is being fully buffered to cross the worker-thread boundary; client streaming semantics will not be preserved.`,
		)
	}
	const body = request.body ? await request.arrayBuffer() : null
	return { url: request.url, method: request.method, headers, body }
}

export function deserializeRequest(req: SerializedRequest): Request {
	return new Request(req.url, { method: req.method, headers: req.headers, body: req.body })
}

export async function serializeResponse(response: Response): Promise<SerializedResponse> {
	const headers: [string, string][] = []
	response.headers.forEach((v, k) => headers.push([k, v]))
	if (isStreamingResponse(response)) {
		const contentType = response.headers.get('content-type') ?? ''
		const kind = contentType.startsWith('text/event-stream') ? 'SSE' : 'chunked'
		warnOnce(
			`res:${kind}:${contentType || 'unknown'}`,
			`[lopata] streaming response body (${kind}, content-type "${contentType || 'unknown'}") is being fully buffered to cross the worker-thread boundary; streaming semantics will not be preserved.`,
		)
	}
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
