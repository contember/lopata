import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

describe('Vite Workers Cache pass-through and execution-context accounting', () => {
	let process: Subprocess
	let dir: string
	let base: string
	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'worker-cache-vite-'))
		process = Bun.spawn(['bun', resolve(import.meta.dir, 'fixtures/worker-cache-vite-runner.ts')], {
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

	test('requests pass through and imported and context purge operations resolve', async () => {
		const first = Number(await (await get('/page')).text())
		expect(Number(await (await get('/page')).text())).toBe(first + 1)
		const resolved = { success: true, errors: [] }
		expect(await (await get('/purge')).json()).toEqual([resolved, resolved])
	})
})
