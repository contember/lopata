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

	constructor(algorithm: AlgorithmIdentifier) {
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
}
