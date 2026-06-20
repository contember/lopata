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

	test('id.name is preserved across the worker → main → DO-worker hop', async () => {
		const res = await fetch(`${base}/counter/alice/name`)
		expect(await res.text()).toBe('alice:alice')
	})

	// A Worker that forwards its incoming request to a DO by re-wrapping it
	// (`stub.fetch(new Request(request, { headers }))`) and the DO reads the body
	// (`await request.json()`) — the idiomatic proxy-to-DO pattern. This deadlocked
	// before: the incoming request body was a JS ReadableStream, and Bun's
	// `new Request(req, init)` clone hangs on such a body. The worker bridge now
	// materializes incoming request bodies so they survive re-wrapping.
	test('a re-wrapped incoming request body survives the worker → DO hop', async () => {
		const res = await fetch(`${base}/echo`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ hello: 'world', n: 42 }),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ echoed: { hello: 'world', n: 42 } })
	})

	// TEST-1: the subrequest budget is enforced on the WORKER side (1c1e263) —
	// the main-side check never trips in thread mode. The budget must
	// accumulate across all binding calls of ONE request (a per-call re-seed of
	// the AsyncLocalStorage context would never trip)…
	test('a request making >1000 binding calls hits the subrequest limit', async () => {
		const res = await fetch(`${base}/spam-rpc?n=1001`)
		expect(res.status).toBe(500)
		expect(await res.text()).toContain('Subrequest limit exceeded')
	}, 30_000)

	// …and must NOT leak between requests: a fresh request starts at zero.
	test('the budget resets per top-level request', async () => {
		const res = await fetch(`${base}/spam-rpc?n=5`)
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('ok')
	})
})
