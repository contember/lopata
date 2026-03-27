import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/ws-hmr-worker')
const WORKER_SRC = resolve(FIXTURE_DIR, 'src/index.ts')
const CLI_PATH = resolve(import.meta.dir, '../src/cli.ts')

// ─── Output reader ──────────────────────────────────────────────────────

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

	mark(): void {
		this.markPos = this.output.length
	}

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

interface WSClient {
	ws: WebSocket
	waitForMessage(timeout?: number): Promise<string>
	waitForClose(timeout?: number): Promise<{ code: number; reason: string }>
	send(data: string): void
	close(code?: number, reason?: string): void
}

async function connectWS(url: string, timeout = 5000): Promise<WSClient> {
	return new Promise<WSClient>((resolve, reject) => {
		const messageQueue: string[] = []
		const messageWaiters: Array<(msg: string) => void> = []
		const closeWaiters: Array<(ev: { code: number; reason: string }) => void> = []

		const ws = new WebSocket(url)

		const timer = setTimeout(() => {
			ws.close()
			reject(new Error(`WebSocket connection to ${url} timed out`))
		}, timeout)

		ws.onopen = () => {
			clearTimeout(timer)
			resolve({
				ws,
				waitForMessage(msgTimeout = 5000) {
					if (messageQueue.length > 0) {
						return Promise.resolve(messageQueue.shift()!)
					}
					return new Promise((res, rej) => {
						const t = setTimeout(() => rej(new Error('Timeout waiting for WS message')), msgTimeout)
						messageWaiters.push((msg) => {
							clearTimeout(t)
							res(msg)
						})
					})
				},
				waitForClose(closeTimeout = 5000) {
					return new Promise((res, rej) => {
						const t = setTimeout(() => rej(new Error('Timeout waiting for WS close')), closeTimeout)
						closeWaiters.push((ev) => {
							clearTimeout(t)
							res(ev)
						})
					})
				},
				send(data) {
					ws.send(data)
				},
				close(code, reason) {
					ws.close(code, reason)
				},
			})
		}

		ws.onmessage = (ev) => {
			if (messageWaiters.length > 0) {
				messageWaiters.shift()!(ev.data as string)
			} else {
				messageQueue.push(ev.data as string)
			}
		}

		ws.onclose = (ev) => {
			if (closeWaiters.length > 0) {
				closeWaiters.shift()!({ code: ev.code, reason: ev.reason })
			}
		}

		ws.onerror = () => {
			clearTimeout(timer)
			reject(new Error(`WebSocket connection to ${url} failed`))
		}
	})
}

function cleanup() {
	try {
		rmSync(resolve(FIXTURE_DIR, '.lopata'), { recursive: true, force: true })
	} catch {}
}

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

describe('WebSocket HMR E2E — standalone', () => {
	let proc: Subprocess
	let output: OutputReader
	let restore: () => void
	const PORT = 18799

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

	test('WebSocket survives reload and routes to new code', async () => {
		// Connect WebSocket and verify v1
		const client = await connectWS(`ws://localhost:${PORT}/ws/test-do`)
		client.send('hello')
		const msgV1 = await client.waitForMessage()
		expect(msgV1).toBe('v1:hello')

		// Mutate source: v1 → v2
		output.mark()
		mutateWorkerSource("VERSION = 'v1'", "VERSION = 'v2'")
		await output.waitForNew('Reloaded', 10_000)

		// Same WebSocket should now get v2 responses
		client.send('hello')
		const msgV2 = await client.waitForMessage()
		expect(msgV2).toBe('v2:hello')

		// Verify HTTP also sees v2
		const res = await fetch(`http://localhost:${PORT}/version`)
		expect(await res.text()).toBe('v2')

		client.close()
	}, 20_000)

	test('second reload also preserves WebSocket', async () => {
		const client = await connectWS(`ws://localhost:${PORT}/ws/test-do-2`)
		client.send('ping')
		const msg1 = await client.waitForMessage()
		expect(msg1).toBe('v2:ping')

		// v2 → v3
		output.mark()
		mutateWorkerSource("VERSION = 'v2'", "VERSION = 'v3'")
		await output.waitForNew('Reloaded', 10_000)

		client.send('ping')
		const msg2 = await client.waitForMessage()
		expect(msg2).toBe('v3:ping')

		client.close()
	}, 20_000)
})
