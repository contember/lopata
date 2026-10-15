import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import puppeteer, { type Browser } from 'puppeteer'
import { type BrowserConfig, BrowserRunSessions, createBrowserRunBinding } from '../src/bindings/browser'
import type { CFWebSocket } from '../src/bindings/websocket-pair'

const hasChrome = existsSync(puppeteer.executablePath())

type Binding = ReturnType<typeof createBrowserRunBinding>

function freePort(): number {
	const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
	const port = listener.port
	listener.stop(true)
	return port
}

/** Chrome with a fixed DevTools port, so a restarted Chrome answers on the same `httpEndpoint`. */
function launchChrome(port: number): Promise<Browser> {
	return puppeteer.launch({ headless: true, args: [`--remote-debugging-port=${port}`] })
}

async function openCdpSocket(binding: Binding, sessionId: string): Promise<CFWebSocket> {
	const connection = await binding.connectSession(sessionId)
	const response = await connection.webSocket.fetch('https://browser-binding.invalid', { headers: { Upgrade: 'websocket' } })
	const socket = response.webSocket
	if (!socket) throw new Error('No WebSocket in the upgrade response')
	socket.accept()
	return socket
}

function sendCdp(socket: CFWebSocket, method: string): Promise<Record<string, any>> {
	const reply = new Promise<Record<string, any>>(resolve => {
		socket.onmessage = event => resolve(JSON.parse(String(event.data)).result)
	})
	socket.send(JSON.stringify({ id: 1, method }))
	return reply
}

async function waitUntilClosed(binding: Binding, sessionId: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if ((await binding.getSession(sessionId)) === null) return
		await new Promise(r => setTimeout(r, 50))
	}
	throw new Error(`Session ${sessionId} is still active`)
}

describe('Browser Run acquire limits', () => {
	test('keepAlive outside 10 s – 20 min is rejected with status 400', async () => {
		const binding = createBrowserRunBinding({}, new BrowserRunSessions())
		await expect(binding.acquire({ keepAlive: 5_000 })).rejects.toMatchObject({
			status: 400,
			message: 'Unable to create new browser: code: 400: message: keepAlive must be between 10000 and 1200000 ms, got 5000',
		})
		await expect(binding.acquire({ keepAlive: 1_200_001 })).rejects.toMatchObject({ status: 400 })
	})
})

describe.skipIf(!hasChrome)('Browser Run sessions on an external Chrome', () => {
	const port = freePort()
	let chrome: Browser
	const config: BrowserConfig = { httpEndpoint: `http://127.0.0.1:${port}` }

	beforeAll(async () => {
		chrome = await launchChrome(port)
	}, 30_000)

	afterAll(async () => {
		await chrome.close()
	})

	test('more concurrent sessions than maxConcurrentSessions are rejected with status 429', async () => {
		const sessions = new BrowserRunSessions()
		const binding = createBrowserRunBinding({ ...config, maxConcurrentSessions: 1 }, sessions)
		const { sessionId } = await binding.acquire()
		await expect(binding.acquire()).rejects.toMatchObject({
			status: 429,
			message: 'Unable to create new browser: code: 429: message: Browser instance limit reached: 1 concurrent sessions',
		})
		await binding.closeSession(sessionId)
		await binding.closeSession((await binding.acquire()).sessionId)
	})

	test('more new sessions per second than newSessionsPerSecond are rejected with status 429', async () => {
		const sessions = new BrowserRunSessions()
		const binding = createBrowserRunBinding({ ...config, newSessionsPerSecond: 2 }, sessions)
		await binding.acquire()
		await binding.acquire()
		await expect(binding.acquire()).rejects.toMatchObject({
			status: 429,
			message: 'Unable to create new browser: code: 429: message: Rate limit exceeded: 2 new browser sessions per second',
		})
		for (const session of await binding.listSessions()) await binding.closeSession(session.sessionId)
	})

	test('a restarted Chrome ends its sessions as ChromiumCrashed; a new session uses the new Chrome', async () => {
		const binding = createBrowserRunBinding(config, new BrowserRunSessions())
		const { sessionId } = await binding.acquire()
		const socket = await openCdpSocket(binding, sessionId)
		const socketClosed = new Promise<void>(resolve => socket.addEventListener('close', () => resolve()))

		await chrome.close()
		chrome = await launchChrome(port)

		await waitUntilClosed(binding, sessionId)
		await socketClosed
		expect(await binding.listSessions()).toEqual([])
		expect(await binding.history()).toEqual([expect.objectContaining({ sessionId, closeReasonText: 'ChromiumCrashed', endTime: expect.any(Number) })])
		await expect(binding.connectSession(sessionId)).rejects.toThrow('is not active')

		const next = await binding.acquire()
		const nextSocket = await openCdpSocket(binding, next.sessionId)
		expect((await sendCdp(nextSocket, 'Browser.getVersion')).product).toContain('Chrome')
		await binding.closeSession(next.sessionId)
	}, 30_000)
})

describe.skipIf(!hasChrome)('Browser Run sessions on a Chrome lopata launches', () => {
	let sessions: BrowserRunSessions

	afterEach(async () => {
		for (const session of sessions.list({})) await sessions.close(session.sessionId)
	})

	test('a killed Chrome ends its session as ChromiumCrashed and closes its CDP sockets', async () => {
		sessions = new BrowserRunSessions()
		const binding = createBrowserRunBinding({}, sessions)
		const { sessionId } = await binding.acquire()
		const socket = await openCdpSocket(binding, sessionId)
		const socketClosed = new Promise<void>(resolve => socket.addEventListener('close', () => resolve()))
		const { processInfo } = await sendCdp(socket, 'SystemInfo.getProcessInfo')
		const browserProcess = processInfo.find((info: { type: string }) => info.type === 'browser')

		process.kill(browserProcess.id, 'SIGKILL')

		await waitUntilClosed(binding, sessionId)
		await socketClosed
		expect(await binding.history()).toEqual([expect.objectContaining({ sessionId, closeReasonText: 'ChromiumCrashed' })])
	}, 30_000)
})
