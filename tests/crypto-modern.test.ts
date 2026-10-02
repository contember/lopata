import { ml_dsa44, ml_dsa65, ml_dsa87 } from '@noble/post-quantum/ml-dsa.js'
import { ml_kem1024, ml_kem768 } from '@noble/post-quantum/ml-kem.js'
import { afterEach, describe, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { patchGlobalCrypto } from '../src/bindings/crypto-extras'
import { configureModernCrypto } from '../src/bindings/crypto-modern'
import type { ModernAlgorithmName, ModernKeyUsage, ModernSubtleCrypto } from '../src/bindings/crypto-modern'
import { modernCryptoSupports } from '../src/bindings/crypto-modern-supports'

patchGlobalCrypto()
afterEach(() => configureModernCrypto(false))

function subtle(): ModernSubtleCrypto {
	const result = configureModernCrypto(true)
	if (!result) throw new Error('Modern crypto was not enabled')
	return result
}

const kems: { name: ModernAlgorithmName; implementation: typeof ml_kem768 }[] = [
	{ name: 'ML-KEM-768', implementation: ml_kem768 },
	{ name: 'ML-KEM-1024', implementation: ml_kem1024 },
]
const signatures: { name: ModernAlgorithmName; implementation: typeof ml_dsa44 }[] = [
	{ name: 'ML-DSA-44', implementation: ml_dsa44 },
	{ name: 'ML-DSA-65', implementation: ml_dsa65 },
	{ name: 'ML-DSA-87', implementation: ml_dsa87 },
]
const kemUsages: ModernKeyUsage[] = ['encapsulateBits', 'decapsulateBits', 'encapsulateKey', 'decapsulateKey']
const message = new TextEncoder().encode('Web Crypto interoperability')

describe('ML-KEM', () => {
	for (const { name, implementation } of kems) {
		test(`${name}: seed import and independent encapsulation/decapsulation`, async () => {
			const api = subtle()
			const seed = new Uint8Array(64).map((_, index) => index)
			const independent = implementation.keygen(seed)
			const privateKey = await api.importKey('raw-seed', seed, name, true, ['decapsulateBits'])
			seed.fill(255)
			const publicKey = await api.getPublicKey(privateKey, ['encapsulateBits'])
			expect(new Uint8Array(await api.exportKey('raw-public', publicKey))).toEqual(independent.publicKey)
			const external = implementation.encapsulate(independent.publicKey, new Uint8Array(32).fill(42))
			expect(new Uint8Array(await api.decapsulateBits(name, privateKey, external.cipherText))).toEqual(external.sharedSecret)
			const internal = await api.encapsulateBits(name, publicKey)
			expect(implementation.decapsulate(new Uint8Array(internal.ciphertext), independent.secretKey)).toEqual(new Uint8Array(internal.sharedKey))
			const second = await api.encapsulateBits(name, publicKey)
			expect(second.ciphertext).not.toEqual(internal.ciphertext)
			expect(second.sharedKey).not.toEqual(internal.sharedKey)
			const damaged = new Uint8Array(internal.ciphertext)
			damaged[0] = 255
			if (new Uint8Array(internal.ciphertext)[0] === 255) damaged[0] = 254
			expect(await api.decapsulateBits(name, privateKey, damaged)).not.toEqual(internal.sharedKey)
			await expect(api.decapsulateBits(name, privateKey, damaged.subarray(1))).rejects.toMatchObject({ name: 'OperationError' })
		})

		test(`${name}: KEM AES-GCM key helpers produce native interoperable keys`, async () => {
			const api = subtle()
			const pair = await api.generateKey(name, false, kemUsages)
			const encapsulated = await api.encapsulateKey(name, pair.publicKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
			const decapsulated = await api.decapsulateKey(name, pair.privateKey, encapsulated.ciphertext, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
			expect(encapsulated.sharedKey instanceof CryptoKey).toBe(true)
			expect(encapsulated.sharedKey.extractable).toBe(false)
			const algorithm = { name: 'AES-GCM', iv: new Uint8Array(12) }
			const encrypted = await crypto.subtle.encrypt(algorithm, encapsulated.sharedKey, message)
			expect(new Uint8Array(await crypto.subtle.decrypt(algorithm, decapsulated, encrypted))).toEqual(message)
			await expect(crypto.subtle.exportKey('raw', encapsulated.sharedKey)).rejects.toMatchObject({ name: 'InvalidAccessError' })
		})

		test(`${name}: KEM key helpers reject asymmetric shared-key algorithms`, async () => {
			const api = subtle()
			const pair = await api.generateKey(name, false, kemUsages)
			const bits = await api.encapsulateBits(name, pair.publicKey)
			for (const algorithm of ['Ed25519', 'X25519']) {
				const usages: 'verify'[] = algorithm === 'Ed25519' ? ['verify'] : []
				await expect(api.encapsulateKey(name, pair.publicKey, algorithm, true, usages)).rejects.toMatchObject({ name: 'NotSupportedError' })
				await expect(api.decapsulateKey(name, pair.privateKey, bits.ciphertext, algorithm, true, usages)).rejects.toMatchObject({
					name: 'NotSupportedError',
				})
			}
		})
	}
})

describe('ML-DSA', () => {
	for (const { name, implementation } of signatures) {
		test(`${name}: signs and verifies with independent keys and context`, async () => {
			const api = subtle()
			const seed = new Uint8Array(32).map((_, index) => index + 1)
			const independent = implementation.keygen(seed)
			const privateKey = await api.importKey('raw-seed', seed, name, false, ['sign'])
			const publicKey = await api.getPublicKey(privateKey, ['verify'])
			const context = new Uint8Array([1, 2, 3])
			const algorithm = { name, context }
			const signature = await api.sign(algorithm, privateKey, message)
			expect(implementation.verify(new Uint8Array(signature), message, independent.publicKey, { context })).toBe(true)
			const independentSignature = implementation.sign(message, independent.secretKey, { context, extraEntropy: false })
			expect(await api.verify(algorithm, publicKey, independentSignature, message)).toBe(true)
			expect(await api.verify(name, publicKey, independentSignature, message)).toBe(false)
			expect(await api.verify(algorithm, publicKey, independentSignature, new Uint8Array([99]))).toBe(false)
			expect(await api.verify(algorithm, publicKey, new Uint8Array(1), message)).toBe(false)
			expect(await api.sign(algorithm, privateKey, message)).not.toEqual(signature)
			const generated = await api.generateKey(name, true, ['sign', 'verify'])
			const generatedSeed = new Uint8Array(await api.exportKey('raw-seed', generated.privateKey))
			expect(implementation.keygen(generatedSeed).publicKey).toEqual(new Uint8Array(await api.exportKey('raw-public', generated.publicKey)))
		})
	}

	test('context validation and maximum context length', async () => {
		const api = subtle()
		const pair = await api.generateKey('ML-DSA-44', false, ['sign', 'verify'])
		const algorithm = { name: 'ML-DSA-44', context: new Uint8Array(255) }
		const signature = await api.sign(algorithm, pair.privateKey, message)
		expect(await api.verify(algorithm, pair.publicKey, signature, message)).toBe(true)
		const tooLong = { name: 'ML-DSA-44', context: new Uint8Array(256) }
		await expect(api.sign(tooLong, pair.privateKey, message)).rejects.toMatchObject({ name: 'OperationError' })
		await expect(api.verify(tooLong, pair.publicKey, signature, message)).rejects.toMatchObject({ name: 'OperationError' })
		for (const context of [null, 'invalid']) {
			const invalid = { name: 'ML-DSA-44', context }
			await expect(api.sign(invalid, pair.privateKey, message)).rejects.toMatchObject({ name: 'TypeError' })
		}
	})
})

describe('post-quantum key formats and semantics', () => {
	test('seed-only PKCS8 matches the workerd encoding and SPKI uses the NIST OID', async () => {
		const api = subtle()
		const fixtures: { name: ModernAlgorithmName; seedLength: number; usage: ModernKeyUsage; pkcs8Prefix: string; spkiPrefix: string }[] = [
			{
				name: 'ML-KEM-768',
				seedLength: 64,
				usage: 'decapsulateBits',
				pkcs8Prefix: '3054020100300b060960864801650304040204428040',
				spkiPrefix: '308204b2300b0609608648016503040402038204a100',
			},
			{
				name: 'ML-DSA-44',
				seedLength: 32,
				usage: 'sign',
				pkcs8Prefix: '3034020100300b060960864801650304031104228020',
				spkiPrefix: '30820532300b06096086480165030403110382052100',
			},
		]
		for (const fixture of fixtures) {
			const seed = new Uint8Array(fixture.seedLength).map((_, index) => index)
			const der = new Uint8Array([...Buffer.from(fixture.pkcs8Prefix, 'hex'), ...seed])
			const privateKey = await api.importKey('pkcs8', der, fixture.name, true, [fixture.usage])
			expect(await api.exportKey('raw-seed', privateKey)).toEqual(seed.buffer)
			expect(await api.exportKey('pkcs8', privateKey)).toEqual(der.buffer)
			const publicKey = await api.getPublicKey(privateKey, [])
			const raw = new Uint8Array(await api.exportKey('raw-public', publicKey))
			expect(new Uint8Array(await api.exportKey('spki', publicKey))).toEqual(new Uint8Array([...Buffer.from(fixture.spkiPrefix, 'hex'), ...raw]))
		}
	})

	for (const { name } of [...kems, ...signatures]) {
		test(`${name}: raw, DER and AKP JWK roundtrips retain key material`, async () => {
			const api = subtle()
			const isKem = name.startsWith('ML-KEM')
			const pair = await api.generateKey(name, true, isKem ? kemUsages : ['sign', 'verify'])
			expect(pair.privateKey instanceof CryptoKey).toBe(true)
			expect(Object.prototype.toString.call(pair.privateKey)).toBe('[object CryptoKey]')
			const publicBytes = await api.exportKey('raw-public', pair.publicKey)
			const seed = await api.exportKey('raw-seed', pair.privateKey)
			for (const format of ['spki', 'pkcs8', 'raw-public', 'raw-seed']) {
				if (format !== 'spki' && format !== 'pkcs8' && format !== 'raw-public' && format !== 'raw-seed') throw new Error('Invalid test format')
				const original = format === 'spki' || format === 'raw-public' ? pair.publicKey : pair.privateKey
				const exported = await api.exportKey(format, original)
				const imported = await api.importKey(format, exported, name.toLowerCase(), true, original.usages)
				expect(await api.exportKey(format, imported)).toEqual(exported)
				if (original.type === 'private') {
					expect(await api.exportKey('raw-public', await api.getPublicKey(imported, pair.publicKey.usages))).toEqual(publicBytes)
				}
			}
			for (const original of [pair.publicKey, pair.privateKey]) {
				const jwk = await api.exportKey('jwk', original)
				expect(jwk.kty).toBe('AKP')
				expect(jwk.alg).toBe(name)
				expect(jwk.pub).toBe(Buffer.from(publicBytes).toString('base64url'))
				if (original.type === 'private') expect(jwk.priv).toBe(Buffer.from(seed).toString('base64url'))
				const imported = await api.importKey('jwk', jwk, name, true, original.usages)
				expect(await api.exportKey('jwk', imported)).toEqual(jwk)
			}
		})
	}

	test('key metadata cannot grant access or expose private bytes', async () => {
		const api = subtle()
		const pair = await api.generateKey('ML-KEM-768', false, ['decapsulateBits'])
		expect(pair.privateKey.usages).toEqual(['decapsulateBits'])
		expect(pair.publicKey.usages).toEqual([])
		expect(pair.publicKey.extractable).toBe(true)
		pair.privateKey.usages.push('sign')
		pair.privateKey.algorithm.name = 'ML-DSA-44'
		expect(pair.privateKey.algorithm.name).toBe('ML-KEM-768')
		expect(pair.privateKey.usages).toEqual(['decapsulateBits'])
		expect(Object.keys(pair.privateKey)).toEqual([])
		expect(() => Reflect.construct(pair.privateKey.constructor, [Symbol('CryptoKey'), {}])).toThrow(TypeError)
		await expect(api.exportKey('jwk', pair.privateKey)).rejects.toMatchObject({ name: 'InvalidAccessError' })
		const publicKey = await api.getPublicKey(pair.privateKey, ['encapsulateBits'])
		const bits = await api.encapsulateBits('ML-KEM-768', publicKey)
		expect(await api.decapsulateBits('ML-KEM-768', pair.privateKey, bits.ciphertext)).toEqual(bits.sharedKey)
		await expect(api.encapsulateKey('ML-KEM-768', publicKey, 'AES-GCM', true, ['encrypt'])).rejects.toMatchObject({ name: 'InvalidAccessError' })
		await expect(api.encapsulateBits('ML-KEM-1024', publicKey)).rejects.toMatchObject({ name: 'InvalidAccessError' })
		await expect(api.getPublicKey(publicKey, ['encapsulateBits'])).rejects.toMatchObject({ name: 'InvalidAccessError' })
		await expect(api.getPublicKey(pair.privateKey, ['verify'])).rejects.toMatchObject({ name: 'SyntaxError' })
	})

	test('replacing WeakMap methods cannot expose private state or grant extractability', async () => {
		const api = subtle()
		const before = await api.generateKey('ML-DSA-44', false, ['sign', 'verify'])
		const wrapper = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['wrapKey'])
		const wrappingAlgorithm = { name: 'AES-GCM', iv: new Uint8Array(12) }
		const originalGet = WeakMap.prototype.get
		const originalSet = WeakMap.prototype.set
		const originalHas = WeakMap.prototype.has
		const maps: WeakMap<object, unknown>[] = []
		const values: unknown[] = []
		const stealAndGrantAccess = (value: unknown) => {
			values.push(value)
			if (typeof value === 'object' && value !== null && 'extractable' in value) value.extractable = true
		}
		Object.defineProperty(WeakMap.prototype, 'get', {
			configurable: true,
			writable: true,
			value: function(this: WeakMap<object, unknown>, key: object): unknown {
				maps.push(this)
				const value: unknown = originalGet.call(this, key)
				stealAndGrantAccess(value)
				return value
			},
		})
		Object.defineProperty(WeakMap.prototype, 'set', {
			configurable: true,
			writable: true,
			value: function(this: WeakMap<object, unknown>, key: object, value: unknown) {
				maps.push(this)
				stealAndGrantAccess(value)
				return originalSet.call(this, key, value)
			},
		})
		Object.defineProperty(WeakMap.prototype, 'has', {
			configurable: true,
			writable: true,
			value: function(this: WeakMap<object, unknown>, key: object): boolean {
				maps.push(this)
				return originalHas.call(this, key)
			},
		})
		try {
			const after = await api.generateKey('ML-DSA-44', false, ['sign', 'verify'])
			for (const pair of [before, after]) {
				expect(pair.privateKey.extractable).toBe(false)
				expect(pair.privateKey.type).toBe('private')
				expect(pair.privateKey.algorithm.name).toBe('ML-DSA-44')
				await expect(api.exportKey('raw-seed', pair.privateKey)).rejects.toMatchObject({ name: 'InvalidAccessError' })
				await expect(api.wrapKey('raw-seed', pair.privateKey, wrapper, wrappingAlgorithm)).rejects.toMatchObject({
					name: 'InvalidAccessError',
				})
				await expect(api.sign('Ed25519', pair.privateKey, message)).rejects.toMatchObject({ name: 'InvalidAccessError' })
				const signature = await api.sign('ML-DSA-44', pair.privateKey, message)
				const publicKey = await api.getPublicKey(pair.privateKey, ['verify'])
				expect(await api.verify('ML-DSA-44', publicKey, signature, message)).toBe(true)
				expect(maps.some(map => originalHas.call(map, pair.privateKey) || originalHas.call(map, pair.publicKey))).toBe(false)
			}
			expect(values.some(value => typeof value === 'object' && value !== null && ('seed' in value || 'secretBytes' in value))).toBe(false)
		} finally {
			Object.defineProperty(WeakMap.prototype, 'get', { value: originalGet, configurable: true, writable: true })
			Object.defineProperty(WeakMap.prototype, 'set', { value: originalSet, configurable: true, writable: true })
			Object.defineProperty(WeakMap.prototype, 'has', { value: originalHas, configurable: true, writable: true })
		}
	})

	test('rejects invalid seeds, usages, formats, DER and noncanonical public keys', async () => {
		const api = subtle()
		await expect(api.generateKey('ML-KEM-768', true, ['verify'])).rejects.toMatchObject({ name: 'SyntaxError' })
		await expect(api.generateKey('ML-DSA-44', true, ['verify'])).rejects.toMatchObject({ name: 'SyntaxError' })
		await expect(api.generateKey('ML-KEM-512', true, kemUsages)).rejects.toMatchObject({ name: 'NotSupportedError' })
		await expect(api.importKey('raw-seed', new Uint8Array(31), 'ML-DSA-44', true, ['sign'])).rejects.toMatchObject({ name: 'DataError' })
		await expect(api.importKey('raw-public', new Uint8Array(1184).fill(255), 'ML-KEM-768', true, ['encapsulateBits'])).rejects.toMatchObject({
			name: 'DataError',
		})
		await expect(api.importKey('raw', new Uint8Array(64), 'ML-KEM-768', true, ['decapsulateBits'])).rejects.toMatchObject({ name: 'NotSupportedError' })
		const pair = await api.generateKey('ML-DSA-44', true, ['sign', 'verify'])
		await expect(api.exportKey('raw-public', pair.privateKey)).rejects.toMatchObject({ name: 'InvalidAccessError' })
		await expect(api.exportKey('raw-seed', pair.publicKey)).rejects.toMatchObject({ name: 'InvalidAccessError' })
		await expect(api.exportKey('raw-private', pair.privateKey)).rejects.toMatchObject({ name: 'NotSupportedError' })
		const spki = new Uint8Array(await api.exportKey('spki', pair.publicKey))
		await expect(api.importKey('spki', spki.subarray(1), 'ML-DSA-44', true, ['verify'])).rejects.toMatchObject({ name: 'DataError' })
		await expect(api.importKey('spki', new Uint8Array([...spki, 0]), 'ML-DSA-44', true, ['verify'])).rejects.toMatchObject({ name: 'DataError' })
		await expect(api.importKey('spki', spki, 'ML-DSA-65', true, ['verify'])).rejects.toMatchObject({ name: 'DataError' })
	})

	test('JWK validates alg, use, key_ops, ext and the public/private relation', async () => {
		const api = subtle()
		for (const name of ['ML-KEM-768', 'ML-DSA-44']) {
			if (name !== 'ML-KEM-768' && name !== 'ML-DSA-44') throw new Error('Invalid algorithm')
			const usages: ModernKeyUsage[] = name === 'ML-KEM-768' ? ['decapsulateBits'] : ['sign']
			const usage = usages[0]
			if (!usage) throw new Error('Missing test usage')
			const pair = await api.generateKey(name, true, usages)
			const jwk = await api.exportKey('jwk', pair.privateKey)
			for (
				const invalid of [
					{ ...jwk, alg: undefined },
					{ ...jwk, alg: 'wrong' },
					{ ...jwk, kty: 'OKP' },
					{ ...jwk, key_ops: [] },
					{ ...jwk, key_ops: [usage, usage] },
					{ ...jwk, use: 'wrong' },
					{ ...jwk, ext: false },
					{ ...jwk, pub: 'AQ' },
					{ ...jwk, priv: '%%' },
				]
			) {
				await expect(api.importKey('jwk', invalid, name, true, usages)).rejects.toMatchObject({ name: 'DataError' })
			}
			const withoutPublic = { ...jwk, pub: undefined }
			if (name === 'ML-KEM-768') await expect(api.importKey('jwk', withoutPublic, name, true, usages)).rejects.toMatchObject({ name: 'DataError' })
			else expect((await api.importKey('jwk', withoutPublic, name, true, usages)).type).toBe('private')
		}
	})

	test('native AES wrapping works for post-quantum raw keys and JWK', async () => {
		const api = subtle()
		const pair = await api.generateKey('ML-DSA-44', true, ['sign', 'verify'])
		const wrapper = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey'])
		const algorithm = { name: 'AES-GCM', iv: new Uint8Array(12) }
		for (const format of ['raw-seed', 'jwk']) {
			if (format !== 'raw-seed' && format !== 'jwk') throw new Error('Invalid format')
			const wrapped = await api.wrapKey(format, pair.privateKey, wrapper, algorithm)
			const unwrapped = await api.unwrapKey(format, wrapped, wrapper, algorithm, 'ML-DSA-44', true, ['sign'])
			expect(await api.exportKey('raw-seed', unwrapped)).toEqual(await api.exportKey('raw-seed', pair.privateKey))
		}
		const kw = await crypto.subtle.generateKey({ name: 'AES-KW', length: 256 }, false, ['wrapKey', 'unwrapKey'])
		const wrapped = await api.wrapKey('raw-seed', pair.privateKey, kw, 'AES-KW')
		const unwrapped = await api.unwrapKey('raw-seed', wrapped, kw, 'AES-KW', 'ML-DSA-44', true, ['sign'])
		expect(await api.exportKey('raw-seed', unwrapped)).toEqual(await api.exportKey('raw-seed', pair.privateKey))
	})
})

describe('modern helpers with classical crypto', () => {
	test('supports reads inherited and non-enumerable WebIDL dictionary parameters', async () => {
		const api = subtle()
		class InheritedAesParameters {
			get name() {
				return 'AES-GCM'
			}
			get iv() {
				return new Uint8Array(12)
			}
		}
		const encryptionAlgorithm = new InheritedAesParameters()
		const generationAlgorithm = { name: 'AES-GCM', length: 256 }
		Object.defineProperty(generationAlgorithm, 'length', { value: 256, enumerable: false })
		expect(modernCryptoSupports('generateKey', generationAlgorithm)).toBe(true)
		const key = await crypto.subtle.generateKey(generationAlgorithm, false, ['encrypt', 'decrypt'])
		expect(modernCryptoSupports('encrypt', encryptionAlgorithm)).toBe(true)
		const encrypted = await crypto.subtle.encrypt(encryptionAlgorithm, key, message)
		expect(new Uint8Array(await crypto.subtle.decrypt(encryptionAlgorithm, key, encrypted))).toEqual(message)
		const hmacAlgorithm = { name: 'HMAC', hash: 'SHA-256' }
		Object.defineProperty(hmacAlgorithm, 'hash', { value: 'SHA-256', enumerable: false })
		expect(modernCryptoSupports('generateKey', hmacAlgorithm)).toBe(true)
		const hmac = await crypto.subtle.generateKey(hmacAlgorithm, false, ['sign', 'verify'])
		if ('privateKey' in hmac) throw new Error('Expected an HMAC key')
		expect(await crypto.subtle.verify('HMAC', hmac, await crypto.subtle.sign('HMAC', hmac, message), message)).toBe(true)
		class InheritedDsaParameters {
			get name() {
				return 'ML-DSA-44'
			}
			get context() {
				return new Uint8Array(256)
			}
		}
		const invalidDsaAlgorithm = new InheritedDsaParameters()
		const pair = await api.generateKey('ML-DSA-44', false, ['sign'])
		expect(modernCryptoSupports('sign', invalidDsaAlgorithm)).toBe(false)
		await expect(api.sign(invalidDsaAlgorithm, pair.privateKey, message)).rejects.toMatchObject({ name: 'OperationError' })
	})

	test('raw-public and raw-secret aliases preserve native key types', async () => {
		const api = subtle()
		const symmetric = await api.importKey('raw-secret', new Uint8Array(32), 'AES-GCM', true, ['encrypt'])
		expect(symmetric.type).toBe('secret')
		expect(await api.exportKey('raw-secret', symmetric)).toEqual(new Uint8Array(32).buffer)
		const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
		if (!('publicKey' in pair)) throw new Error('Expected a key pair')
		const raw = await api.exportKey('raw-public', pair.publicKey)
		const publicKey = await api.importKey('raw-public', raw, 'Ed25519', true, ['verify'])
		expect(publicKey.type).toBe('public')
		expect(await api.verify('Ed25519', publicKey, await api.sign('Ed25519', pair.privateKey, message), message)).toBe(true)
		await expect(api.importKey('raw-public', new Uint8Array(32), 'AES-GCM', true, ['encrypt'])).rejects.toMatchObject({ name: 'NotSupportedError' })
		await expect(api.importKey('raw-secret', raw, 'Ed25519', true, ['verify'])).rejects.toMatchObject({ name: 'NotSupportedError' })
		await expect(api.exportKey('raw-public', symmetric)).rejects.toMatchObject({ name: 'InvalidAccessError' })
		await expect(api.exportKey('raw-secret', pair.publicKey)).rejects.toMatchObject({ name: 'InvalidAccessError' })
	})

	test('getPublicKey supports native non-extractable EC, Edwards, Montgomery and RSA keys', async () => {
		const api = subtle()
		for (
			const algorithm of [
				{ name: 'ECDSA', namedCurve: 'P-256' },
				{ name: 'ECDH', namedCurve: 'P-384' },
				{ name: 'Ed25519' },
				{ name: 'X25519' },
				{ name: 'RSA-PSS', modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
				{ name: 'RSA-OAEP', modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
				{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
			]
		) {
			const derivation = ['ECDH', 'X25519'].includes(algorithm.name)
			const rsaOaep = algorithm.name === 'RSA-OAEP'
			const pair = await crypto.subtle.generateKey(algorithm, false, derivation ? ['deriveBits'] : rsaOaep ? ['decrypt', 'encrypt'] : ['sign', 'verify'])
			if (!('privateKey' in pair)) throw new Error('Expected a key pair')
			const publicKey = await api.getPublicKey(pair.privateKey, derivation ? [] : rsaOaep ? ['encrypt'] : ['verify'])
			expect(publicKey.extractable).toBe(true)
			expect(await api.exportKey('spki', publicKey)).toEqual(await api.exportKey('spki', pair.publicKey))
		}
		const secret = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt'])
		await expect(api.getPublicKey(secret, [])).rejects.toMatchObject({ name: 'NotSupportedError' })
	})

	test('supports agrees with executed classical parameter checks and modern operations', async () => {
		const api = subtle()
		const dsa = await api.generateKey('ML-DSA-44', true, ['sign', 'verify'])
		const dsaAlgorithm = { name: 'ml-dsa-44', context: new Uint8Array(3) }
		expect(modernCryptoSupports('sign', dsaAlgorithm)).toBe(true)
		expect(await api.verify(dsaAlgorithm, dsa.publicKey, await api.sign(dsaAlgorithm, dsa.privateKey, message), message)).toBe(true)
		expect(modernCryptoSupports('sign', { name: 'ML-DSA-44', context: new Uint8Array(256) })).toBe(false)
		const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-521' }, false, ['deriveBits'])
		const ecdh = { name: 'ECDH', public: pair.publicKey }
		expect(modernCryptoSupports('deriveBits', ecdh, 528)).toBe(true)
		expect((await crypto.subtle.deriveBits(ecdh, pair.privateKey, 528)).byteLength).toBe(66)
		expect(modernCryptoSupports('deriveBits', ecdh, 529)).toBe(false)
		expect(() => modernCryptoSupports('deriveBits', ecdh, -1)).toThrow(TypeError)
		expect(() => modernCryptoSupports('deriveBits', ecdh, 2 ** 32)).toThrow(TypeError)
		const validAes = { name: 'AES-GCM', length: 256 }
		expect(modernCryptoSupports('generateKey', validAes)).toBe(true)
		expect((await crypto.subtle.generateKey(validAes, false, ['encrypt'])).algorithm.name).toBe('AES-GCM')
		expect(modernCryptoSupports('generateKey', { name: 'AES-GCM', length: 42 })).toBe(false)
		expect(modernCryptoSupports('encrypt', 'AES-GCM')).toBe(false)
		expect(modernCryptoSupports('importKey', 'HMAC')).toBe(false)
		expect(modernCryptoSupports('generateKey', 'ML-KEM-512')).toBe(false)
		expect(modernCryptoSupports('encapsulateKey', 'ML-KEM-768', { name: 'HMAC', hash: 'SHA-256', length: 128 })).toBe(false)
	})

	test('flag toggles are idempotent and preserve native methods and PKCS1 import', async () => {
		configureModernCrypto(false)
		const originalGenerate = crypto.subtle.generateKey
		expect(Object.hasOwn(SubtleCrypto, 'supports')).toBe(false)
		expect('encapsulateBits' in crypto.subtle).toBe(false)
		await expect(crypto.subtle.generateKey('ML-DSA-44', true, ['sign'])).rejects.toMatchObject({ name: 'NotSupportedError' })
		subtle()
		const patchedGenerate = crypto.subtle.generateKey
		subtle()
		expect(crypto.subtle.generateKey).toBe(patchedGenerate)
		expect(Object.hasOwn(SubtleCrypto, 'supports')).toBe(true)
		patchGlobalCrypto()
		const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 })
		const pkcs1 = new Uint8Array(rsa.privateKey.export({ type: 'pkcs1', format: 'der' }))
		const key = await crypto.subtle.importKey('pkcs8', pkcs1, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
		await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, message)
		configureModernCrypto(false)
		configureModernCrypto(false)
		expect(crypto.subtle.generateKey).toBe(originalGenerate)
		expect('encapsulateBits' in crypto.subtle).toBe(false)
		expect(Object.hasOwn(SubtleCrypto, 'supports')).toBe(false)
		await crypto.subtle.importKey('pkcs8', pkcs1, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
	})
})
