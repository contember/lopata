import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WorkerLoaderBinding } from '../src/bindings/worker-loader'

test('normal workers and DO workers configure module-level crypto independently from their own flags', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'lopata-modern-crypto-isolation-'))
	const child = Bun.spawn(['bun', resolve(import.meta.dir, 'fixtures/crypto-modern-isolation-runner.ts')], {
		cwd: directory,
		stdout: 'pipe',
		stderr: 'pipe',
	})
	try {
		const stdout = new Response(child.stdout).text()
		const stderr = new Response(child.stderr).text()
		const exitCode = await child.exited
		const output = await stdout
		const errors = await stderr
		if (exitCode !== 0) throw new Error(`Crypto isolation runner failed (${exitCode}):\n${output}\n${errors}`)
		const line = output.split('\n').find(line => line.startsWith('REPORT '))
		if (!line) throw new Error(`Missing crypto isolation report:\n${output}\n${errors}`)
		const report: unknown = JSON.parse(line.slice('REPORT '.length))
		const enabled = { enabled: true, supported: true, match: true, nativeInstance: true }
		const disabled = { enabled: false, supported: false, error: 'NotSupportedError' }
		expect(report).toEqual({ reports: [enabled, disabled, enabled, disabled], repeated: enabled, repeatedDo: enabled })
	} finally {
		child.kill()
		rmSync(directory, { recursive: true, force: true })
	}
}, 30000)

test('dynamic worker flags configure crypto before module imports and remain isolate-local', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'lopata-modern-crypto-'))
	const loader = new WorkerLoaderBinding(join(directory, 'workers'))
	const source = `
		const enabled = typeof crypto.subtle.encapsulateBits === 'function'
		const supported = typeof SubtleCrypto.supports === 'function'
		const pair = enabled ? await crypto.subtle.generateKey('ML-KEM-768', false, ['encapsulateBits', 'decapsulateBits']) : null
		export default {
			async fetch() {
				if (!pair) {
					let error
					try { await crypto.subtle.generateKey('ML-DSA-44', false, ['sign']) } catch (cause) { error = cause.name }
					return Response.json({ enabled, supported, error })
				}
				const encapsulated = await crypto.subtle.encapsulateBits('ML-KEM-768', pair.publicKey)
				const decapsulated = await crypto.subtle.decapsulateBits('ML-KEM-768', pair.privateKey, encapsulated.ciphertext)
				return Response.json({
					enabled, supported, match: new Uint8Array(decapsulated).every((byte, index) => byte === new Uint8Array(encapsulated.sharedKey)[index]),
					nativeInstance: pair.privateKey instanceof CryptoKey,
					supportsKem: SubtleCrypto.supports('encapsulateBits', 'ML-KEM-768'),
					supports512: SubtleCrypto.supports('encapsulateBits', 'ML-KEM-512'),
				})
			}
		}
	`
	try {
		const enabled = loader.load({
			compatibilityDate: '2026-10-01',
			compatibilityFlags: ['webcrypto_modern_algorithms'],
			mainModule: 'main.js',
			modules: { 'main.js': source },
		})
		const disabled = loader.load({ compatibilityDate: '2026-10-01', mainModule: 'main.js', modules: { 'main.js': source } })
		const [on, off] = await Promise.all([
			enabled.getEntrypoint().fetch('https://crypto.example'),
			disabled.getEntrypoint().fetch('https://crypto.example'),
		])
		expect(await on.json()).toEqual({ enabled: true, supported: true, match: true, nativeInstance: true, supportsKem: true, supports512: false })
		expect(await off.json()).toEqual({ enabled: false, supported: false, error: 'NotSupportedError' })
		expect(await (await enabled.getEntrypoint().fetch('https://crypto.example')).json()).toEqual({
			enabled: true,
			supported: true,
			match: true,
			nativeInstance: true,
			supportsKem: true,
			supports512: false,
		})
	} finally {
		loader.disposeAll()
		rmSync(directory, { recursive: true, force: true })
	}
}, 30000)
