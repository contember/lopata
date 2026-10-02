import { copyBuffer } from './crypto-modern-formats'

interface Parameters {
	name: string
	hash?: unknown
	length?: unknown
	namedCurve?: unknown
	modulusLength?: unknown
	publicExponent?: unknown
	iv?: unknown
	counter?: unknown
	tagLength?: unknown
	saltLength?: unknown
	context?: unknown
	salt?: unknown
	info?: unknown
	iterations?: unknown
	public?: unknown
}

function parameters(value: unknown): Parameters {
	if (typeof value === 'string') return { name: value }
	if (typeof value === 'object' && value !== null && 'name' in value) {
		const name = value.name
		if (typeof name !== 'string') throw new TypeError('Expected an AlgorithmIdentifier')
		return {
			name,
			hash: 'hash' in value ? value.hash : undefined,
			length: 'length' in value ? value.length : undefined,
			namedCurve: 'namedCurve' in value ? value.namedCurve : undefined,
			modulusLength: 'modulusLength' in value ? value.modulusLength : undefined,
			publicExponent: 'publicExponent' in value ? value.publicExponent : undefined,
			iv: 'iv' in value ? value.iv : undefined,
			counter: 'counter' in value ? value.counter : undefined,
			tagLength: 'tagLength' in value ? value.tagLength : undefined,
			saltLength: 'saltLength' in value ? value.saltLength : undefined,
			context: 'context' in value ? value.context : undefined,
			salt: 'salt' in value ? value.salt : undefined,
			info: 'info' in value ? value.info : undefined,
			iterations: 'iterations' in value ? value.iterations : undefined,
			public: 'public' in value ? value.public : undefined,
		}
	}
	throw new TypeError('Expected an AlgorithmIdentifier')
}

const hashes = ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']
const aes = ['AES-CTR', 'AES-CBC', 'AES-GCM', 'AES-KW']
const rsa = ['RSASSA-PKCS1-V1_5', 'RSA-PSS', 'RSA-OAEP']
const ec = ['ECDSA', 'ECDH']
const kem = ['ML-KEM-768', 'ML-KEM-1024']
const dsa = ['ML-DSA-44', 'ML-DSA-65', 'ML-DSA-87']
const asymmetric = [...rsa, ...ec, 'ED25519', 'X25519', ...kem, ...dsa]
const importable = [...asymmetric, ...aes, 'HMAC', 'HKDF', 'PBKDF2']
const operations = [
	'encrypt',
	'decrypt',
	'sign',
	'verify',
	'digest',
	'generateKey',
	'deriveKey',
	'deriveBits',
	'importKey',
	'exportKey',
	'wrapKey',
	'unwrapKey',
	'encapsulateKey',
	'encapsulateBits',
	'decapsulateKey',
	'decapsulateBits',
	'getPublicKey',
]

function hasHash(value: unknown): boolean {
	return hashes.includes(parameters(value).name.toUpperCase())
}

function positive(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 0xffffffff
}

function keyLength(algorithm: Parameters): number | null {
	const name = algorithm.name.toUpperCase()
	if (aes.includes(name)) return typeof algorithm.length === 'number' && [128, 192, 256].includes(algorithm.length) ? algorithm.length : null
	if (name === 'HMAC' && hasHash(algorithm.hash)) {
		if (algorithm.length !== undefined) return positive(algorithm.length) ? algorithm.length : null
		return ['SHA-384', 'SHA-512'].includes(parameters(algorithm.hash).name.toUpperCase()) ? 1024 : 512
	}
	return null
}

function check(operation: string, algorithm: Parameters, length: number | null): boolean {
	const name = algorithm.name.toUpperCase()
	if (operation === 'digest') return hashes.includes(name)
	if (operation === 'getPublicKey') return asymmetric.includes(name)
	if (['encapsulateKey', 'encapsulateBits', 'decapsulateKey', 'decapsulateBits'].includes(operation)) return kem.includes(name)
	if (operation === 'exportKey') return importable.includes(name) && !['HKDF', 'PBKDF2'].includes(name)
	if (operation === 'importKey' || operation === 'generateKey') {
		if (!importable.includes(name) || (operation === 'generateKey' && ['HKDF', 'PBKDF2'].includes(name))) return false
		if (ec.includes(name) && !['P-256', 'P-384', 'P-521'].includes(String(algorithm.namedCurve))) return false
		if ((rsa.includes(name) || name === 'HMAC') && !hasHash(algorithm.hash)) return false
		if (name === 'HMAC' && algorithm.length !== undefined && !positive(algorithm.length)) return false
		if (operation === 'generateKey') {
			if (aes.includes(name) && keyLength(algorithm) === null) return false
			if (rsa.includes(name)) {
				if (!positive(algorithm.modulusLength) || algorithm.modulusLength % 8 !== 0 || algorithm.modulusLength < 512 || algorithm.modulusLength > 16384) {
					return false
				}
				if (!(algorithm.publicExponent instanceof Uint8Array)) return false
				const exponent = copyBuffer(algorithm.publicExponent)
				let e = 0
				for (const byte of exponent) e = e * 256 + byte
				if (e !== 3 && e !== 65537) return false
			}
		}
		return true
	}
	if (['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'].includes(operation)) {
		if (['wrapKey', 'unwrapKey'].includes(operation) && name === 'AES-KW') return true
		if (name === 'RSA-OAEP') return true
		if (name === 'AES-CBC') return copyBuffer(algorithm.iv).length === 16
		if (name === 'AES-GCM') {
			return copyBuffer(algorithm.iv).length > 0
				&& (algorithm.tagLength === undefined || [32, 64, 96, 104, 112, 120, 128].includes(Number(algorithm.tagLength)))
		}
		if (name === 'AES-CTR') return copyBuffer(algorithm.counter).length === 16 && positive(algorithm.length) && algorithm.length <= 128
		return false
	}
	if (operation === 'sign' || operation === 'verify') {
		if (dsa.includes(name)) return algorithm.context === undefined || copyBuffer(algorithm.context).length <= 255
		if (name === 'ECDSA') return hasHash(algorithm.hash)
		if (name === 'RSA-PSS') return typeof algorithm.saltLength === 'number' && Number.isInteger(algorithm.saltLength) && algorithm.saltLength >= 0
		return ['RSASSA-PKCS1-V1_5', 'ED25519', 'HMAC'].includes(name)
	}
	if (operation === 'deriveBits') {
		if (name === 'HKDF' || name === 'PBKDF2') {
			if (!hasHash(algorithm.hash) || length === null || length % 8 !== 0) return false
			copyBuffer(algorithm.salt)
			if (name === 'HKDF') copyBuffer(algorithm.info)
			else if (!positive(algorithm.iterations)) return false
			return true
		}
		if (name === 'ECDH' || name === 'X25519') {
			const key = algorithm.public
			if (!(key instanceof CryptoKey) || key.type !== 'public' || key.algorithm.name.toUpperCase() !== name) return false
			const keyAlgorithm = key.algorithm
			const curve = 'namedCurve' in keyAlgorithm ? keyAlgorithm.namedCurve : undefined
			const maximum = name === 'X25519' || curve === 'P-256' ? 256 : curve === 'P-384' ? 384 : curve === 'P-521' ? 528 : 0
			return maximum > 0 && (length === null || length <= maximum)
		}
	}
	return false
}

/** Workerd's synchronous operation/parameter checks, restricted to algorithms this adapter and Bun implement. */
export function modernCryptoSupports(operation: string, algorithm: unknown, lengthOrAlgorithm?: unknown): boolean {
	if (!operations.includes(operation)) return false
	let length: number | null = null
	if (typeof lengthOrAlgorithm === 'number') {
		if (!Number.isInteger(lengthOrAlgorithm) || lengthOrAlgorithm < 0 || lengthOrAlgorithm > 0xffffffff) {
			throw new TypeError('length must be an unsigned long integer')
		}
		length = lengthOrAlgorithm
	}
	try {
		const normalized = parameters(algorithm)
		if (lengthOrAlgorithm !== undefined && lengthOrAlgorithm !== null && typeof lengthOrAlgorithm !== 'number') {
			const additional = parameters(lengthOrAlgorithm)
			if (['deriveKey', 'unwrapKey', 'encapsulateKey', 'decapsulateKey'].includes(operation) && !check('importKey', additional, null)) return false
			if (operation === 'wrapKey' && !check('exportKey', additional, null)) return false
			if (operation === 'deriveKey') {
				const derivedLength = keyLength(additional)
				return derivedLength !== null && check('deriveBits', normalized, derivedLength)
			}
			if (operation === 'encapsulateKey' || operation === 'decapsulateKey') {
				const name = additional.name.toUpperCase()
				if (![...aes, 'HMAC', 'HKDF', 'PBKDF2'].includes(name)) return false
				if (
					name === 'HMAC' && additional.length !== undefined
					&& !(typeof additional.length === 'number' && additional.length > 248 && additional.length <= 256)
				) return false
			}
		}
		return check(operation, normalized, length)
	} catch {
		return false
	}
}
