import type { webcrypto } from 'node:crypto'

export type AlgorithmIdentifier = webcrypto.AlgorithmIdentifier
export type JsonWebKey = webcrypto.JsonWebKey
export type KeyFormat = 'jwk' | 'pkcs8' | 'raw' | 'spki'
export type KeyUsage = 'encrypt' | 'decrypt' | 'sign' | 'verify' | 'deriveKey' | 'deriveBits' | 'wrapKey' | 'unwrapKey'
export type BufferSource = NodeJS.BufferSource
export type KeyType = webcrypto.KeyType
export type KeyAlgorithm = webcrypto.KeyAlgorithm
export type RsaHashedImportParams = webcrypto.RsaHashedImportParams
export type EcKeyImportParams = webcrypto.EcKeyImportParams
export type HmacImportParams = webcrypto.HmacImportParams
export type RsaHashedKeyGenParams = webcrypto.RsaHashedKeyGenParams
export type EcKeyGenParams = webcrypto.EcKeyGenParams
export type HmacKeyGenParams = webcrypto.HmacKeyGenParams
export type AesKeyGenParams = webcrypto.AesKeyGenParams
export type RsaPssParams = webcrypto.RsaPssParams
export type EcdsaParams = webcrypto.EcdsaParams
export type RsaOaepParams = webcrypto.RsaOaepParams
export type AesCtrParams = webcrypto.AesCtrParams
export type AesCbcParams = webcrypto.AesCbcParams
export interface AesGcmParams extends webcrypto.Algorithm {
	iv: BufferSource
	additionalData?: BufferSource
	tagLength?: number
}
export type EcdhKeyDeriveParams = webcrypto.EcdhKeyDeriveParams
export type HkdfParams = webcrypto.HkdfParams
export type Pbkdf2Params = webcrypto.Pbkdf2Params
export type AesDerivedKeyParams = webcrypto.AesDerivedKeyParams

export type NativeSubtleCrypto = Pick<
	SubtleCrypto,
	| 'encrypt'
	| 'decrypt'
	| 'sign'
	| 'verify'
	| 'digest'
	| 'generateKey'
	| 'deriveKey'
	| 'deriveBits'
	| 'importKey'
	| 'exportKey'
	| 'wrapKey'
	| 'unwrapKey'
>
