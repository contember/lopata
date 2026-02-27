import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/hmr-worker')
const WORKER_SRC = resolve(FIXTURE_DIR, 'src/index.ts')
const CLI_PATH = resolve(import.meta.dir, '../src/cli.ts')
const VITE_BIN = resolve(import.meta.dir, '../node_modules/.bin/vite')

// ─── Output reader ──────────────────────────────────────────────────────

/**
 * Continuously reads stdout+stderr from a subprocess, allows waiting
 * for markers that appear at any point during the process lifetime.
 * Supports position-based scoping via mark()/waitForAfterMark().
 */
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
					this.checkWaiters()
				}
			}
		} finally {
			reader.releaseLock()
		}
	}

	private checkWaiters() {
		this.waiters = this.waiters.filter((w) => {
			if (w.check()) {
				w.resolve()
				return false
			}
			return true
		})
	}

	/** Wait for marker in the full output. */
	async waitFor(marker: string, timeoutMs: number): Promise<void> {
		if (this.output.includes(marker)) return
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`Timeout waiting for "${marker}" within ${timeoutMs}ms.\nOutput:\n${this.output}`))
			}, timeoutMs)
			this.waiters.push({
				check: () => this.output.includes(marker),
				resolve: () => {
					clearTimeout(timer)
					resolve()
				},
			})
		})
	}

	/** Save current output position — subsequent waitForNew() checks only output after this point. */
	mark(): void {
		this.markPos = this.output.length
	}

	/** Wait for marker to appear in output produced AFTER the last mark(). */
	async waitForNew(marker: string, timeoutMs: number): Promise<void> {
		const check = () => this.output.indexOf(marker, this.markPos) !== -1
		if (check()) return
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(
					new Error(
						`Timeout waiting for new "${marker}" within ${timeoutMs}ms.\nOutput since mark:\n${this.output.slice(this.markPos)}`,
					),
				)
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

// ─── Helpers ────────────────────────────────────────────────────────────

function cleanup() {
	try {
		rmSync(resolve(FIXTURE_DIR, '.lopata'), { recursive: true, force: true })
	} catch {}
}

/** Save original source, return restore function. */
function backupFile(filePath: string): () => void {
	const original = readFileSync(filePath, 'utf-8')
	return () => writeFileSync(filePath, original)
}

function mutateWorkerSource(from: string, to: string) {
	const content = readFileSync(WORKER_SRC, 'utf-8')
	if (!content.includes(from)) {
		throw new Error(`Worker source does not contain "${from}"`)
	}
	writeFileSync(WORKER_SRC, content.replace(from, to))
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('HMR E2E — standalone', () => {
	let proc: Subprocess
	let output: OutputReader
	let restore: () => void
	const PORT = 18797

	beforeAll(async () => {
		cleanup()
		restore = backupFile(WORKER_SRC)

		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		output = new OutputReader(proc)

		await output.waitFor('Server running', 15_000)
	}, 20_000)

	afterAll(() => {
		proc?.kill()
		restore?.()
		cleanup()
	})

	test('initial response is v1', async () => {
		const res = await fetch(`http://localhost:${PORT}/version`)
		expect(await res.text()).toBe('v1')
	})

	test('after file change, response updates to v2', async () => {
		output.mark()
		mutateWorkerSource("'v1'", "'v2'")

		await output.waitForNew('Reloaded', 10_000)

		const res = await fetch(`http://localhost:${PORT}/version`)
		expect(await res.text()).toBe('v2')
	}, 15_000)

	test('second change updates to v3', async () => {
		output.mark()
		mutateWorkerSource("'v2'", "'v3'")

		await output.waitForNew('Reloaded', 10_000)

		const res = await fetch(`http://localhost:${PORT}/version`)
		expect(await res.text()).toBe('v3')
	}, 15_000)
})

describe('HMR E2E — vite', () => {
	let proc: Subprocess
	let output: OutputReader
	let restore: () => void
	const PORT = 18798

	beforeAll(async () => {
		cleanup()
		restore = backupFile(WORKER_SRC)

		proc = Bun.spawn(['bun', '--bun', VITE_BIN, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		output = new OutputReader(proc)

		// Vite prints "Local:" when ready
		await output.waitFor('Local:', 60_000)
		// Worker module loads lazily on first request — warm it up
		await fetch(`http://localhost:${PORT}/version`)
		await output.waitFor('Worker module (re)loaded', 30_000)
	}, 120_000)

	afterAll(() => {
		proc?.kill()
		restore?.()
		cleanup()
	})

	test('initial response is v1', async () => {
		const res = await fetch(`http://localhost:${PORT}/version`)
		expect(await res.text()).toBe('v1')
	})

	test('after file change, response updates to v2', async () => {
		output.mark()
		mutateWorkerSource("'v1'", "'v2'")

		// Vite invalidates the module (lazy — reload happens on next request)
		await output.waitForNew('page reload', 10_000)

		// Request triggers ensureWorkerModule() → re-import
		const res = await fetch(`http://localhost:${PORT}/version`)
		expect(await res.text()).toBe('v2')
	}, 20_000)

	test('second change updates to v3', async () => {
		// Let the watcher settle after previous change
		await new Promise((r) => setTimeout(r, 500))

		output.mark()
		mutateWorkerSource("'v2'", "'v3'")

		await output.waitForNew('page reload', 10_000)

		const res = await fetch(`http://localhost:${PORT}/version`)
		expect(await res.text()).toBe('v3')
	}, 20_000)
})
