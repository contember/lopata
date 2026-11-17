import { describe, expect, test } from 'bun:test'
import { cfTimingSafeEqual, DigestStream } from '../src/bindings/crypto-extras'

describe('crypto.subtle.timingSafeEqual', () => {
	test('equal buffers return true', () => {
		const a = new Uint8Array([1, 2, 3, 4]).buffer
		const b = new Uint8Array([1, 2, 3, 4]).buffer
		expect(cfTimingSafeEqual(a, b)).toBe(true)
	})

	test('different buffers return false', () => {
		const a = new Uint8Array([1, 2, 3, 4]).buffer
		const b = new Uint8Array([1, 2, 3, 5]).buffer
		expect(cfTimingSafeEqual(a, b)).toBe(false)
	})

	test('different lengths throw TypeError', () => {
		const a = new Uint8Array([1, 2, 3]).buffer
		const b = new Uint8Array([1, 2, 3, 4]).buffer
		expect(() => cfTimingSafeEqual(a, b)).toThrow(TypeError)
	})

	test('works with Uint8Array views', () => {
		const a = new Uint8Array([10, 20, 30])
		const b = new Uint8Array([10, 20, 30])
		expect(cfTimingSafeEqual(a, b)).toBe(true)
	})

	test('works with DataView', () => {
		const a = new DataView(new Uint8Array([5, 6]).buffer)
		const b = new DataView(new Uint8Array([5, 6]).buffer)
		expect(cfTimingSafeEqual(a, b)).toBe(true)
	})

	test('works with subarray views', () => {
		const full = new Uint8Array([0, 1, 2, 3, 4])
		const sub = full.subarray(1, 4) // [1, 2, 3]
		const other = new Uint8Array([1, 2, 3])
		expect(cfTimingSafeEqual(sub, other)).toBe(true)
	})
})

describe('crypto.DigestStream', () => {
	test('SHA-256 of known input', async () => {
		const ds = new DigestStream('SHA-256')
		const writer = ds.getWriter()
		await writer.write(new TextEncoder().encode('hello'))
		await writer.close()

		const digest = await ds.digest
		const hex = Buffer.from(digest).toString('hex')
		expect(hex).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
	})

	test('SHA-1 hash', async () => {
		const ds = new DigestStream('SHA-1')
		const writer = ds.getWriter()
		await writer.write(new TextEncoder().encode('abc'))
		await writer.close()

		const digest = await ds.digest
		const hex = Buffer.from(digest).toString('hex')
		expect(hex).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
	})

	test('SHA-512 hash', async () => {
		const ds = new DigestStream('SHA-512')
		const writer = ds.getWriter()
		await writer.write(new TextEncoder().encode('test'))
		await writer.close()

		const digest = await ds.digest
		const hex = Buffer.from(digest).toString('hex')
		expect(hex).toBe('ee26b0dd4af7e749aa1a8ee3c10ae9923f618980772e473f8819a5d4940e0db27ac185f8a0e1d5f84f88bc887fd67b143732c304cc5fa9ad8e6f57f50028a8ff')
	})

	test('MD5 hash', async () => {
		const ds = new DigestStream('MD5')
		const writer = ds.getWriter()
		await writer.write(new TextEncoder().encode('hello'))
		await writer.close()

		const digest = await ds.digest
		const hex = Buffer.from(digest).toString('hex')
		expect(hex).toBe('5d41402abc4b2a76b9719d911017c592')
	})

	test('multiple chunks', async () => {
		const ds = new DigestStream('SHA-256')
		const writer = ds.getWriter()
		await writer.write(new TextEncoder().encode('hel'))
		await writer.write(new TextEncoder().encode('lo'))
		await writer.close()

		const digest = await ds.digest
		const hex = Buffer.from(digest).toString('hex')
		// Same as SHA-256 of "hello"
		expect(hex).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
	})

	test('pipe from ReadableStream', async () => {
		const ds = new DigestStream('SHA-256')
		const input = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('hello'))
				controller.close()
			},
		})

		await input.pipeTo(ds)
		const digest = await ds.digest
		const hex = Buffer.from(digest).toString('hex')
		expect(hex).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
	})

	test('unsupported algorithm throws', () => {
		expect(() => new DigestStream('SHA-3')).toThrow(TypeError)
	})

	test('empty input', async () => {
		const ds = new DigestStream('SHA-256')
		const writer = ds.getWriter()
		await writer.close()

		const digest = await ds.digest
		const hex = Buffer.from(digest).toString('hex')
		// SHA-256 of empty string
		expect(hex).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
	})

	test('accepts ArrayBuffer chunks', async () => {
		const ds = new DigestStream('SHA-256')
		const writer = ds.getWriter()
		await writer.write(new TextEncoder().encode('hello').buffer)
		await writer.close()

		const digest = await ds.digest
		const hex = Buffer.from(digest).toString('hex')
		expect(hex).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
	})

	test('algorithm name is case-insensitive', async () => {
		const ds = new DigestStream('sha-256')
		const writer = ds.getWriter()
		await writer.write(new TextEncoder().encode('hello'))
		await writer.close()

		const digest = await ds.digest
		const hex = Buffer.from(digest).toString('hex')
		expect(hex).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
	})
})

describe('native modern algorithms', () => {
	test.skipIf(typeof crypto.subtle.encapsulateBits !== 'function')('ML-KEM stays reachable on patched crypto.subtle', async () => {
		const pair = await crypto.subtle.generateKey('ML-KEM-768', false, ['encapsulateBits', 'decapsulateBits'])
		if (!('privateKey' in pair)) throw new Error('Expected key pair')
		const { ciphertext, sharedKey } = await crypto.subtle.encapsulateBits('ML-KEM-768', pair.publicKey)
		const decapsulated = await crypto.subtle.decapsulateBits('ML-KEM-768', pair.privateKey, ciphertext)
		expect(new Uint8Array(decapsulated)).toEqual(new Uint8Array(sharedKey))
	})
})

describe('crypto.DigestStream workerd extensions', () => {
	async function digestOf(algorithm: string, ...chunks: (string | ArrayBuffer | ArrayBufferView)[]): Promise<string> {
		const stream = new DigestStream(algorithm)
		const writer = stream.getWriter()
		for (const chunk of chunks) await writer.write(chunk)
		await writer.close()
		return Buffer.from(await stream.digest).toString('base64')
	}

	test('CRC algorithms, with AWS SDK test vectors', async () => {
		expect(await digestOf('crc32', '')).toBe('AAAAAA==')
		expect(await digestOf('crc32', 'Hello world')).toBe('i9aeUg==')
		expect(await digestOf('crc32c', 'abc')).toBe('Nks/tw==')
		expect(await digestOf('crc64nvme', 'Hello world')).toBe('OOJZ0D8xKts=')
		expect(await digestOf('crc64nvme', '')).toBe('AAAAAAAAAAA=')
	})

	test('a CRC is computed across chunks', async () => {
		expect(await digestOf('crc32', 'Hello', ' ', 'world')).toBe('i9aeUg==')
	})

	test('strings are hashed as UTF-8, and bytesWritten counts the bytes as a bigint', async () => {
		const stream = new DigestStream('md5')
		const writer = stream.getWriter()
		await writer.write('hello')
		await writer.write(new TextEncoder().encode('there'))
		await writer.close()
		await stream.digest
		expect(stream.bytesWritten).toBe(10n)
	})

	test('a chunk that is not bytes or a string is rejected', async () => {
		const writer: WritableStreamDefaultWriter<unknown> = new DigestStream('md5').getWriter()
		await expect(writer.write(123)).rejects.toThrow(
			'DigestStream is a byte stream but received an object of non-ArrayBuffer/ArrayBufferView/string type on its writable side.',
		)
	})

	test('aborting the stream rejects the digest', async () => {
		const stream = new DigestStream('md5')
		await stream.getWriter().abort(new Error('boom'))
		await expect(stream.digest).rejects.toThrow('boom')
	})

	test('a disposed stream rejects writes, and disposing twice is harmless', async () => {
		const stream = new DigestStream('md5')
		stream[Symbol.dispose]()
		const writer = stream.getWriter()
		await expect(writer.write('hello')).rejects.toThrow('The DigestStream was disposed.')
		stream[Symbol.dispose]()
	})
})

describe('crypto.subtle.digest MD5', () => {
	test('hashes with MD5, by name or algorithm object, as workerd does', async () => {
		const hex = (buffer: ArrayBuffer) => Buffer.from(buffer).toString('hex')
		expect(hex(await crypto.subtle.digest('MD5', new ArrayBuffer(0)))).toBe('d41d8cd98f00b204e9800998ecf8427e')
		expect(hex(await crypto.subtle.digest({ name: 'md5' }, new TextEncoder().encode('hello')))).toBe('5d41402abc4b2a76b9719d911017c592')
	})

	test('other algorithms still go to the native implementation', async () => {
		expect(Buffer.from(await crypto.subtle.digest('SHA-1', new ArrayBuffer(0))).toString('hex')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709')
		await expect(crypto.subtle.digest('SHA-3', new ArrayBuffer(0))).rejects.toThrow()
	})
})
