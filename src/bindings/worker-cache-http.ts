import type { ReadableStreamDefaultReader } from 'node:stream/web'

interface BackgroundContext {
	waitUntil(promise: Promise<unknown>): void
}

export function initialCacheAge(headers: Headers, startedAt: number, receivedAt: number): number {
	const date = Date.parse(headers.get('date') ?? '')
	const apparentAge = Number.isFinite(date) ? Math.max(0, receivedAt - date) : 0
	const age = headers.get('age') ?? '0'
	const ageSeconds = /^\d+$/.test(age) ? Number(age) : 0
	const correctedAge = (Number.isFinite(ageSeconds) ? ageSeconds * 1000 : 0) + Math.max(0, receivedAt - startedAt)
	return Math.max(apparentAge, correctedAge)
}

function etagMatches(condition: string, etag: string | null, weak: boolean): boolean {
	return [...condition.matchAll(/\*|(?:W\/)?"[^"]*"/g)].some(match => {
		const candidate = match[0]
		if (candidate === '*') return true
		if (!etag) return false
		return weak
			? candidate.replace(/^W\//, '') === etag.replace(/^W\//, '')
			: !candidate.startsWith('W/') && !etag.startsWith('W/') && candidate === etag
	})
}

function clientCondition(request: Request, response: Response): 304 | 412 | undefined {
	if (response.status < 200 || response.status >= 300) return undefined
	const etag = response.headers.get('etag')
	const modified = Date.parse(response.headers.get('last-modified') ?? '')
	const match = request.headers.get('if-match')
	if (match && !etagMatches(match, etag, false)) return 412
	const unmodified = Date.parse(request.headers.get('if-unmodified-since') ?? '')
	if (!match && Number.isFinite(modified) && Number.isFinite(unmodified) && modified > unmodified) return 412
	const noneMatch = request.headers.get('if-none-match')
	if (noneMatch) return etagMatches(noneMatch, etag, true) ? 304 : undefined
	const since = Date.parse(request.headers.get('if-modified-since') ?? '')
	return Number.isFinite(modified) && Number.isFinite(since) && modified <= since ? 304 : undefined
}

async function consume(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
	const timer = setTimeout(() => {
		reader.cancel().catch(() => {})
	}, 30_000)
	try {
		while (!(await reader.read()).done) {}
	} finally {
		clearTimeout(timer)
		reader.releaseLock()
	}
}

function consumeResponse(response: Response, ctx: BackgroundContext): void {
	if (response.body) ctx.waitUntil(consume(response.body.getReader()))
}

interface ByteRange {
	start: number
	end: number
}

function ranges(header: string, length: number): ByteRange[] {
	if (!header.startsWith('bytes=')) return []
	const result: ByteRange[] = []
	for (const part of header.slice(6).split(',')) {
		const match = /^(\d*)-(\d*)$/.exec(part.trim())
		if (!match || (!match[1] && !match[2])) return []
		let start: number
		let end: number
		if (!match[1]) {
			const suffix = Number(match[2])
			if (!Number.isSafeInteger(suffix) || suffix <= 0) continue
			start = Math.max(0, length - suffix)
			end = length - 1
		} else {
			start = Number(match[1])
			end = match[2] ? Number(match[2]) : length - 1
			if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) continue
			end = Math.min(end, length - 1)
		}
		if (start < length && end >= start) result.push({ start, end })
	}
	return result
}

function ifRangeMatches(condition: string | null, headers: Headers): boolean {
	if (!condition) return true
	if (condition.startsWith('"') || condition.startsWith('W/')) {
		return !condition.startsWith('W/') && condition === headers.get('etag')
	}
	const date = Date.parse(condition)
	const modified = Date.parse(headers.get('last-modified') ?? '')
	return Number.isFinite(date) && Number.isFinite(modified) && modified <= date
}

function sliceStream(body: ReadableStream<Uint8Array>, range: ByteRange, ctx: BackgroundContext): ReadableStream<Uint8Array> {
	const reader = body.getReader()
	let offset = 0
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				while (true) {
					const result = await reader.read()
					if (result.done) {
						controller.close()
						reader.releaseLock()
						return
					}
					const next = offset + result.value.byteLength
					const start = Math.max(0, range.start - offset)
					const end = Math.min(result.value.byteLength, range.end + 1 - offset)
					offset = next
					if (end > start) controller.enqueue(result.value.slice(start, end))
					if (offset > range.end) {
						controller.close()
						ctx.waitUntil(consume(reader))
						return
					}
					if (end > start) return
				}
			} catch (error) {
				controller.error(error)
				reader.releaseLock()
			}
		},
		cancel(reason) {
			return reader.cancel(reason).finally(() => reader.releaseLock())
		},
	})
}

async function boundedBody(response: Response): Promise<Uint8Array> {
	if (!response.body) return new Uint8Array()
	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let size = 0
	let timedOut = false
	const timer = setTimeout(() => {
		timedOut = true
		reader.cancel().catch(() => {})
	}, 30_000)
	try {
		while (true) {
			const result = await reader.read()
			if (timedOut) throw new Error('Range representation did not finish within 30 seconds')
			if (result.done) break
			size += result.value.byteLength
			if (size > 512 * 1024 * 1024) {
				await reader.cancel()
				throw new Error('Range representation exceeds 512 MiB')
			}
			chunks.push(result.value)
		}
		return combine(chunks, size)
	} finally {
		clearTimeout(timer)
		reader.releaseLock()
	}
}

function combine(chunks: Uint8Array[], size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)): Uint8Array {
	const result = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		result.set(chunk, offset)
		offset += chunk.byteLength
	}
	return result
}

export async function clientCacheResponse(response: Response, request: Request, ctx: BackgroundContext): Promise<Response> {
	const condition = clientCondition(request, response)
	if (condition) {
		consumeResponse(response, ctx)
		const headers = new Headers(response.headers)
		headers.delete('content-length')
		return new Response(null, { status: condition, headers })
	}
	if (request.method === 'HEAD') {
		consumeResponse(response, ctx)
		return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers })
	}
	const rangeHeader = request.headers.get('range')
	if (!rangeHeader || response.status !== 200 || !ifRangeMatches(request.headers.get('if-range'), response.headers)) return response
	let body: Uint8Array | undefined
	const contentLength = response.headers.get('content-length')
	let length = contentLength !== null && /^\d+$/.test(contentLength) ? Number(contentLength) : NaN
	if (!Number.isSafeInteger(length) || rangeHeader.includes(',')) {
		body = await boundedBody(response)
		length = body.byteLength
	}
	const selected = ranges(rangeHeader, length)
	const headers = new Headers(response.headers)
	if (!selected.length) {
		if (!body) consumeResponse(response, ctx)
		headers.set('content-range', `bytes */${length}`)
		headers.set('content-length', '0')
		return new Response(null, { status: 416, headers })
	}
	const range = selected[0]
	if (range && selected.length === 1) {
		headers.set('content-range', `bytes ${range.start}-${range.end}/${length}`)
		headers.set('content-length', String(range.end - range.start + 1))
		headers.set('accept-ranges', 'bytes')
		const sliced = body ? body.slice(range.start, range.end + 1) : response.body ? sliceStream(response.body, range, ctx) : null
		return new Response(sliced, { status: 206, headers })
	}
	if (!body) body = await boundedBody(response)
	const boundary = `lopata-${crypto.randomUUID()}`
	const encoder = new TextEncoder()
	const chunks: Uint8Array[] = []
	for (const selection of selected) {
		chunks.push(
			encoder.encode(
				`--${boundary}\r\nContent-Type: ${
					headers.get('content-type') ?? 'application/octet-stream'
				}\r\nContent-Range: bytes ${selection.start}-${selection.end}/${length}\r\n\r\n`,
			),
		)
		chunks.push(body.slice(selection.start, selection.end + 1), encoder.encode('\r\n'))
	}
	chunks.push(encoder.encode(`--${boundary}--\r\n`))
	const multipart = combine(chunks)
	headers.set('content-type', `multipart/byteranges; boundary=${boundary}`)
	headers.set('content-length', String(multipart.byteLength))
	return new Response(multipart, { status: 206, headers })
}
