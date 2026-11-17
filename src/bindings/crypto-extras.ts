/**
 * Cloudflare-specific crypto APIs: crypto.subtle.timingSafeEqual and crypto.DigestStream.
 */

import { timingSafeEqual } from 'node:crypto'

/**
 * Constant-time comparison of two buffers.
 * Non-standard extension to Web Crypto matching Cloudflare's API.
 */
export function cfTimingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean {
	const bufA = ArrayBuffer.isView(a) ? Buffer.from(a.buffer, a.byteOffset, a.byteLength) : Buffer.from(a)
	const bufB = ArrayBuffer.isView(b) ? Buffer.from(b.buffer, b.byteOffset, b.byteLength) : Buffer.from(b)

	if (bufA.byteLength !== bufB.byteLength) {
		throw new TypeError('Input buffers must have the same byte length')
	}

	return timingSafeEqual(bufA, bufB)
}

interface Hasher {
	update(bytes: Uint8Array): void
	digest(): ArrayBuffer
}

const NATIVE_DIGESTS: Record<string, 'md5' | 'sha1' | 'sha256' | 'sha384' | 'sha512'> = {
	'md5': 'md5',
	'sha-1': 'sha1',
	'sha-256': 'sha256',
	'sha-384': 'sha384',
	'sha-512': 'sha512',
}

/** A reflected CRC-32 variant with all-ones init and final XOR, written out big-endian as workerd does. */
function crc32Hasher(table: Uint32Array): Hasher {
	let crc = 0xffffffff
	return {
		update(bytes) {
			for (const byte of bytes) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
		},
		digest() {
			const out = new DataView(new ArrayBuffer(4))
			out.setUint32(0, (crc ^ 0xffffffff) >>> 0)
			return out.buffer
		},
	}
}

function crc32Table(poly: number): Uint32Array {
	return Uint32Array.from({ length: 256 }, (_, byte) => {
		let crc = byte
		for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ poly : crc >>> 1
		return crc >>> 0
	})
}

/** CRC-64/NVME (reflected, all-ones init and final XOR), big-endian. */
function crc64Hasher(table: BigUint64Array): Hasher {
	const mask = 0xffffffffffffffffn
	let crc = mask
	return {
		update(bytes) {
			for (const byte of bytes) crc = table[Number((crc ^ BigInt(byte)) & 0xffn)]! ^ (crc >> 8n)
		},
		digest() {
			const out = new DataView(new ArrayBuffer(8))
			out.setBigUint64(0, crc ^ mask)
			return out.buffer
		},
	}
}

function crc64Table(poly: bigint): BigUint64Array {
	return BigUint64Array.from({ length: 256 }, (_, byte) => {
		let crc = BigInt(byte)
		for (let bit = 0; bit < 8; bit++) crc = crc & 1n ? (crc >> 1n) ^ poly : crc >> 1n
		return crc
	})
}

function lazy<T>(create: () => T): () => T {
	let value: T | undefined
	return () => (value ??= create())
}

const crc32IeeeTable = lazy(() => crc32Table(0xedb88320))
const crc32cTable = lazy(() => crc32Table(0x82f63b78))
const crc64NvmeTable = lazy(() => crc64Table(0x9a6c9329ac4bc9b5n))

const CRC_HASHERS: Record<string, () => Hasher> = {
	crc32: () => crc32Hasher(crc32IeeeTable()),
	crc32c: () => crc32Hasher(crc32cTable()),
	crc64nvme: () => crc64Hasher(crc64NvmeTable()),
}

function createHasher(algorithm: string): Hasher {
	const name = algorithm.toLowerCase()
	const native = NATIVE_DIGESTS[name]
	if (native) {
		const hasher = new Bun.CryptoHasher(native)
		return { update: bytes => hasher.update(bytes), digest: () => new Uint8Array(hasher.digest()).buffer }
	}
	const crc = CRC_HASHERS[name]
	if (crc) return crc()
	throw new TypeError(`Unsupported algorithm: ${algorithm}`)
}

function chunkBytes(chunk: unknown): Uint8Array {
	if (typeof chunk === 'string') return new TextEncoder().encode(chunk)
	if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk)
	if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
	throw new TypeError('DigestStream is a byte stream but received an object of non-ArrayBuffer/ArrayBufferView/string type on its writable side.')
}

/**
 * DigestStream — a WritableStream that computes a hash (MD5, SHA-1/256/384/512, CRC32, CRC32C or CRC64/NVME) of all
 * written bytes. `digest` resolves when the stream closes and rejects when it is aborted.
 */
export class DigestStream extends WritableStream<ArrayBuffer | ArrayBufferView | string> {
	readonly digest: Promise<ArrayBuffer>
	private written = 0n
	private disposed = false

	constructor(algorithm: string | { name: string }) {
		const hasher = createHasher(typeof algorithm === 'string' ? algorithm : algorithm.name)
		const digest = Promise.withResolvers<ArrayBuffer>()
		// Nobody has to read the digest of an aborted stream.
		digest.promise.catch(() => {})
		const counted = (bytes: number) => {
			this.written += BigInt(bytes)
		}
		super({
			write(chunk) {
				const bytes = chunkBytes(chunk)
				hasher.update(bytes)
				counted(bytes.byteLength)
			},
			close() {
				digest.resolve(hasher.digest())
			},
			abort(reason) {
				digest.reject(reason)
			},
		})
		this.digest = digest.promise
	}

	get bytesWritten(): bigint {
		return this.written
	}

	[Symbol.dispose](): void {
		if (this.disposed) return
		this.disposed = true
		this.abort(new TypeError('The DigestStream was disposed.')).catch(() => {})
	}
}

/**
 * Detect if DER-encoded key data is PKCS#1 RSAPrivateKey format.
 * PKCS#1: SEQUENCE { INTEGER(version=0), INTEGER(modulus), ... }
 * PKCS#8: SEQUENCE { INTEGER(version=0), SEQUENCE(algorithmId), ... }
 */
function isPkcs1RsaKey(data: Uint8Array): boolean {
	if (data.length < 10 || data[0] !== 0x30) return false
	let offset = 1
	// Skip outer SEQUENCE length
	if (data[offset]! & 0x80) {
		offset += 1 + (data[offset]! & 0x7f)
	} else {
		offset += 1
	}
	// Expect version: INTEGER 0 (02 01 00)
	if (data[offset] !== 0x02 || data[offset + 1] !== 0x01 || data[offset + 2] !== 0x00) return false
	offset += 3
	// PKCS#1 next element is INTEGER (0x02 = modulus)
	// PKCS#8 next element is SEQUENCE (0x30 = algorithmIdentifier)
	return data[offset] === 0x02
}

function derEncodeLength(length: number): Uint8Array {
	if (length < 0x80) return new Uint8Array([length])
	if (length < 0x100) return new Uint8Array([0x81, length])
	return new Uint8Array([0x82, (length >> 8) & 0xff, length & 0xff])
}

function derWrap(tag: number, content: Uint8Array): Uint8Array {
	const len = derEncodeLength(content.length)
	const result = new Uint8Array(1 + len.length + content.length)
	result[0] = tag
	result.set(len, 1)
	result.set(content, 1 + len.length)
	return result
}

/**
 * Wrap a PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo envelope.
 */
function wrapPkcs1InPkcs8(pkcs1Key: Uint8Array): Uint8Array {
	// AlgorithmIdentifier: SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL }
	const rsaAlgorithmId = new Uint8Array([
		0x30,
		0x0d,
		0x06,
		0x09,
		0x2a,
		0x86,
		0x48,
		0x86,
		0xf7,
		0x0d,
		0x01,
		0x01,
		0x01,
		0x05,
		0x00,
	])
	const version = new Uint8Array([0x02, 0x01, 0x00])
	const privateKeyOctetString = derWrap(0x04, pkcs1Key)

	const inner = new Uint8Array(version.length + rsaAlgorithmId.length + privateKeyOctetString.length)
	inner.set(version, 0)
	inner.set(rsaAlgorithmId, version.length)
	inner.set(privateKeyOctetString, version.length + rsaAlgorithmId.length)

	return derWrap(0x30, inner)
}

function toUint8Array(data: ArrayBuffer | ArrayBufferView): Uint8Array {
	if (data instanceof Uint8Array) return data
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
	return new Uint8Array(data)
}

/**
 * Patches the global `crypto` object with CF-specific extensions.
 */
export function patchGlobalCrypto(): void {
	// Add timingSafeEqual to crypto.subtle
	const subtle = crypto.subtle
	Object.defineProperty(subtle, 'timingSafeEqual', {
		value: cfTimingSafeEqual,
		writable: false,
		configurable: true,
	})

	// Add DigestStream to crypto
	Object.defineProperty(crypto, 'DigestStream', {
		value: DigestStream,
		writable: false,
		configurable: true,
	})

	// workerd's digest() also accepts MD5, which Bun's rejects as unrecognized.
	const origDigest = subtle.digest.bind(subtle)
	Object.defineProperty(subtle, 'digest', {
		value(algorithm: string | { name: string }, data: Parameters<typeof origDigest>[1]): Promise<ArrayBuffer> {
			const name = typeof algorithm === 'string' ? algorithm : algorithm.name
			if (name.toLowerCase() !== 'md5') return origDigest(algorithm, data)
			const hasher = createHasher('md5')
			hasher.update(toUint8Array(data))
			return Promise.resolve(hasher.digest())
		},
		writable: true,
		configurable: true,
	})

	// Patch importKey to accept PKCS#1 RSA keys with "pkcs8" format (matching workerd behavior).
	// Workerd is lenient and auto-wraps PKCS#1 in PKCS#8; Bun/Node native crypto rejects it.
	const origImportKey = subtle.importKey.bind(subtle)
	subtle.importKey = ((format: string, keyData: unknown, algorithm: unknown, extractable: boolean, keyUsages: readonly string[]) => {
		if (format === 'pkcs8' && typeof keyData === 'object' && keyData !== null && !('kty' in keyData)) {
			const bytes = toUint8Array(keyData as ArrayBuffer | ArrayBufferView)
			if (isPkcs1RsaKey(bytes)) {
				return (origImportKey as any)('pkcs8', wrapPkcs1InPkcs8(bytes), algorithm, extractable, [...keyUsages])
			}
		}
		return (origImportKey as any)(format, keyData, algorithm, extractable, [...keyUsages])
	}) as typeof subtle.importKey
}
