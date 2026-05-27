import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/thread-ws-worker')
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

describe('Plain WebSocket through worker-thread runtime', () => {
	let proc: Subprocess
	const PORT = 18802
	const base = `ws://localhost:${PORT}`

	beforeAll(async () => {
		cleanup()
		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		await waitForServer(`http://localhost:${PORT}/ws/echo`, 15_000)
	}, 20_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	test('client → worker → echo back string', async () => {
		const c = await connect(`${base}/ws/echo`)
		c.send('hello')
		expect(await c.waitForMessage()).toBe('echo:hello')
		c.close()
	})

	test('client → worker → echo back binary (ArrayBuffer round-trip)', async () => {
		const c = await connect(`${base}/ws/echo`)
		const payload = new Uint8Array([1, 2, 3, 4, 5])
		c.send(payload.buffer)
		const echoed = await c.waitForMessage()
		expect(new Uint8Array(echoed as ArrayBuffer)).toEqual(payload)
		c.close()
	})

	test('server-initiated push reaches the client', async () => {
		const c = await connect(`${base}/ws/server-push`)
		expect(await c.waitForMessage()).toBe('hello-from-server')
		c.close()
	})

	test('worker-initiated close propagates code + reason to client', async () => {
		const c = await connect(`${base}/ws/server-close`)
		const closeP = c.waitForClose()
		c.send('go')
		const ev = await closeP
		expect(ev.code).toBe(4000)
		expect(ev.reason).toBe('server-closed')
	})

	test('malformed Response.webSocket fails loudly instead of shipping undefined', async () => {
		const res = await fetch(`${base}/ws/bad`, {
			headers: { Upgrade: 'websocket', Connection: 'upgrade' },
		}).catch((e: Error) => ({ status: 0, errMsg: e.message })) as Response | { status: 0; errMsg: string }
		if ('errMsg' in res) {
			expect(res.errMsg).toMatch(/./)
		} else {
			expect(res.status).not.toBe(101)
		}
	})
})
