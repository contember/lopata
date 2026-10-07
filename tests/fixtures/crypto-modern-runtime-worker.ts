const enabled = 'encapsulateBits' in crypto.subtle
const supported = typeof SubtleCrypto.supports === 'function'
let pair: CryptoKeyPair | undefined
if (enabled) {
	const generated = await crypto.subtle.generateKey('ML-KEM-768', false, ['encapsulateBits', 'decapsulateBits'])
	if (!('privateKey' in generated)) throw new Error('Expected a key pair')
	pair = generated
}

async function probe(): Promise<Response> {
	if (!pair) {
		let error = ''
		try {
			await crypto.subtle.generateKey('ML-DSA-44', false, ['sign'])
		} catch (cause) {
			error = cause instanceof DOMException || cause instanceof Error ? cause.name : 'UnknownError'
		}
		return Response.json({ enabled, supported, error })
	}
	const encapsulated = await crypto.subtle.encapsulateBits('ML-KEM-768', pair.publicKey)
	const decapsulated = await crypto.subtle.decapsulateBits('ML-KEM-768', pair.privateKey, encapsulated.ciphertext)
	return Response.json({
		enabled,
		supported,
		match: new Uint8Array(decapsulated).every((byte, index) => byte === new Uint8Array(encapsulated.sharedKey)[index]),
		nativeInstance: pair.privateKey instanceof CryptoKey,
	})
}

export default { fetch: probe }

export class CryptoProbe {
	fetch(): Promise<Response> {
		return probe()
	}
}
