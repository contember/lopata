import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

for (const crossVersion of [false, true]) {
	describe(`Workers Cache thread dispatch (cross-version ${crossVersion})`, () => {
		let process: Subprocess
		let dir: string
		let base: string
		beforeAll(async () => {
			dir = mkdtempSync('/tmp/opencode/worker-cache-')
			process = Bun.spawn(['bun', resolve(import.meta.dir, 'fixtures/worker-cache-runner.ts')], {
				cwd: dir,
				env: { ...Bun.env, CROSS_VERSION: String(crossVersion) },
				stdout: 'pipe',
				stderr: 'inherit',
			})
			if (!process.stdout || typeof process.stdout === 'number') throw new Error('Missing subprocess stdout')
			const reader = process.stdout.getReader()
			let output = ''
			while (true) {
				const result = await reader.read()
				if (result.done) throw new Error(`Runtime exited before ready: ${output}`)
				output += new TextDecoder().decode(result.value)
				const match = /READY (\d+)/.exec(output)
				if (match) {
					base = `http://localhost:${match[1]}`
					break
				}
			}
			reader.releaseLock()
		}, 20_000)
		afterAll(() => {
			process?.kill()
			if (dir) rmSync(dir, { recursive: true, force: true })
		})
		const text = async (path: string, init?: RequestInit) => (await fetch(base + path, init)).text()

		test('loopback caches by props and named service fetch shares the target cache', async () => {
			const first = await text('/loop?tenant=public')
			expect(await text('/loop?tenant=public')).toBe(first)
			expect(await text('/service')).toBe(first)
			expect(await text('/loop?tenant=other')).not.toBe(first)
		})
		test('imported cache in named RPC purges its entrypoint, default purge does not', async () => {
			const first = await text('/loop?tenant=public')
			await text('/purge-default')
			expect(await text('/loop?tenant=public')).toBe(first)
			expect(await (await fetch(base + '/purge')).json()).toEqual({ success: true, errors: [] })
			expect(await text('/loop?tenant=public')).not.toBe(first)
		})
		test('per-entrypoint disable keeps gateway running and custom cf keys survive loopback dispatch', async () => {
			expect(await text('/direct')).not.toBe(await text('/direct'))
			const first = await text('/one?key=canonical')
			expect(await text('/two?key=canonical')).toBe(first)
		})
		test('reload is cold by default and warm with cross_version_cache', async () => {
			const first = await text('/loop?tenant=public')
			await text('/__reload')
			const response = await fetch(base + '/loop?tenant=public')
			expect(response.headers.get('cf-cache-status')).toBe(crossVersion ? 'HIT' : 'MISS')
			if (crossVersion) expect(await response.text()).toBe(first)
			else await response.text()
		})
		test('HEAD populates a GET entry and Set-Cookie remains lossless across both bridges', async () => {
			const head = await fetch(base + '/head', { method: 'HEAD' })
			expect(await head.text()).toBe('')
			const response = await fetch(base + '/head')
			expect(response.headers.get('cf-cache-status')).toBe('HIT')
			await response.text()
			const cookies = await fetch(base + '/cookies')
			expect(cookies.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
			await cookies.text()
		})
		test('SWR returns stale before the delayed refresh completes', async () => {
			const first = await text('/swr')
			const response = await fetch(base + '/swr')
			expect(response.headers.get('cf-cache-status')).toBe('UPDATING')
			expect(await response.text()).toBe(first)
		})
		test('unbounded streams return headers and chunks and can be cancelled', async () => {
			const controller = new AbortController()
			const response = await fetch(base + '/stream', { signal: controller.signal })
			const reader = response.body?.getReader()
			expect(new TextDecoder().decode((await reader?.read())?.value)).toBe('first')
			controller.abort()
			await reader?.cancel().catch(() => {})
		})
		test('real queue deliveries attach ctx.cache, imported cache and loopback exports', async () => {
			const before = await text('/loop?tenant=public')
			expect(await text('/queue-purge')).toBe('queued')
			const deadline = Date.now() + 4000
			while (await text('/queue-receipt') !== 'ok') {
				if (Date.now() >= deadline) throw new Error('Queue cache purge did not complete')
				await Bun.sleep(50)
			}
			const next = await fetch(base + '/loop?tenant=public')
			expect(next.headers.get('cf-cache-status')).toBe('MISS')
			expect(await next.text()).not.toBe(before)
		})
	})
}
