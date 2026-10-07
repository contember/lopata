import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

describe('class constructor cache context in worker-thread events', () => {
	let proc: Subprocess
	let dir: string
	let base: string
	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'worker-cache-constructor-'))
		proc = Bun.spawn(['bun', resolve(import.meta.dir, 'fixtures/worker-cache-runner.ts')], {
			cwd: dir,
			env: { ...Bun.env, CONSTRUCTOR_WORKER: 'true' },
			stdout: 'pipe',
			stderr: 'inherit',
		})
		const stdout = proc.stdout
		if (!stdout || typeof stdout === 'number') throw new Error('Missing runner output')
		const reader = stdout.getReader()
		let log = ''
		while (true) {
			const result = await reader.read()
			if (result.done) throw new Error(`Runner exited: ${log}`)
			log += new TextDecoder().decode(result.value)
			const match = /READY (\d+)/.exec(log)
			if (match) {
				base = `http://localhost:${match[1]}`
				break
			}
		}
		reader.releaseLock()
		void (async () => {
			for await (const _chunk of stdout) {}
		})()
	}, 20_000)
	afterAll(() => {
		proc?.kill()
		if (dir) rmSync(dir, { recursive: true, force: true })
	})
	for (const path of ['/__scheduled', '/__email']) {
		test(`${path} constructs the class inside the active default-entrypoint scope`, async () => {
			const response = await fetch(base + path)
			expect(response.status).toBe(200)
			expect(await response.json()).toEqual({ ok: true })
		})
	}
})
