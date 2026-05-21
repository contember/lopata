import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/thread-do-worker')
const CLI_PATH = resolve(import.meta.dir, '../src/cli.ts')

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			await fetch(url)
			return
		} catch {
			await new Promise(r => setTimeout(r, 200))
		}
	}
	throw new Error(`Server ${url} did not become ready in ${timeoutMs}ms`)
}

function cleanup() {
	try {
		rmSync(resolve(FIXTURE_DIR, '.lopata'), { recursive: true, force: true })
	} catch {}
}

describe('Durable Objects (worker-thread runtime)', () => {
	let proc: Subprocess
	const PORT = 18804
	const base = `http://localhost:${PORT}`

	beforeAll(async () => {
		cleanup()
		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		await waitForServer(`${base}/counter/probe/get`, 20_000)
	}, 25_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	test('DO stub fetch routes worker → main → isolated DO worker', async () => {
		expect(await (await fetch(`${base}/counter/alice/inc`)).text()).toBe('alice:1')
		expect(await (await fetch(`${base}/counter/alice/inc`)).text()).toBe('alice:2')
		expect(await (await fetch(`${base}/counter/alice/get`)).text()).toBe('alice:2')
	})

	test('different ids resolve to different DO instances', async () => {
		expect(await (await fetch(`${base}/counter/bob/inc`)).text()).toBe('bob:1')
		expect(await (await fetch(`${base}/counter/alice/get`)).text()).toBe('alice:2')
	})

	test('DO RPC method calls round-trip across the bridge', async () => {
		const res = await fetch(`${base}/greet/charlie`)
		expect((await res.text()).startsWith('hello charlie from ')).toBe(true)
	})
})
