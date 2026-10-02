import { timingSafeEqual } from 'node:crypto'

export function cryptoError(name: string, message: string): never {
	throw new DOMException(message, name)
}

export function copyBuffer(value: unknown): Uint8Array<ArrayBuffer> {
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
	if (ArrayBuffer.isView(value)) return new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
	throw new TypeError('Expected a BufferSource')
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && timingSafeEqual(a, b)
}

export function decodeBase64Url(value: unknown): Uint8Array<ArrayBuffer> {
	if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
		cryptoError('DataError', 'Invalid base64url key data')
	}
	const bytes = new Uint8Array(Buffer.from(value, 'base64url'))
	if (Buffer.from(bytes).toString('base64url') !== value) cryptoError('DataError', 'Non-canonical base64url key data')
	return bytes
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
	let offset = 0
	for (const part of parts) {
		result.set(part, offset)
		offset += part.length
	}
	return result
}

function der(tag: number, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const length = bytes.length
	const header = length < 128 ? [tag, length] : length < 256 ? [tag, 0x81, length] : [tag, 0x82, length >> 8, length & 255]
	return concat(new Uint8Array(header), bytes)
}

class DerReader {
	private offset = 0
	constructor(private readonly bytes: Uint8Array) {}

	read(tag: number): Uint8Array {
		if (this.bytes[this.offset++] !== tag) cryptoError('DataError', 'Unexpected DER tag')
		const first = this.bytes[this.offset++]
		if (first === undefined) cryptoError('DataError', 'Truncated DER length')
		let length = first
		if (first & 128) {
			const count = first & 127
			if (count === 0 || count > 2 || this.bytes[this.offset] === 0) cryptoError('DataError', 'Invalid DER length')
			length = 0
			for (let i = 0; i < count; i++) {
				const byte = this.bytes[this.offset++]
				if (byte === undefined) cryptoError('DataError', 'Truncated DER length')
				length = length * 256 + byte
			}
			if (length < 128 || (count === 2 && length < 256)) cryptoError('DataError', 'Non-minimal DER length')
		}
		if (length > this.bytes.length - this.offset) cryptoError('DataError', 'Truncated DER value')
		const value = this.bytes.subarray(this.offset, this.offset + length)
		this.offset += length
		return value
	}

	finish(): void {
		if (this.offset !== this.bytes.length) cryptoError('DataError', 'Trailing DER data')
	}
}

export function encodeModernDer(format: 'spki' | 'pkcs8', oid: Uint8Array, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const algorithm = der(0x30, der(0x06, oid))
	if (format === 'spki') return der(0x30, concat(algorithm, der(0x03, concat(new Uint8Array([0]), bytes))))
	return der(0x30, concat(new Uint8Array([2, 1, 0]), algorithm, der(0x04, der(0x80, bytes))))
}

export function decodeModernDer(format: 'spki' | 'pkcs8', oid: Uint8Array, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const outer = new DerReader(bytes)
	const sequence = new DerReader(outer.read(0x30))
	outer.finish()
	if (format === 'pkcs8' && !equalBytes(sequence.read(0x02), new Uint8Array([0]))) cryptoError('DataError', 'Invalid PKCS8 version')
	const algorithm = new DerReader(sequence.read(0x30))
	if (!equalBytes(algorithm.read(0x06), oid)) cryptoError('DataError', 'Key algorithm OID does not match')
	algorithm.finish()
	if (format === 'spki') {
		const publicKey = sequence.read(0x03)
		sequence.finish()
		if (publicKey[0] !== 0) cryptoError('DataError', 'Invalid BIT STRING padding')
		return new Uint8Array(publicKey.subarray(1))
	}
	const privateKey = sequence.read(0x04)
	sequence.finish()
	if (privateKey[0] !== 0x80) cryptoError('NotSupportedError', 'Only seed PKCS8 private keys are supported')
	const inner = new DerReader(privateKey)
	const seed = inner.read(0x80)
	inner.finish()
	return new Uint8Array(seed)
}
