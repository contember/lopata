import { expect, test } from 'bun:test'
import { decodeAwsChunked, isAwsChunked } from '../src/s3/chunked'

function makeStream(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
	const enc = new TextEncoder()
	return new ReadableStream({
		start(controller) {
			for (const c of chunks) {
				controller.enqueue(typeof c === 'string' ? enc.encode(c) : c)
			}
			controller.close()
		},
	})
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader()
	const parts: Uint8Array[] = []
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		parts.push(value)
	}
	const total = parts.reduce((s, p) => s + p.length, 0)
	const merged = new Uint8Array(total)
	let off = 0
	for (const p of parts) {
		merged.set(p, off)
		off += p.length
	}
	return new TextDecoder().decode(merged)
}

test('isAwsChunked detects STREAMING sha256', () => {
	const h = new Headers({ 'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD' })
	expect(isAwsChunked(h)).toBe(true)
})

test('isAwsChunked false for regular sha256 hash', () => {
	const h = new Headers({ 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' })
	expect(isAwsChunked(h)).toBe(false)
})

test('decodeAwsChunked: single chunk', async () => {
	const payload = 'hello world'
	const framed = `${payload.length.toString(16)};chunk-signature=abcd\r\n${payload}\r\n0;chunk-signature=dead\r\n\r\n`
	const out = await collect(decodeAwsChunked(makeStream([framed])))
	expect(out).toBe(payload)
})

test('decodeAwsChunked: multiple chunks', async () => {
	const framed = `5;chunk-signature=aa\r\nhello\r\n6;chunk-signature=bb\r\n world\r\n0;chunk-signature=cc\r\n\r\n`
	const out = await collect(decodeAwsChunked(makeStream([framed])))
	expect(out).toBe('hello world')
})

test('decodeAwsChunked: framing split across stream chunks', async () => {
	// Provide framing byte-by-byte to exercise buffering
	const framed = `5;chunk-signature=aa\r\nhello\r\n0;chunk-signature=bb\r\n\r\n`
	const chunks: string[] = []
	for (const c of framed) chunks.push(c)
	const out = await collect(decodeAwsChunked(makeStream(chunks)))
	expect(out).toBe('hello')
})

test('decodeAwsChunked: data split across stream chunks', async () => {
	// Header arrives fully; data arrives in pieces
	const out = await collect(
		decodeAwsChunked(
			makeStream([
				'b;chunk-signature=aa\r\n',
				'hello ',
				'world\r\n',
				'0;chunk-signature=bb\r\n\r\n',
			]),
		),
	)
	expect(out).toBe('hello world')
})

test('decodeAwsChunked: binary data preserved', async () => {
	const bin = new Uint8Array([0, 1, 2, 3, 255, 128])
	const framed = `${bin.length.toString(16)};chunk-signature=xx\r\n`
	const footer = `\r\n0;chunk-signature=yy\r\n\r\n`
	const enc = new TextEncoder()
	const merged = new Uint8Array(enc.encode(framed).length + bin.length + enc.encode(footer).length)
	let o = 0
	const a = enc.encode(framed)
	merged.set(a, o)
	o += a.length
	merged.set(bin, o)
	o += bin.length
	merged.set(enc.encode(footer), o)
	const stream = makeStream([merged])
	const reader = decodeAwsChunked(stream).getReader()
	const collected: number[] = []
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		collected.push(...value)
	}
	expect(collected).toEqual([...bin])
})

test('decodeAwsChunked: zero-length body terminates cleanly', async () => {
	const out = await collect(decodeAwsChunked(makeStream(['0;chunk-signature=aa\r\n\r\n'])))
	expect(out).toBe('')
})
