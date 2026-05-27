/**
 * End-to-end coverage for env-binding WS upgrade returned to a DO instance.
 *
 * Path: client → main worker → BridgeDO (env.BRIDGE) → DO.fetch() → DO calls
 *       this.env.AUX.fetch('/ws/...') → upstream worker returns
 *       Response{status:101, webSocket} → DO receives a usable CFWebSocket and
 *       bridges it to the client.
 *
 * This exercises both directions of the env-binding WS bridge:
 *  - client → DO → upstream (client.send → server bridges → upstream.send)
 *  - upstream → DO → client (upstream.send → server bridges → client receives)
 *  - upstream close code/reason → propagates back to the client
 */

import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/thread-do-env-ws')
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

interface WsClient {
	ws: WebSocket
	waitForMessage(timeoutMs?: number): Promise<string | ArrayBuffer>
	waitForClose(timeoutMs?: number): Promise<{ code: number; reason: string }>
	send(data: string | ArrayBuffer): void
	close(code?: number, reason?: string): void
}

async function connect(url: string): Promise<WsClient> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url)
		ws.binaryType = 'arraybuffer'
		const messages: (string | ArrayBuffer)[] = []
		const messageWaiters: ((m: string | ArrayBuffer) => void)[] = []
		const closeWaiters: ((e: { code: number; reason: string }) => void)[] = []

		const timer = setTimeout(() => {
			ws.close()
			reject(new Error(`WebSocket to ${url} timed out`))
		}, 5_000)

		ws.onopen = () => {
			clearTimeout(timer)
			resolve({
				ws,
				waitForMessage(timeoutMs = 3_000) {
					if (messages.length > 0) return Promise.resolve(messages.shift()!)
					return new Promise((res, rej) => {
						const t = setTimeout(() => rej(new Error('Timeout waiting for WS message')), timeoutMs)
						messageWaiters.push(m => {
							clearTimeout(t)
							res(m)
						})
					})
				},
				waitForClose(timeoutMs = 3_000) {
					return new Promise((res, rej) => {
						const t = setTimeout(() => rej(new Error('Timeout waiting for WS close')), timeoutMs)
						closeWaiters.push(e => {
							clearTimeout(t)
							res(e)
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
		ws.onmessage = ev => {
			if (messageWaiters.length > 0) messageWaiters.shift()!(ev.data)
			else messages.push(ev.data)
		}
		ws.onclose = ev => {
			if (closeWaiters.length > 0) closeWaiters.shift()!({ code: ev.code, reason: ev.reason })
		}
		ws.onerror = () => {
			clearTimeout(timer)
			reject(new Error(`WebSocket to ${url} failed`))
		}
	})
}

describe('env-binding WebSocket upgrade through a DO', () => {
	let proc: Subprocess
	const PORT = 18831
	const httpBase = `http://localhost:${PORT}`
	const wsBase = `ws://localhost:${PORT}`

	beforeAll(async () => {
		cleanup()
		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		await waitForServer(`${httpBase}/health`, 20_000)
	}, 25_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	test('client ↔ DO ↔ upstream echo round-trips through the env-binding bridge', async () => {
		const c = await connect(`${wsBase}/bridge-echo`)
		c.send('hello')
		expect(await c.waitForMessage()).toBe('echo:hello')
		c.send('again')
		expect(await c.waitForMessage()).toBe('echo:again')
		c.close()
	})

	test('client ↔ DO ↔ upstream echo round-trips binary payloads', async () => {
		const c = await connect(`${wsBase}/bridge-echo`)
		const payload = new Uint8Array([10, 20, 30, 40, 50])
		c.send(payload.buffer)
		const echoed = await c.waitForMessage()
		expect(new Uint8Array(echoed as ArrayBuffer)).toEqual(payload)
		c.close()
	})

	test('upstream-initiated push reaches the client via DO bridge', async () => {
		const c = await connect(`${wsBase}/bridge-push`)
		expect(await c.waitForMessage()).toBe('hello-from-aux')
		c.close()
	})

	test('upstream close code + reason propagate through DO bridge to the client', async () => {
		const c = await connect(`${wsBase}/bridge-close`)
		const closeP = c.waitForClose()
		c.send('go')
		const ev = await closeP
		expect(ev.code).toBe(4010)
		expect(ev.reason).toBe('aux-closing')
	})

	test('chained — DO opens a WS to another DO via env binding (env-WS bridge chained through fetch-WS bridge)', async () => {
		const c = await connect(`${wsBase}/bridge-do-echo`)
		c.send('chained')
		expect(await c.waitForMessage()).toBe('do-echo:chained')
		c.send('again')
		expect(await c.waitForMessage()).toBe('do-echo:again')
		c.close()
	})
})
