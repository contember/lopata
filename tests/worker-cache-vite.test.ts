import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execPath } from 'node:process'

describe('Vite Workers Cache execution-context accounting', () => {
	let process: Subprocess
	let dir: string
	let base: string
	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'worker-cache-vite-'))
		process = Bun.spawn([execPath, resolve(import.meta.dir, 'fixtures/worker-cache-vite-runner.ts')], {
			cwd: dir,
			stdout: 'pipe',
			stderr: 'inherit',
		})
		const output = process.stdout
		if (!output || typeof output === 'number') throw new Error('Missing runner stdout')
		const reader = output.getReader()
		let log = ''
		while (true) {
			const result = await reader.read()
			if (result.done) throw new Error(`Vite exited before ready: ${log}`)
			log += new TextDecoder().decode(result.value)
			const match = /READY (\d+)/.exec(log)
			if (match) {
				base = `http://localhost:${match[1]}`
				break
			}
		}
		reader.releaseLock()
		void (async () => {
			for await (const _chunk of output) {}
		})()
	}, 30_000)
	afterAll(() => {
		process?.kill()
		if (dir) rmSync(dir, { recursive: true, force: true })
	})
	const get = (path: string) => fetch(base + path)
	const accounting = async () => {
		const value: unknown = await (await get('/__accounting')).json()
		if (!value || typeof value !== 'object' || !('drainedRegistrations' in value) || typeof value.drainedRegistrations !== 'number') {
			throw new Error('Invalid accounting response')
		}
		return value.drainedRegistrations
	}

	test('middleware drains the context that registered handler waitUntil work', async () => {
		expect(await (await get('/wait-until')).text()).toBe('queued')
		expect(await accounting()).toBe(1)
		const deadline = Date.now() + 2000
		while (true) {
			const state: unknown = await (await get('/state')).json()
			if (state && typeof state === 'object' && 'completed' in state && state.completed === 1) break
			if (Date.now() > deadline) throw new Error('Background work did not complete')
			await Bun.sleep(20)
		}
	})

	test('SWR returns stale immediately and registers its refresh on the drained middleware context', async () => {
		const before = await accounting()
		expect(await (await get('/page')).text()).toBe('1')
		const stale = await get('/page')
		expect(stale.headers.get('cf-cache-status')).toBe('UPDATING')
		expect(await stale.text()).toBe('1')
		expect(await accounting()).toBe(before + 1)
		await Bun.sleep(150)
		expect(await (await get('/page')).text()).toBe('2')
	})

	test('Vite imported cache purges the active entrypoint cache', async () => {
		expect(await (await get('/purge')).json()).toEqual({ success: true, errors: [] })
		const response = await get('/page')
		expect(response.headers.get('cf-cache-status')).toBe('MISS')
		await response.text()
	})

	test('Vite imported and context invalidate retain validators and the cached body', async () => {
		expect(await (await get('/validated')).text()).toBe('validated')
		for (const path of ['/invalidate', '/invalidate-ctx']) {
			expect(await (await get(path)).json()).toEqual({ success: true, errors: [] })
			const revalidated = await get('/validated')
			expect(revalidated.headers.get('cf-cache-status')).toBe('REVALIDATED')
			expect(await revalidated.text()).toBe('validated')
			const hit = await get('/validated')
			expect(hit.headers.get('cf-cache-status')).toBe('HIT')
			expect(await hit.text()).toBe('validated')
		}
	})
})
