import { ml_dsa44, ml_dsa65, ml_dsa87 } from '@noble/post-quantum/ml-dsa.js'
import { ml_kem1024, ml_kem768 } from '@noble/post-quantum/ml-kem.js'
import { createPublicKey, KeyObject } from 'node:crypto'
import { cfTimingSafeEqual } from './crypto-extras'
import { copyBuffer, cryptoError, decodeBase64Url, decodeModernDer, encodeModernDer, equalBytes } from './crypto-modern-formats'
import { modernCryptoSupports } from './crypto-modern-supports'
import type {
	AesCbcParams,
	AesCtrParams,
	AesDerivedKeyParams,
	AesGcmParams,
	AesKeyGenParams,
	AlgorithmIdentifier,
	BufferSource,
	EcdhKeyDeriveParams,
	EcdsaParams,
	EcKeyGenParams,
	EcKeyImportParams,
	HkdfParams,
	HmacImportParams,
	HmacKeyGenParams,
	JsonWebKey,
	KeyAlgorithm,
	KeyFormat,
	KeyType,
	KeyUsage,
	NativeSubtleCrypto,
	Pbkdf2Params,
	RsaHashedImportParams,
	RsaHashedKeyGenParams,
	RsaOaepParams,
	RsaPssParams,
} from './crypto-modern-types'

export type ModernAlgorithmName = 'ML-KEM-768' | 'ML-KEM-1024' | 'ML-DSA-44' | 'ML-DSA-65' | 'ML-DSA-87'
export type ModernKeyUsage = KeyUsage | 'encapsulateKey' | 'encapsulateBits' | 'decapsulateKey' | 'decapsulateBits'
export type ModernKeyFormat = KeyFormat | 'raw-public' | 'raw-seed' | 'raw-private' | 'raw-secret'
export interface ModernJsonWebKey extends JsonWebKey {
	pub?: string
	priv?: string
}
export interface ModernCryptoKey extends Omit<CryptoKey, 'usages'> {
	readonly usages: ModernKeyUsage[]
}
export interface ModernCryptoKeyPair {
	publicKey: ModernCryptoKey
	privateKey: ModernCryptoKey
}
type Key = CryptoKey | ModernCryptoKey
type ImportAlgorithm = AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams | HmacImportParams
type GenerateAlgorithm = AlgorithmIdentifier | RsaHashedKeyGenParams | EcKeyGenParams | HmacKeyGenParams | AesKeyGenParams
type SignAlgorithm = AlgorithmIdentifier | RsaPssParams | EcdsaParams | { name: string; context?: BufferSource }
export interface EncapsulatedBits {
	sharedKey: ArrayBuffer
	ciphertext: ArrayBuffer
}
export interface EncapsulatedKey {
	sharedKey: CryptoKey
	ciphertext: ArrayBuffer
}
export interface ModernSubtleCrypto
	extends Omit<SubtleCrypto, 'generateKey' | 'importKey' | 'exportKey' | 'sign' | 'verify' | 'wrapKey' | 'unwrapKey'>
{
	generateKey(
		algorithm: ModernAlgorithmName | { name: ModernAlgorithmName },
		extractable: boolean,
		usages: ModernKeyUsage[],
	): Promise<ModernCryptoKeyPair>
	generateKey(algorithm: GenerateAlgorithm, extractable: boolean, usages: ModernKeyUsage[]): Promise<CryptoKey | CryptoKeyPair | ModernCryptoKeyPair>
	importKey(
		format: ModernKeyFormat,
		data: BufferSource | ModernJsonWebKey,
		algorithm: ImportAlgorithm,
		extractable: boolean,
		usages: ModernKeyUsage[],
	): Promise<Key>
	exportKey(format: 'jwk', key: Key): Promise<ModernJsonWebKey>
	exportKey(format: Exclude<ModernKeyFormat, 'jwk'>, key: Key): Promise<ArrayBuffer>
	sign(algorithm: SignAlgorithm, key: Key, data: BufferSource): Promise<ArrayBuffer>
	verify(algorithm: SignAlgorithm, key: Key, signature: BufferSource, data: BufferSource): Promise<boolean>
	wrapKey(format: ModernKeyFormat, key: Key, wrappingKey: Key, algorithm: AlgorithmIdentifier): Promise<ArrayBuffer>
	unwrapKey(
		format: ModernKeyFormat,
		data: BufferSource,
		unwrappingKey: Key,
		algorithm: AlgorithmIdentifier,
		unwrappedAlgorithm: ImportAlgorithm,
		extractable: boolean,
		usages: ModernKeyUsage[],
	): Promise<Key>
	encapsulateBits(algorithm: AlgorithmIdentifier, key: Key): Promise<EncapsulatedBits>
	decapsulateBits(algorithm: AlgorithmIdentifier, key: Key, ciphertext: BufferSource): Promise<ArrayBuffer>
	encapsulateKey(
		algorithm: AlgorithmIdentifier,
		key: Key,
		sharedAlgorithm: ImportAlgorithm,
		extractable: boolean,
		usages: KeyUsage[],
	): Promise<EncapsulatedKey>
	decapsulateKey(
		algorithm: AlgorithmIdentifier,
		key: Key,
		ciphertext: BufferSource,
		sharedAlgorithm: ImportAlgorithm,
		extractable: boolean,
		usages: KeyUsage[],
	): Promise<CryptoKey>
	getPublicKey(key: Key, usages: ModernKeyUsage[]): Promise<Key>
}

interface ModernAlgorithm {
	name: ModernAlgorithmName
	family: 'kem' | 'dsa'
	seedLength: number
	publicLength: number
	oid: Uint8Array
	keygen(seed: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array }
}
function oid(category: number, variant: number): Uint8Array {
	return new Uint8Array([0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, category, variant])
}
const algorithms: ModernAlgorithm[] = [
	{ name: 'ML-KEM-768', family: 'kem', seedLength: 64, publicLength: 1184, oid: oid(4, 2), keygen: ml_kem768.keygen },
	{ name: 'ML-KEM-1024', family: 'kem', seedLength: 64, publicLength: 1568, oid: oid(4, 3), keygen: ml_kem1024.keygen },
	{ name: 'ML-DSA-44', family: 'dsa', seedLength: 32, publicLength: 1312, oid: oid(3, 17), keygen: ml_dsa44.keygen },
	{ name: 'ML-DSA-65', family: 'dsa', seedLength: 32, publicLength: 1952, oid: oid(3, 18), keygen: ml_dsa65.keygen },
	{ name: 'ML-DSA-87', family: 'dsa', seedLength: 32, publicLength: 2592, oid: oid(3, 19), keygen: ml_dsa87.keygen },
]

interface KeyState {
	algorithm: ModernAlgorithm
	type: 'public' | 'private'
	extractable: boolean
	usages: ModernKeyUsage[]
	publicBytes: Uint8Array
	seed?: Uint8Array
	secretBytes?: Uint8Array
}
const keyStates = new WeakMap<object, KeyState>()
const getKeyState = keyStates.get.bind(keyStates)
const setKeyState = keyStates.set.bind(keyStates)
const hasKeyState = keyStates.has.bind(keyStates)
const keyConstructionToken = Symbol('CryptoKey')

class PostQuantumCryptoKey implements ModernCryptoKey {
	constructor(token: symbol, state: KeyState) {
		if (token !== keyConstructionToken) throw new TypeError('Illegal constructor')
		setKeyState(this, state)
		Object.freeze(this)
	}
	get type(): KeyType {
		return stateOf(this).type
	}
	get algorithm(): KeyAlgorithm {
		return { name: stateOf(this).algorithm.name }
	}
	get extractable(): boolean {
		return stateOf(this).extractable
	}
	get usages(): ModernKeyUsage[] {
		return [...stateOf(this).usages]
	}
}
// Keep the native prototype and instanceof contract without exposing a synthetic native key handle.
Object.setPrototypeOf(PostQuantumCryptoKey.prototype, CryptoKey.prototype)
Object.defineProperty(PostQuantumCryptoKey, 'name', { value: 'CryptoKey' })

function createKey(state: KeyState): ModernCryptoKey {
	return new PostQuantumCryptoKey(keyConstructionToken, state)
}

function stateOf(key: object): KeyState {
	const state = getKeyState(key)
	if (!state) throw new TypeError('Expected a CryptoKey')
	return state
}
function nativeKey(key: Key): CryptoKey {
	if (hasKeyState(key)) cryptoError('InvalidAccessError', 'Post-quantum key cannot be used with this operation')
	if (!(key instanceof CryptoKey)) throw new TypeError('Expected a CryptoKey')
	return key
}
function nativeUsages(usages: ModernKeyUsage[]): KeyUsage[] {
	const result: KeyUsage[] = []
	for (const usage of usages) {
		switch (usage) {
			case 'encrypt':
			case 'decrypt':
			case 'sign':
			case 'verify':
			case 'deriveKey':
			case 'deriveBits':
			case 'wrapKey':
			case 'unwrapKey':
				result.push(usage)
				break
			default:
				cryptoError('SyntaxError', 'Unsupported key usage')
		}
	}
	return result
}
function isNativeFormat(format: ModernKeyFormat): format is KeyFormat {
	return format === 'raw' || format === 'jwk' || format === 'spki' || format === 'pkcs8'
}
function nameOf(algorithm: AlgorithmIdentifier): string {
	return (typeof algorithm === 'string' ? algorithm : algorithm.name).toUpperCase()
}
function findAlgorithm(algorithm: AlgorithmIdentifier): ModernAlgorithm | undefined {
	return algorithms.find(candidate => candidate.name === nameOf(algorithm))
}
function rejectUnsupportedModernAlgorithm(algorithm: AlgorithmIdentifier): void {
	const name = nameOf(algorithm)
	if (name.startsWith('ML-KEM-') || name.startsWith('ML-DSA-')) cryptoError('NotSupportedError', 'Unsupported post-quantum algorithm')
}
function allowedUsages(algorithm: ModernAlgorithm, type: 'public' | 'private'): ModernKeyUsage[] {
	if (algorithm.family === 'dsa') return type === 'public' ? ['verify'] : ['sign']
	return type === 'public' ? ['encapsulateKey', 'encapsulateBits'] : ['decapsulateKey', 'decapsulateBits']
}
function validateUsages(usages: ModernKeyUsage[], allowed: ModernKeyUsage[], requireNonempty = false): ModernKeyUsage[] {
	if (usages.some(usage => !allowed.includes(usage))) cryptoError('SyntaxError', 'Unsupported key usage')
	const normalized = allowed.filter(usage => usages.includes(usage))
	if (requireNonempty && normalized.length === 0) cryptoError('SyntaxError', 'Private key usages must not be empty')
	return normalized
}
function privateState(algorithm: ModernAlgorithm, seed: Uint8Array, extractable: boolean, usages: ModernKeyUsage[]): KeyState {
	if (seed.length !== algorithm.seedLength) cryptoError('DataError', 'Invalid private seed length')
	const { publicKey, secretKey } = algorithm.keygen(seed)
	return { algorithm, seed, publicBytes: publicKey, secretBytes: secretKey, extractable, usages, type: 'private' }
}
function publicState(algorithm: ModernAlgorithm, bytes: Uint8Array, extractable: boolean, usages: ModernKeyUsage[]): KeyState {
	if (bytes.length !== algorithm.publicLength) cryptoError('DataError', 'Invalid public key length')
	if (algorithm.family === 'kem') {
		try {
			const prepared = (algorithm.name === 'ML-KEM-768' ? ml_kem768 : ml_kem1024).prepare(bytes)
			prepared.clean()
		} catch {
			cryptoError('DataError', 'Invalid ML-KEM public key')
		}
	}
	return { algorithm, publicBytes: bytes, extractable, usages, type: 'public' }
}
function validateOperation(algorithm: AlgorithmIdentifier, key: Key, usage: ModernKeyUsage, family: 'kem' | 'dsa'): KeyState {
	const normalized = findAlgorithm(algorithm)
	if (!normalized || normalized.family !== family) cryptoError('NotSupportedError', 'Unsupported algorithm for operation')
	const state = getKeyState(key)
	if (!state || state.algorithm.name !== normalized.name || !state.usages.includes(usage)) {
		cryptoError('InvalidAccessError', 'Key algorithm or usage does not match operation')
	}
	return state
}
function contextOf(algorithm: SignAlgorithm): Uint8Array<ArrayBuffer> {
	const context = typeof algorithm !== 'string' && 'context' in algorithm && algorithm.context !== undefined
		? copyBuffer(algorithm.context)
		: new Uint8Array()
	if (context.length > 255) cryptoError('OperationError', 'ML-DSA context must be at most 255 bytes')
	return context
}
function signer(name: ModernAlgorithmName) {
	return name === 'ML-DSA-44' ? ml_dsa44 : name === 'ML-DSA-65' ? ml_dsa65 : ml_dsa87
}

class ModernCryptoAdapter implements ModernSubtleCrypto {
	constructor(private readonly native: NativeSubtleCrypto) {}

	generateKey(
		algorithm: ModernAlgorithmName | { name: ModernAlgorithmName },
		extractable: boolean,
		usages: ModernKeyUsage[],
	): Promise<ModernCryptoKeyPair>
	generateKey(algorithm: GenerateAlgorithm, extractable: boolean, usages: ModernKeyUsage[]): Promise<CryptoKey | CryptoKeyPair | ModernCryptoKeyPair>
	async generateKey(
		algorithm: GenerateAlgorithm,
		extractable: boolean,
		usages: ModernKeyUsage[],
	): Promise<CryptoKey | CryptoKeyPair | ModernCryptoKeyPair> {
		const modern = findAlgorithm(algorithm)
		if (!modern) {
			rejectUnsupportedModernAlgorithm(algorithm)
			return this.native.generateKey(algorithm, extractable, nativeUsages(usages))
		}
		const publicAllowed = allowedUsages(modern, 'public')
		const privateAllowed = allowedUsages(modern, 'private')
		validateUsages(usages, [...publicAllowed, ...privateAllowed])
		const privateUsages = validateUsages(usages.filter(usage => privateAllowed.includes(usage)), privateAllowed, true)
		const state = privateState(modern, crypto.getRandomValues(new Uint8Array(modern.seedLength)), extractable, privateUsages)
		return {
			privateKey: createKey(state),
			publicKey: createKey({
				algorithm: modern,
				type: 'public',
				extractable: true,
				usages: validateUsages(usages.filter(usage => publicAllowed.includes(usage)), publicAllowed),
				publicBytes: state.publicBytes,
			}),
		}
	}

	async importKey(
		format: ModernKeyFormat,
		data: BufferSource | ModernJsonWebKey,
		algorithm: ImportAlgorithm,
		extractable: boolean,
		usages: ModernKeyUsage[],
	): Promise<Key> {
		const modern = findAlgorithm(algorithm)
		if (!modern) {
			rejectUnsupportedModernAlgorithm(algorithm)
			const name = nameOf(algorithm)
			if (format === 'raw-public' && !['ECDSA', 'ECDH', 'ED25519', 'X25519', 'RSA-PSS', 'RSA-OAEP', 'RSASSA-PKCS1-V1_5'].includes(name)) {
				cryptoError('NotSupportedError', 'raw-public requires an asymmetric algorithm')
			}
			if (format === 'raw-secret' && !['AES-CTR', 'AES-CBC', 'AES-GCM', 'AES-KW', 'HMAC', 'HKDF', 'PBKDF2'].includes(name)) {
				cryptoError('NotSupportedError', 'raw-secret requires a symmetric algorithm')
			}
			const nativeFormat = format === 'raw-public' || format === 'raw-secret' ? 'raw' : format
			if (nativeFormat === 'raw-seed' || nativeFormat === 'raw-private') cryptoError('NotSupportedError', 'Unsupported key format')
			if (nativeFormat === 'jwk') {
				if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) throw new TypeError('JWK must be an object')
				return this.native.importKey('jwk', data, algorithm, extractable, nativeUsages(usages))
			}
			return this.native.importKey(nativeFormat, copyBuffer(data), algorithm, extractable, nativeUsages(usages))
		}
		if (format === 'jwk') return this.importJwk(parseModernJwk(data), modern, extractable, usages)
		if (!['raw-public', 'raw-seed', 'spki', 'pkcs8'].includes(format)) cryptoError('NotSupportedError', 'Unsupported post-quantum key format')
		const type = format === 'raw-public' || format === 'spki' ? 'public' : 'private'
		const normalized = validateUsages(usages, allowedUsages(modern, type), type === 'private')
		const bytes = copyBuffer(data)
		const raw = format === 'spki' || format === 'pkcs8' ? decodeModernDer(format, modern.oid, bytes) : bytes
		return createKey(
			type === 'public' ? publicState(modern, raw, extractable, normalized) : privateState(modern, raw, extractable, normalized),
		)
	}

	private importJwk(data: ModernJsonWebKey, algorithm: ModernAlgorithm, extractable: boolean, usages: ModernKeyUsage[]): Key {
		const type = data.priv === undefined ? 'public' : 'private'
		const normalized = validateUsages(usages, allowedUsages(algorithm, type), type === 'private')
		if (data.kty !== 'AKP' || data.alg !== algorithm.name) cryptoError('DataError', 'JWK key type or algorithm does not match')
		if (usages.length && data.use !== undefined && data.use !== (algorithm.family === 'kem' ? 'enc' : 'sig')) {
			cryptoError('DataError', 'Invalid JWK use')
		}
		if (data.ext === false && extractable) cryptoError('DataError', 'JWK is not extractable')
		if (data.key_ops !== undefined) {
			if (new Set(data.key_ops).size !== data.key_ops.length || usages.some(usage => !data.key_ops?.includes(usage))) {
				cryptoError('DataError', 'Invalid JWK key_ops')
			}
		}
		if (type === 'public') return createKey(publicState(algorithm, decodeBase64Url(data.pub), extractable, normalized))
		const state = privateState(algorithm, decodeBase64Url(data.priv), extractable, normalized)
		if (data.pub === undefined && algorithm.family === 'kem') cryptoError('DataError', 'ML-KEM private JWK requires pub')
		if (data.pub !== undefined && !equalBytes(decodeBase64Url(data.pub), state.publicBytes)) {
			cryptoError('DataError', 'JWK public key does not match private seed')
		}
		return createKey(state)
	}

	exportKey(format: 'jwk', key: Key): Promise<ModernJsonWebKey>
	exportKey(format: Exclude<ModernKeyFormat, 'jwk'>, key: Key): Promise<ArrayBuffer>
	async exportKey(format: ModernKeyFormat, key: Key): Promise<ModernJsonWebKey | ArrayBuffer> {
		const state = getKeyState(key)
		if (!state) {
			const keyType = nativeKey(key).type
			if (format === 'raw-public' && keyType !== 'public') cryptoError('InvalidAccessError', 'raw-public requires a public key')
			if (format === 'raw-secret' && keyType !== 'secret') cryptoError('InvalidAccessError', 'raw-secret requires a secret key')
			const nativeFormat = format === 'raw-public' || format === 'raw-secret' ? 'raw' : format
			if (nativeFormat === 'raw-seed' || nativeFormat === 'raw-private') cryptoError('NotSupportedError', 'Unsupported key format')
			return nativeFormat === 'jwk' ? this.native.exportKey('jwk', nativeKey(key)) : this.native.exportKey(nativeFormat, nativeKey(key))
		}
		if (!state.extractable) cryptoError('InvalidAccessError', 'Key is not extractable')
		if (format === 'jwk') {
			const jwk: ModernJsonWebKey = {
				kty: 'AKP',
				alg: state.algorithm.name,
				ext: state.extractable,
				key_ops: [...state.usages],
				pub: Buffer.from(state.publicBytes).toString('base64url'),
			}
			if (state.seed) jwk.priv = Buffer.from(state.seed).toString('base64url')
			return jwk
		}
		if (!['raw-public', 'raw-seed', 'spki', 'pkcs8'].includes(format)) cryptoError('NotSupportedError', 'Unsupported post-quantum key format')
		const publicFormat = format === 'raw-public' || format === 'spki'
		if (publicFormat !== (state.type === 'public')) cryptoError('InvalidAccessError', 'Key type does not match export format')
		const bytes = publicFormat ? state.publicBytes : state.seed
		if (!bytes) cryptoError('InvalidAccessError', 'Private key seed is unavailable')
		return (format === 'spki' || format === 'pkcs8' ? encodeModernDer(format, state.algorithm.oid, bytes) : new Uint8Array(bytes)).buffer
	}

	async sign(algorithm: SignAlgorithm, key: Key, data: BufferSource): Promise<ArrayBuffer> {
		if (!findAlgorithm(algorithm)) {
			rejectUnsupportedModernAlgorithm(algorithm)
			return this.native.sign(algorithm, nativeKey(key), data)
		}
		const state = validateOperation(algorithm, key, 'sign', 'dsa')
		const context = contextOf(algorithm)
		const bytes = copyBuffer(data)
		if (state.type !== 'private' || !state.secretBytes) cryptoError('InvalidAccessError', 'Signing requires a private key')
		try {
			return new Uint8Array(signer(state.algorithm.name).sign(bytes, state.secretBytes, { context })).buffer
		} catch {
			cryptoError('OperationError', 'ML-DSA signing failed')
		}
	}
	async verify(algorithm: SignAlgorithm, key: Key, signature: BufferSource, data: BufferSource): Promise<boolean> {
		if (!findAlgorithm(algorithm)) {
			rejectUnsupportedModernAlgorithm(algorithm)
			return this.native.verify(algorithm, nativeKey(key), signature, data)
		}
		const state = validateOperation(algorithm, key, 'verify', 'dsa')
		const context = contextOf(algorithm)
		if (state.type !== 'public') cryptoError('InvalidAccessError', 'Verification requires a public key')
		return signer(state.algorithm.name).verify(copyBuffer(signature), copyBuffer(data), state.publicBytes, { context })
	}

	private encapsulate(algorithm: AlgorithmIdentifier, key: Key, usage: 'encapsulateKey' | 'encapsulateBits'): EncapsulatedBits {
		const state = validateOperation(algorithm, key, usage, 'kem')
		if (state.type !== 'public') cryptoError('InvalidAccessError', 'Encapsulation requires a public key')
		try {
			const { cipherText, sharedSecret } = (state.algorithm.name === 'ML-KEM-768' ? ml_kem768 : ml_kem1024).encapsulate(state.publicBytes)
			return { sharedKey: new Uint8Array(sharedSecret).buffer, ciphertext: new Uint8Array(cipherText).buffer }
		} catch {
			cryptoError('OperationError', 'ML-KEM encapsulation failed')
		}
	}
	private decapsulate(algorithm: AlgorithmIdentifier, key: Key, ciphertext: BufferSource, usage: 'decapsulateKey' | 'decapsulateBits'): ArrayBuffer {
		const state = validateOperation(algorithm, key, usage, 'kem')
		if (state.type !== 'private' || !state.secretBytes) cryptoError('InvalidAccessError', 'Decapsulation requires a private key')
		const bytes = copyBuffer(ciphertext)
		try {
			return new Uint8Array((state.algorithm.name === 'ML-KEM-768' ? ml_kem768 : ml_kem1024).decapsulate(bytes, state.secretBytes)).buffer
		} catch {
			cryptoError('OperationError', 'ML-KEM decapsulation failed')
		}
	}
	async encapsulateBits(algorithm: AlgorithmIdentifier, key: Key): Promise<EncapsulatedBits> {
		return this.encapsulate(algorithm, key, 'encapsulateBits')
	}
	async decapsulateBits(algorithm: AlgorithmIdentifier, key: Key, ciphertext: BufferSource): Promise<ArrayBuffer> {
		return this.decapsulate(algorithm, key, ciphertext, 'decapsulateBits')
	}
	async encapsulateKey(
		algorithm: AlgorithmIdentifier,
		key: Key,
		sharedAlgorithm: ImportAlgorithm,
		extractable: boolean,
		usages: KeyUsage[],
	): Promise<EncapsulatedKey> {
		const bits = this.encapsulate(algorithm, key, 'encapsulateKey')
		return {
			sharedKey: nativeKey(await this.importKey('raw-secret', bits.sharedKey, sharedAlgorithm, extractable, usages)),
			ciphertext: bits.ciphertext,
		}
	}
	async decapsulateKey(
		algorithm: AlgorithmIdentifier,
		key: Key,
		ciphertext: BufferSource,
		sharedAlgorithm: ImportAlgorithm,
		extractable: boolean,
		usages: KeyUsage[],
	): Promise<CryptoKey> {
		return nativeKey(
			await this.importKey('raw-secret', this.decapsulate(algorithm, key, ciphertext, 'decapsulateKey'), sharedAlgorithm, extractable, usages),
		)
	}
	async getPublicKey(key: Key, usages: ModernKeyUsage[]): Promise<Key> {
		const state = getKeyState(key)
		if (state) {
			if (state.type !== 'private') cryptoError('InvalidAccessError', 'getPublicKey requires a private key')
			return createKey({
				algorithm: state.algorithm,
				type: 'public',
				extractable: true,
				usages: validateUsages(usages, allowedUsages(state.algorithm, 'public')),
				publicBytes: state.publicBytes,
			})
		}
		const native = nativeKey(key)
		if (native.type === 'secret') cryptoError('NotSupportedError', 'getPublicKey is not supported for symmetric keys')
		if (native.type !== 'private') cryptoError('InvalidAccessError', 'getPublicKey requires a private key')
		const name = native.algorithm.name
		const allowed: ModernKeyUsage[] = name === 'RSA-OAEP'
			? ['encrypt', 'wrapKey']
			: ['ECDH', 'X25519'].includes(name)
			? []
			: ['ECDSA', 'Ed25519', 'RSA-PSS', 'RSASSA-PKCS1-v1_5'].includes(name)
			? ['verify']
			: cryptoError('NotSupportedError', 'Unsupported public key derivation')
		validateUsages(usages, allowed)
		const publicKey = createPublicKey(KeyObject.from(native))
		return this.native.importKey(
			'spki',
			new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })),
			native.algorithm,
			true,
			nativeUsages(usages),
		)
	}

	async wrapKey(format: ModernKeyFormat, key: Key, wrappingKey: Key, algorithm: AlgorithmIdentifier): Promise<ArrayBuffer> {
		if (!hasKeyState(key) && isNativeFormat(format)) return this.native.wrapKey(format, nativeKey(key), nativeKey(wrappingKey), algorithm)
		const exported = format === 'jwk' ? new TextEncoder().encode(JSON.stringify(await this.exportKey(format, key))) : await this.exportKey(format, key)
		const transportKey = await this.native.importKey('raw', exported, { name: 'HMAC', hash: 'SHA-256' }, true, ['sign'])
		return this.native.wrapKey('raw', transportKey, nativeKey(wrappingKey), algorithm)
	}
	async unwrapKey(
		format: ModernKeyFormat,
		data: BufferSource,
		unwrappingKey: Key,
		algorithm: AlgorithmIdentifier,
		unwrappedAlgorithm: ImportAlgorithm,
		extractable: boolean,
		usages: ModernKeyUsage[],
	): Promise<Key> {
		const modern = findAlgorithm(unwrappedAlgorithm)
		if (!modern && isNativeFormat(format)) {
			return this.native.unwrapKey(format, data, nativeKey(unwrappingKey), algorithm, unwrappedAlgorithm, extractable, nativeUsages(usages))
		}
		const transportKey = await this.native.unwrapKey('raw', data, nativeKey(unwrappingKey), algorithm, { name: 'HMAC', hash: 'SHA-256' }, true, [
			'sign',
		])
		const bytes = await this.native.exportKey('raw', transportKey)
		if (format === 'jwk') {
			const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
			if (!modern) cryptoError('NotSupportedError', 'Unsupported algorithm for wrapped JWK')
			return this.importJwk(parseModernJwk(parsed), modern, extractable, usages)
		}
		return this.importKey(format, bytes, unwrappedAlgorithm, extractable, usages)
	}
	async encrypt(
		algorithm: AlgorithmIdentifier | RsaOaepParams | AesCtrParams | AesCbcParams | AesGcmParams,
		key: CryptoKey,
		data: BufferSource,
	): Promise<ArrayBuffer> {
		return this.native.encrypt(algorithm, nativeKey(key), data)
	}
	async decrypt(
		algorithm: AlgorithmIdentifier | RsaOaepParams | AesCtrParams | AesCbcParams | AesGcmParams,
		key: CryptoKey,
		data: BufferSource,
	): Promise<ArrayBuffer> {
		return this.native.decrypt(algorithm, nativeKey(key), data)
	}
	digest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
		return this.native.digest(algorithm, data)
	}
	deriveBits(
		algorithm: AlgorithmIdentifier | EcdhKeyDeriveParams | HkdfParams | Pbkdf2Params,
		key: CryptoKey,
		length: number | null,
	): Promise<ArrayBuffer> {
		return this.native.deriveBits(algorithm, nativeKey(key), length)
	}
	deriveKey(
		algorithm: AlgorithmIdentifier | EcdhKeyDeriveParams | HkdfParams | Pbkdf2Params,
		key: CryptoKey,
		derivedAlgorithm: AlgorithmIdentifier | AesDerivedKeyParams | HmacImportParams,
		extractable: boolean,
		usages: KeyUsage[],
	): Promise<CryptoKey> {
		return this.native.deriveKey(algorithm, nativeKey(key), derivedAlgorithm, extractable, usages)
	}
}

function optionalJwkString(value: unknown): string | undefined {
	if (value === undefined || typeof value === 'string') return value
	cryptoError('DataError', 'Expected a string JWK field')
}

function parseModernJwk(value: unknown): ModernJsonWebKey {
	if (typeof value !== 'object' || value === null || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
		cryptoError('DataError', 'Expected a JWK object')
	}
	const kty = optionalJwkString('kty' in value ? value.kty : undefined)
	const alg = optionalJwkString('alg' in value ? value.alg : undefined)
	const pub = optionalJwkString('pub' in value ? value.pub : undefined)
	const priv = optionalJwkString('priv' in value ? value.priv : undefined)
	const use = optionalJwkString('use' in value ? value.use : undefined)
	const ext = 'ext' in value ? value.ext : undefined
	if (ext !== undefined && typeof ext !== 'boolean') cryptoError('DataError', 'Expected a boolean JWK ext field')
	let keyOps: string[] | undefined
	const ops = 'key_ops' in value ? value.key_ops : undefined
	if (ops !== undefined) {
		if (!Array.isArray(ops)) cryptoError('DataError', 'Expected a JWK key_ops array')
		keyOps = []
		for (const op of ops) {
			if (typeof op !== 'string') cryptoError('DataError', 'Expected a string JWK key operation')
			keyOps.push(op)
		}
	}
	return { kty, alg, pub, priv, use, ext, key_ops: keyOps }
}

let adapter: ModernCryptoAdapter | undefined
let installed = false
const originalDescriptors = new Map<string, PropertyDescriptor | undefined>()
let originalSupports: PropertyDescriptor | undefined
let nativeRestricted = false

function restrictNativeModernCrypto(): void {
	if (nativeRestricted) return
	nativeRestricted = true
	const subtle = crypto.subtle
	const hasNativeModernCrypto = 'encapsulateBits' in subtle
	for (const name of ['encapsulateBits', 'decapsulateBits', 'encapsulateKey', 'decapsulateKey', 'getPublicKey']) {
		Reflect.deleteProperty(subtle, name)
		Reflect.deleteProperty(SubtleCrypto.prototype, name)
	}
	Reflect.deleteProperty(SubtleCrypto, 'supports')
	if (!hasNativeModernCrypto) return
	Object.defineProperties(
		subtle,
		Object.fromEntries(
			Object.entries(restrictedCryptoMethods(subtle)).map(([name, value]) => [name, { value, configurable: true, writable: true }]),
		),
	)
}

function restrictedCryptoMethods(subtle: NativeSubtleCrypto) {
	const generateKey = subtle.generateKey.bind(subtle)
	const importKey = subtle.importKey.bind(subtle)
	const exportKey = subtle.exportKey.bind(subtle)
	const sign = subtle.sign.bind(subtle)
	const verify = subtle.verify.bind(subtle)
	const wrapKey = subtle.wrapKey.bind(subtle)
	const unwrapKey = subtle.unwrapKey.bind(subtle)
	const methods = {
		async generateKey(algorithm: GenerateAlgorithm, extractable: boolean, usages: KeyUsage[]) {
			rejectUnsupportedModernAlgorithm(algorithm)
			return generateKey(algorithm, extractable, usages)
		},
		async importKey(
			format: ModernKeyFormat,
			data: BufferSource | ModernJsonWebKey,
			algorithm: ImportAlgorithm,
			extractable: boolean,
			usages: KeyUsage[],
		) {
			rejectUnsupportedModernAlgorithm(algorithm)
			if (!isNativeFormat(format)) cryptoError('NotSupportedError', 'Unsupported key format')
			if (format === 'jwk') {
				if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) throw new TypeError('JWK must be an object')
				return importKey(format, data, algorithm, extractable, usages)
			}
			return importKey(format, copyBuffer(data), algorithm, extractable, usages)
		},
		async exportKey(format: ModernKeyFormat, key: CryptoKey) {
			rejectUnsupportedModernAlgorithm(key.algorithm)
			if (!isNativeFormat(format)) cryptoError('NotSupportedError', 'Unsupported key format')
			return format === 'jwk' ? exportKey('jwk', key) : exportKey(format, key)
		},
		async sign(algorithm: SignAlgorithm, key: CryptoKey, data: BufferSource) {
			rejectUnsupportedModernAlgorithm(algorithm)
			return sign(algorithm, key, data)
		},
		async verify(algorithm: SignAlgorithm, key: CryptoKey, signature: BufferSource, data: BufferSource) {
			rejectUnsupportedModernAlgorithm(algorithm)
			return verify(algorithm, key, signature, data)
		},
		async wrapKey(format: ModernKeyFormat, key: CryptoKey, wrappingKey: CryptoKey, algorithm: AlgorithmIdentifier) {
			rejectUnsupportedModernAlgorithm(key.algorithm)
			if (!isNativeFormat(format)) cryptoError('NotSupportedError', 'Unsupported key format')
			return wrapKey(format, key, wrappingKey, algorithm)
		},
		async unwrapKey(
			format: ModernKeyFormat,
			data: BufferSource,
			key: CryptoKey,
			algorithm: AlgorithmIdentifier,
			unwrappedAlgorithm: ImportAlgorithm,
			extractable: boolean,
			usages: KeyUsage[],
		) {
			rejectUnsupportedModernAlgorithm(unwrappedAlgorithm)
			if (!isNativeFormat(format)) cryptoError('NotSupportedError', 'Unsupported key format')
			return unwrapKey(format, data, key, algorithm, unwrappedAlgorithm, extractable, usages)
		},
	}
	return methods
}

function captureNativeCrypto(): NativeSubtleCrypto {
	const subtle = crypto.subtle
	return {
		encrypt: subtle.encrypt.bind(subtle),
		decrypt: subtle.decrypt.bind(subtle),
		sign: subtle.sign.bind(subtle),
		verify: subtle.verify.bind(subtle),
		digest: subtle.digest.bind(subtle),
		generateKey: subtle.generateKey.bind(subtle),
		importKey: subtle.importKey.bind(subtle),
		exportKey: subtle.exportKey.bind(subtle),
		wrapKey: subtle.wrapKey.bind(subtle),
		unwrapKey: subtle.unwrapKey.bind(subtle),
		deriveBits: subtle.deriveBits.bind(subtle),
		deriveKey: subtle.deriveKey.bind(subtle),
	}
}

function modernCryptoMethods(modern: ModernCryptoAdapter) {
	return {
		generateKey: modern.generateKey.bind(modern),
		importKey: modern.importKey.bind(modern),
		exportKey: modern.exportKey.bind(modern),
		sign: modern.sign.bind(modern),
		verify: modern.verify.bind(modern),
		wrapKey: modern.wrapKey.bind(modern),
		unwrapKey: modern.unwrapKey.bind(modern),
		encapsulateBits: modern.encapsulateBits.bind(modern),
		decapsulateBits: modern.decapsulateBits.bind(modern),
		encapsulateKey: modern.encapsulateKey.bind(modern),
		decapsulateKey: modern.decapsulateKey.bind(modern),
		getPublicKey: modern.getPublicKey.bind(modern),
		encrypt: modern.encrypt.bind(modern),
		decrypt: modern.decrypt.bind(modern),
		deriveBits: modern.deriveBits.bind(modern),
		deriveKey: modern.deriveKey.bind(modern),
	}
}

export interface CryptoFacades {
	readonly legacy: NativeSubtleCrypto & { readonly timingSafeEqual: typeof cfTimingSafeEqual }
	readonly modern: ModernSubtleCrypto & { readonly timingSafeEqual: typeof cfTimingSafeEqual }
}

export function createCryptoFacades(): CryptoFacades {
	const legacy = captureNativeCrypto()
	Object.defineProperties(
		legacy,
		Object.fromEntries(
			Object.entries(restrictedCryptoMethods(legacy)).map(([name, value]) => [name, { value, configurable: true, writable: true }]),
		),
	)
	const modern = new ModernCryptoAdapter(legacy)
	return {
		legacy: { ...legacy, timingSafeEqual: cfTimingSafeEqual },
		modern: {
			...modernCryptoMethods(modern),
			digest: modern.digest.bind(modern),
			timingSafeEqual: cfTimingSafeEqual,
		},
	}
}

/** Configure the current isolate before importing user code. No process-wide flags are read. */
export function configureModernCrypto(enabled: boolean): ModernSubtleCrypto | undefined {
	restrictNativeModernCrypto()
	if (enabled && !adapter) {
		adapter = new ModernCryptoAdapter(captureNativeCrypto())
	}
	if (enabled && !installed && adapter) {
		const methods = modernCryptoMethods(adapter)
		for (const [name, method] of Object.entries(methods)) {
			originalDescriptors.set(name, Object.getOwnPropertyDescriptor(crypto.subtle, name))
			Object.defineProperty(crypto.subtle, name, { value: method, configurable: true, writable: true })
		}
		originalSupports = Object.getOwnPropertyDescriptor(SubtleCrypto, 'supports')
		Object.defineProperty(SubtleCrypto, 'supports', { value: modernCryptoSupports, configurable: true, writable: true })
		installed = true
	} else if (!enabled && installed) {
		for (const [name, descriptor] of originalDescriptors) {
			if (descriptor) Object.defineProperty(crypto.subtle, name, descriptor)
			else Reflect.deleteProperty(crypto.subtle, name)
		}
		if (originalSupports) Object.defineProperty(SubtleCrypto, 'supports', originalSupports)
		else Reflect.deleteProperty(SubtleCrypto, 'supports')
		installed = false
	}
	return enabled ? adapter : undefined
}
