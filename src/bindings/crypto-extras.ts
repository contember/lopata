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

/**
 * DigestStream — a WritableStream that computes a cryptographic hash of all written data.
 * `digest` property is a Promise<ArrayBuffer> that resolves when the stream closes.
 */
export class DigestStream extends WritableStream<ArrayBuffer | ArrayBufferView> {
	readonly digest: Promise<ArrayBuffer>

	constructor(algorithm: string | { name: string }) {
		const algo = typeof algorithm === 'string' ? algorithm : algorithm.name

		// Map CF algorithm names to Bun.CryptoHasher names
		const algoMap: Record<string, string> = {
			'SHA-1': 'sha1',
			'SHA-256': 'sha256',
			'SHA-384': 'sha384',
			'SHA-512': 'sha512',
			'MD5': 'md5',
		}

		const hashName = algoMap[algo.toUpperCase()]
		if (!hashName) {
			throw new TypeError(`Unsupported algorithm: ${algo}`)
		}

		const hasher = new Bun.CryptoHasher(hashName as 'sha1' | 'sha256' | 'sha384' | 'sha512' | 'md5')
		let resolveDigest: (value: ArrayBuffer) => void

		const digestPromise = new Promise<ArrayBuffer>((resolve) => {
			resolveDigest = resolve
		})

		super({
			write(chunk) {
				if (ArrayBuffer.isView(chunk)) {
					hasher.update(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
				} else {
					hasher.update(new Uint8Array(chunk))
				}
			},
			close() {
				const result = hasher.digest()
				resolveDigest(result.buffer as ArrayBuffer)
			},
		})

		this.digest = digestPromise
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
	if (data[offset] & 0x80) {
		offset += 1 + (data[offset] & 0x7f)
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

function toUint8Array(data: BufferSource): Uint8Array {
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

	// Patch importKey to accept PKCS#1 RSA keys with "pkcs8" format (matching workerd behavior).
	// Workerd is lenient and auto-wraps PKCS#1 in PKCS#8; Bun/Node native crypto rejects it.
	const origImportKey = subtle.importKey.bind(subtle)
	subtle.importKey = function(
		format: KeyFormat,
		keyData: BufferSource | JsonWebKey,
		algorithm: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams | HmacImportParams | AesKeyAlgorithm,
		extractable: boolean,
		keyUsages: readonly KeyUsage[],
	): Promise<CryptoKey> {
		if (format === 'pkcs8' && !(keyData as JsonWebKey).kty) {
			const bytes = toUint8Array(keyData as BufferSource)
			if (isPkcs1RsaKey(bytes)) {
				return origImportKey('pkcs8', wrapPkcs1InPkcs8(bytes), algorithm, extractable, keyUsages)
			}
		}
		return origImportKey(format, keyData as BufferSource, algorithm, extractable, keyUsages)
	}
}
