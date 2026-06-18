import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * TEST-2: a reload must NOT sever in-flight top-level work. `isIdle()` being
 * correct is unit-tested; this proves the GenerationManager drain wiring
 * actually keeps the old generation's worker alive until a slow handler
 * returns and a streamed body finishes.
 */

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/thread-reload-inflight-worker')
const WORKER_SRC = resolve(FIXTURE_DIR, 'src/index.ts')
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

function mutateWorkerSource(from: string, to: string) {
	const content = readFileSync(WORKER_SRC, 'utf-8')
	if (!content.includes(from)) throw new Error(`fixture does not contain "${from}"`)
	writeFileSync(WORKER_SRC, content.replace(from, to))
}

async function waitForVersion(base: string, expected: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			if (await (await fetch(`${base}/version`)).text() === expected) return
		} catch {}
		await new Promise(r => setTimeout(r, 100))
	}
	throw new Error(`/version did not become "${expected}" in ${timeoutMs}ms`)
}

describe('Reload vs in-flight requests (worker-thread runtime)', () => {
	let proc: Subprocess
	let restore: () => void
	const PORT = 18850
	const base = `http://localhost:${PORT}`

	beforeAll(async () => {
		cleanup()
		const original = readFileSync(WORKER_SRC, 'utf-8')
		restore = () => writeFileSync(WORKER_SRC, original)
		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		await waitForServer(`${base}/version`, 20_000)
	}, 25_000)

	afterAll(() => {
		proc?.kill()
		restore?.()
		cleanup()
	})

	test('a streamed response started before a reload completes intact', async () => {
		const count = 10
		const delay = 120
		const res = await fetch(`${base}/slow-stream?count=${count}&delay=${delay}`)
		expect(res.status).toBe(200)
		const reader = res.body!.getReader()
		const decoder = new TextDecoder()
		let text = decoder.decode((await reader.read()).value, { stream: true })

		// First chunk arrived — the old generation is mid-stream. Trigger a reload.
		mutateWorkerSource("'v1'", "'v2'")

		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			if (value) text += decoder.decode(value, { stream: true })
		}
		text += decoder.decode()

		// Body not truncated or reset by the worker swap.
		for (let i = 0; i < count; i++) expect(text).toContain(`chunk-${i};`)

		// And the reload really happened while/after the stream was in flight.
		await waitForVersion(base, 'v2', 10_000)
	}, 20_000)

	test('a slow handler started before a reload still returns its response', async () => {
		const pending = fetch(`${base}/slow-body?ms=1200`)
		await new Promise(r => setTimeout(r, 200)) // handler is running, no Response yet
		mutateWorkerSource('slow-done-v1', 'slow-done-v2')

		// Old generation must serve the original code's response, undisturbed.
		const res = await pending
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('slow-done-v1')

		// The new generation serves the new code.
		const deadline = Date.now() + 10_000
		let fresh = ''
		while (Date.now() < deadline) {
			fresh = await (await fetch(`${base}/slow-body?ms=10`)).text()
			if (fresh === 'slow-done-v2') break
			await new Promise(r => setTimeout(r, 100))
		}
		expect(fresh).toBe('slow-done-v2')
	}, 20_000)
})
