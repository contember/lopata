import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

for (const flag of ['on', 'off']) {
	test(`Vite activates module-level crypto from the primary worker config: flag ${flag}`, async () => {
		const directory = mkdtempSync(join(tmpdir(), 'crypto-modern-vite-'))
		const child = Bun.spawn(['bun', resolve(import.meta.dir, 'fixtures/crypto-modern-vite-runner.ts'), flag], {
			cwd: directory,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		try {
			const output = child.stdout
			const errors = new Response(child.stderr).text()
			const reader = output.getReader()
			let log = ''
			let base: string | undefined
			while (!base) {
				const result = await reader.read()
				if (result.done) throw new Error(`Vite exited before ready:\n${log}\n${await errors}`)
				log += new TextDecoder().decode(result.value)
				const match = /READY (\d+)/.exec(log)
				if (match?.[1]) base = `http://localhost:${match[1]}`
			}
			reader.releaseLock()
			void (async () => {
				for await (const _chunk of output) {}
			})()
			const response = await fetch(`${base}/`)
			expect(response.status).toBe(200)
			const report: unknown = await response.json()
			expect(report).toEqual(
				flag === 'on'
					? { enabled: true, supported: true, match: true, nativeInstance: true }
					: { enabled: false, supported: false, error: 'NotSupportedError' },
			)
		} finally {
			child.kill()
			await child.exited
			rmSync(directory, { recursive: true, force: true })
		}
	}, 30000)
}
