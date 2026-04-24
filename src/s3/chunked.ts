/**
 * AWS sigv4 streaming payload decoder.
 *
 * When an S3 client signs with STREAMING-AWS4-HMAC-SHA256-PAYLOAD (the default
 * in aws-sdk-js v3), the request body is wrapped in chunk framing:
 *
 *     <hex-size>;chunk-signature=<hex-sig>\r\n
 *     <data bytes, length = hex-size>\r\n
 *     ...
 *     0;chunk-signature=<hex-sig>\r\n
 *     \r\n
 *
 * This decoder strips the framing and emits only the data bytes. It does NOT
 * verify signatures (lopata's S3 proxy is unauthenticated dev-only).
 */

export function isAwsChunked(headers: Headers): boolean {
	const h = headers.get('x-amz-content-sha256')
	if (!h) return false
	return h === 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD'
		|| h === 'STREAMING-UNSIGNED-PAYLOAD-TRAILER'
		|| h === 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER'
}

/**
 * Decode an aws-chunked ReadableStream into a stream of just the data bytes.
 * Buffers incoming bytes, consumes framing lines, and emits data chunks.
 */
export function decodeAwsChunked(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const reader = stream.getReader()
	let buffer = new Uint8Array(0)
	// expecting 'header' (chunk-size;chunk-signature=...) or 'data'
	type State =
		| { kind: 'header' }
		| { kind: 'data'; remaining: number }
		| { kind: 'crlf-after-data' }
		| { kind: 'done' }
	let state: State = { kind: 'header' }

	function append(chunk: Uint8Array) {
		const merged = new Uint8Array(buffer.length + chunk.length)
		merged.set(buffer, 0)
		merged.set(chunk, buffer.length)
		buffer = merged
	}

	function indexOfCRLF(buf: Uint8Array): number {
		for (let i = 0; i < buf.length - 1; i++) {
			if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return i
		}
		return -1
	}

	return new ReadableStream({
		async pull(controller) {
			while (true) {
				if (state.kind === 'done') {
					controller.close()
					return
				}

				if (state.kind === 'header') {
					const crlf = indexOfCRLF(buffer)
					if (crlf === -1) {
						const { done, value } = await reader.read()
						if (done) {
							// Stream ended without proper termination — that's ok if we're empty.
							controller.close()
							return
						}
						append(value)
						continue
					}
					const line = new TextDecoder().decode(buffer.subarray(0, crlf))
					buffer = buffer.subarray(crlf + 2)
					const sizeHex = line.split(';')[0]!.trim()
					const size = parseInt(sizeHex, 16)
					if (Number.isNaN(size)) {
						controller.error(new Error(`Invalid chunk size: ${line}`))
						return
					}
					if (size === 0) {
						state = { kind: 'done' }
						controller.close()
						return
					}
					state = { kind: 'data', remaining: size }
					continue
				}

				if (state.kind === 'data') {
					if (buffer.length === 0) {
						const { done, value } = await reader.read()
						if (done) {
							controller.error(new Error('Unexpected end of aws-chunked stream inside data'))
							return
						}
						append(value)
						continue
					}
					const take = Math.min(state.remaining, buffer.length)
					controller.enqueue(buffer.subarray(0, take))
					buffer = buffer.subarray(take)
					state = { kind: 'data', remaining: state.remaining - take }
					if (state.remaining === 0) {
						state = { kind: 'crlf-after-data' }
					}
					return
				}

				if (state.kind === 'crlf-after-data') {
					while (buffer.length < 2) {
						const { done, value } = await reader.read()
						if (done) {
							controller.error(new Error('Unexpected end of aws-chunked stream before CRLF'))
							return
						}
						append(value)
					}
					buffer = buffer.subarray(2)
					state = { kind: 'header' }
				}
			}
		},
		cancel(reason) {
			return reader.cancel(reason)
		},
	})
}
