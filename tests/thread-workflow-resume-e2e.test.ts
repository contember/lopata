import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * CORR-1 e2e: rapid reloads leave several older generations in overlapping
 * grace windows. Workflow resume must wait until EVERY older generation is
 * stopped — resuming as soon as the first one finishes would re-execute an
 * instance another (still-alive) generation is mid-step on, duplicating its
 * side effects.
 *
 * Repro shape: generation 1 is pinned non-idle by an open streamed body while
 * it runs a slow workflow step; two reloads land while the step is in flight,
 * and generation 2 is pinned briefly too so its drain finishes via the
 * waitUntilIdle poll (i.e. AFTER generation 3 became the active one — an
 * instantly-idle generation 2 would finish synchronously inside the reload,
 * before _activeGenId moves, and mask the race). Releasing generation 2's pin
 * pre-fix triggered resumeInterrupted on generation 3 while generation 1 was
 * still executing the same instance (its DB row still 'running'), so the step
 * callback ran twice. The fixture records one marker per step-callback
 * execution; verified to fail (runs=2) without the resume gate.
 */

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/thread-workflow-resume-worker')
const WORKER_SRC = resolve(FIXTURE_DIR, 'src/index.ts')
const CLI_PATH = resolve(import.meta.dir, '../src/cli.ts')

class OutputReader {
	private output = ''
	private markPos = 0
	private waiters: Array<{ check: () => boolean; resolve: () => void }> = []

	constructor(proc: Subprocess) {
		this.readStream(proc.stdout as ReadableStream<Uint8Array>)
		this.readStream(proc.stderr as ReadableStream<Uint8Array>)
	}

	private async readStream(stream: ReadableStream<Uint8Array>) {
		const decoder = new TextDecoder()
		const reader = stream.getReader()
		try {
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				if (value) {
					this.output += decoder.decode(value)
					this.waiters = this.waiters.filter(w => {
						if (w.check()) {
							w.resolve()
							return false
						}
						return true
					})
				}
			}
		} finally {
			reader.releaseLock()
		}
	}

	mark(): void {
		this.markPos = this.output.length
	}

	async waitForNew(marker: string, timeoutMs: number): Promise<void> {
		const check = () => this.output.indexOf(marker, this.markPos) !== -1
		if (check()) return
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`Timeout waiting for new "${marker}" within ${timeoutMs}ms.\nOutput since mark:\n${this.output.slice(this.markPos)}`))
			}, timeoutMs)
			this.waiters.push({
				check,
				resolve: () => {
					clearTimeout(timer)
					resolve()
				},
			})
		})
	}
}

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

describe('Workflow resume vs overlapping reload grace windows', () => {
	let proc: Subprocess
	let output: OutputReader
	let restore: () => void
	const PORT = 18851
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
		output = new OutputReader(proc)
		await waitForServer(`${base}/version`, 20_000)
	}, 25_000)

	afterAll(() => {
		proc?.kill()
		restore?.()
		cleanup()
	})

	test('a running workflow is not duplicated when two reloads land mid-step', async () => {
		// Pin generation 1 non-idle: hold a streamed body open for the whole test.
		// (Abort the request to release it — cancelling just the body reader
		// doesn't close the HTTP connection, so the server would keep streaming.)
		const sse1Abort = new AbortController()
		const sse1 = await fetch(`${base}/sse`, { signal: sse1Abort.signal })
		await sse1.body!.getReader().read() // 'open' — the stream is registered

		// Start the slow workflow on generation 1 (step holds for ~5s).
		const id = await (await fetch(`${base}/start?ms=5000`)).text()
		expect(id).toMatch(/^wf-/)

		// Reload A → generation 2 becomes active while generation 1 drains in
		// its grace window (pinned by sse1, still mid-step).
		output.mark()
		mutateWorkerSource("'v1'", "'v2'")
		await output.waitForNew('Reloaded', 10_000)

		// Pin generation 2 too — its drain must finish ASYNCHRONOUSLY (via the
		// waitUntilIdle poll, after _activeGenId points at generation 3). An
		// instantly-idle generation 2 would run finish() synchronously inside
		// reload B while `this.active` is still generation 2 itself, masking
		// the race this test exists for.
		const sse2Abort = new AbortController()
		const sse2 = await fetch(`${base}/sse`, { signal: sse2Abort.signal })
		await sse2.body!.getReader().read()

		// Reload B → generation 3 active; generations 1 AND 2 are now in
		// overlapping grace windows.
		output.mark()
		mutateWorkerSource("'v2'", "'v3'")
		await output.waitForNew('Reloaded', 10_000)

		// Release generation 2's pin: its finish() fires while generation 1 is
		// still mid-step. Pre-fix this resumed the still-running instance on
		// generation 3 — a second concurrent execution of the same workflow.
		await new Promise(r => setTimeout(r, 300))
		sse2Abort.abort()

		// Let the workflow finish in generation 1 (still alive thanks to sse1).
		const deadline = Date.now() + 20_000
		let status = ''
		while (Date.now() < deadline) {
			const body = await (await fetch(`${base}/status/${id}`)).json() as { status: string }
			status = body.status
			if (status === 'complete' || status === 'errored' || status === 'terminated') break
			await new Promise(r => setTimeout(r, 100))
		}
		expect(status).toBe('complete')

		// Release generation 1 so it can drain; the deferred (now no-op) resume fires.
		sse1Abort.abort()
		await new Promise(r => setTimeout(r, 700))

		// The step callback must have executed exactly once — a second marker
		// means the instance ran in two worker threads concurrently.
		const runs = await (await fetch(`${base}/runs`)).text()
		expect(runs).toBe('1')
	}, 60_000)
})
