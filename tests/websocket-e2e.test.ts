import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { rmSync } from 'node:fs'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/ws-worker')
const CLI_PATH = resolve(import.meta.dir, '../src/cli.ts')
const VITE_BIN = resolve(import.meta.dir, '../node_modules/.bin/vite')

// ─── Helpers ────────────────────────────────────────────────────────────

interface WSClient {
	ws: WebSocket
	waitForMessage(timeout?: number): Promise<string | ArrayBuffer>
	waitForClose(timeout?: number): Promise<{ code: number; reason: string }>
	send(data: string | ArrayBuffer | ArrayBufferLike): void
	close(code?: number, reason?: string): void
}

async function startStandaloneServer(port: number): Promise<Subprocess> {
	const proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(port)], {
		cwd: FIXTURE_DIR,
		stdout: 'pipe',
		stderr: 'pipe',
	})

	await waitForOutput(proc, 'Server running', 15_000)
	return proc
}

async function startViteServer(port: number): Promise<Subprocess> {
	const proc = Bun.spawn(['bun', '--bun', VITE_BIN, 'dev', '--port', String(port)], {
		cwd: FIXTURE_DIR,
		stdout: 'pipe',
		stderr: 'pipe',
	})

	await waitForOutput(proc, 'Local:', 30_000)
	// Small delay for Vite to finish initialization
	await new Promise(r => setTimeout(r, 500))
	return proc
}

async function waitForOutput(proc: Subprocess, marker: string, timeoutMs: number): Promise<void> {
	const decoder = new TextDecoder()
	let output = ''
	const deadline = Date.now() + timeoutMs
	let resolved = false

	// Read both stdout and stderr concurrently — Vite prints to both
	const readStream = async (stream: ReadableStream<Uint8Array>) => {
		const reader = stream.getReader()
		try {
			while (!resolved) {
				const result = await Promise.race([
					reader.read(),
					new Promise<{ done: true; value: undefined }>(r =>
						setTimeout(() => r({ done: true, value: undefined }), Math.max(0, deadline - Date.now())),
					),
				])
				if (result.done) break
				if (result.value) {
					output += decoder.decode(result.value)
				}
				if (output.includes(marker)) {
					resolved = true
					return
				}
			}
		} finally {
			reader.releaseLock()
		}
	}

	await Promise.race([
		Promise.all([readStream(proc.stdout!), readStream(proc.stderr!)]),
		new Promise<void>((_, reject) =>
			setTimeout(() => reject(new Error(`Server did not produce "${marker}" within ${timeoutMs}ms. Output:\n${output}`)), timeoutMs),
		),
	])

	if (!resolved) {
		proc.kill()
		throw new Error(`Server did not produce "${marker}" within ${timeoutMs}ms. Output:\n${output}`)
	}
}

async function connectWS(url: string, timeout = 5000): Promise<WSClient> {
	return new Promise<WSClient>((resolve, reject) => {
		const messageQueue: (string | ArrayBuffer)[] = []
		const messageWaiters: Array<(msg: string | ArrayBuffer) => void> = []
		const closeWaiters: Array<(ev: { code: number; reason: string }) => void> = []

		const ws = new WebSocket(url)
		ws.binaryType = 'arraybuffer'

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
				messageWaiters.shift()!(ev.data)
			} else {
				messageQueue.push(ev.data)
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

// ─── Test suites ────────────────────────────────────────────────────────

function defineWebSocketTests(port: number) {
	const base = `ws://localhost:${port}`
	const httpBase = `http://localhost:${port}`

	describe('Plain worker WebSocket', () => {
		test('upgrade establishes connection', async () => {
			const client = await connectWS(`${base}/ws/plain`)
			expect(client.ws.readyState).toBe(WebSocket.OPEN)
			client.close()
		})

		test('echo string message', async () => {
			const client = await connectWS(`${base}/ws/plain`)
			client.send('hello')
			const msg = await client.waitForMessage()
			expect(msg).toBe('echo:hello')
			client.close()
		})

		test('echo binary message (ArrayBuffer)', async () => {
			const client = await connectWS(`${base}/ws/plain`)
			const data = new Uint8Array([1, 2, 3, 4])
			client.send(data.buffer)
			const msg = await client.waitForMessage()
			expect(new Uint8Array(msg as ArrayBuffer)).toEqual(data)
			client.close()
		})

		test('server-initiated message', async () => {
			const client = await connectWS(`${base}/ws/plain-server-push`)
			const msg = await client.waitForMessage()
			expect(msg).toBe('hello-from-server')
			client.close()
		})

		test('close from client', async () => {
			const client = await connectWS(`${base}/ws/plain`)
			const closePromise = client.waitForClose()
			client.close(1000, 'done')
			const ev = await closePromise
			expect(ev.code).toBe(1000)
		})

		test('close from server', async () => {
			const client = await connectWS(`${base}/ws/plain-server-close`)
			const closePromise = client.waitForClose()
			client.send('close-me')
			const ev = await closePromise
			expect(ev.code).toBe(4000)
			expect(ev.reason).toBe('server-closed')
		})
	})

	describe('DO Standard API', () => {
		test('upgrade to DO establishes connection', async () => {
			const client = await connectWS(`${base}/ws/do-standard/std-conn-test`)
			expect(client.ws.readyState).toBe(WebSocket.OPEN)
			client.close()
		})

		test('echo via addEventListener', async () => {
			const client = await connectWS(`${base}/ws/do-standard/std-echo-test`)
			client.send('hello-do')
			const msg = await client.waitForMessage()
			expect(msg).toBe('echo:hello-do')
			client.close()
		})

		test('broadcast to multiple connections', async () => {
			const doName = 'std-broadcast-test'
			const client1 = await connectWS(`${base}/ws/do-standard/${doName}`)
			const client2 = await connectWS(`${base}/ws/do-standard/${doName}`)

			// Give connections time to register
			await new Promise(r => setTimeout(r, 200))

			await fetch(`${httpBase}/ws/do-standard/${doName}/broadcast`, {
				method: 'POST',
				body: 'hello-all',
			})

			const msg1 = await client1.waitForMessage()
			const msg2 = await client2.waitForMessage()
			expect(msg1).toBe('broadcast:hello-all')
			expect(msg2).toBe('broadcast:hello-all')

			client1.close()
			client2.close()
		})

		test('close propagation', async () => {
			const client = await connectWS(`${base}/ws/do-standard/std-close-test`)
			const closePromise = client.waitForClose()
			client.close(1000, 'goodbye')
			const ev = await closePromise
			expect(ev.code).toBe(1000)
		})
	})

	describe('DO Hibernation API', () => {
		test('upgrade establishes connection', async () => {
			const client = await connectWS(`${base}/ws/do-hibernation/hib-conn-test`)
			expect(client.ws.readyState).toBe(WebSocket.OPEN)
			client.close()
		})

		test('echo via webSocketMessage handler', async () => {
			const client = await connectWS(`${base}/ws/do-hibernation/hib-echo-test`)
			client.send('hello-hib')
			const msg = await client.waitForMessage()
			expect(msg).toBe('echo:hello-hib')
			client.close()
		})

		test('auto-response (ping → pong) skips handler', async () => {
			const doName = 'hib-auto-resp-test'
			// Configure auto-response via HTTP
			await fetch(`${httpBase}/ws/do-hibernation/${doName}/setup-auto-response`)

			const client = await connectWS(`${base}/ws/do-hibernation/${doName}`)

			// Auto-response
			client.send('ping')
			const pong = await client.waitForMessage()
			expect(pong).toBe('pong')

			// Non-matching still goes to handler
			client.send('hello')
			const echo = await client.waitForMessage()
			expect(echo).toBe('echo:hello')

			client.close()
		})

		test('serializeAttachment / deserializeAttachment', async () => {
			const client = await connectWS(`${base}/ws/do-hibernation/hib-attach-test`)

			client.send('set-attachment:mydata')
			const ack = await client.waitForMessage()
			expect(ack).toBe('attachment-set')

			client.send('get-attachment')
			const msg = await client.waitForMessage()
			expect(msg).toBe('attachment:{"value":"mydata"}')

			client.close()
		})

		test('binary echo via hibernation handler', async () => {
			const client = await connectWS(`${base}/ws/do-hibernation/hib-binary-test`)
			const data = new Uint8Array([10, 20, 30])
			client.send(data.buffer)
			const msg = await client.waitForMessage()
			expect(new Uint8Array(msg as ArrayBuffer)).toEqual(data)
			client.close()
		})

		test('getWebSockets returns active connections', async () => {
			const doName = 'hib-count-test'
			const client1 = await connectWS(`${base}/ws/do-hibernation/${doName}`)
			const client2 = await connectWS(`${base}/ws/do-hibernation/${doName}`)

			await new Promise(r => setTimeout(r, 200))

			const res1 = await fetch(`${httpBase}/ws/do-hibernation/${doName}/count`)
			expect(await res1.text()).toBe('2')

			client1.close()
			await new Promise(r => setTimeout(r, 200))

			const res2 = await fetch(`${httpBase}/ws/do-hibernation/${doName}/count`)
			expect(await res2.text()).toBe('1')

			client2.close()
		})

		test('tags filter getWebSockets and broadcast', async () => {
			const doName = 'hib-tag-test'
			const clientA1 = await connectWS(`${base}/ws/do-hibernation/${doName}?tag=room:a`)
			const clientB1 = await connectWS(`${base}/ws/do-hibernation/${doName}?tag=room:b`)
			const clientA2 = await connectWS(`${base}/ws/do-hibernation/${doName}?tag=room:a`)

			await new Promise(r => setTimeout(r, 200))

			// Verify count by tag
			const countA = await fetch(`${httpBase}/ws/do-hibernation/${doName}/count?tag=room:a`)
			expect(await countA.text()).toBe('2')

			const countB = await fetch(`${httpBase}/ws/do-hibernation/${doName}/count?tag=room:b`)
			expect(await countB.text()).toBe('1')

			// Broadcast to room:a only
			await fetch(`${httpBase}/ws/do-hibernation/${doName}/broadcast?tag=room:a`, {
				method: 'POST',
				body: 'hello-a',
			})

			const msgA1 = await clientA1.waitForMessage()
			const msgA2 = await clientA2.waitForMessage()
			expect(msgA1).toBe('broadcast:hello-a')
			expect(msgA2).toBe('broadcast:hello-a')

			// client B should not receive
			try {
				await clientB1.waitForMessage(500)
				expect.unreachable('client B should not receive room:a broadcast')
			} catch (e) {
				expect((e as Error).message).toContain('Timeout')
			}

			clientA1.close()
			clientB1.close()
			clientA2.close()
		})

		test('close triggers webSocketClose handler', async () => {
			const client = await connectWS(`${base}/ws/do-hibernation/hib-close-test`)
			const closePromise = client.waitForClose()
			client.close(1000, 'bye')
			const ev = await closePromise
			expect(ev.code).toBe(1000)
		})
	})
}

// ─── Standalone mode ────────────────────────────────────────────────────

describe('WebSocket E2E — standalone', () => {
	let proc: Subprocess
	const PORT = 18787

	beforeAll(async () => {
		cleanup()
		proc = await startStandaloneServer(PORT)
	}, 20_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	defineWebSocketTests(PORT)
})

// ─── Vite mode ──────────────────────────────────────────────────────────

describe('WebSocket E2E — vite', () => {
	let proc: Subprocess

	const PORT = 18788

	beforeAll(async () => {
		cleanup()
		proc = await startViteServer(PORT)
	}, 45_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	defineWebSocketTests(PORT)
})
