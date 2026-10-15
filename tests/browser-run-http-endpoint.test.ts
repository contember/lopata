import type { Socket, TCPSocketListener } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import puppeteer, { type Browser } from 'puppeteer'
import { BrowserRunSessions, createBrowserRunBinding } from '../src/bindings/browser'

const hasChrome = existsSync(puppeteer.executablePath())

interface ForwardedConnection {
	upstream: Socket | undefined
	pending: Uint8Array[]
}

/** A port forward to Chrome that records each request's path and Host header, then rewrites Host to Chrome's own address. */
class PortForward {
	readonly requests: string[] = []
	private readonly listener: TCPSocketListener<ForwardedConnection>

	constructor(public targetPort: number) {
		this.listener = Bun.listen<ForwardedConnection>({
			hostname: '::',
			port: 0,
			data: { upstream: undefined, pending: [] },
			socket: {
				open: client => {
					client.data = { upstream: undefined, pending: [] }
					void Bun.connect({
						hostname: '127.0.0.1',
						port: this.targetPort,
						socket: {
							open: upstream => {
								client.data.upstream = upstream
								for (const chunk of client.data.pending) upstream.write(chunk)
								client.data.pending = []
							},
							data: (_upstream, chunk) => {
								client.write(chunk)
							},
							close: () => {
								client.end()
							},
						},
					})
				},
				data: (client, chunk) => {
					const head = new TextDecoder().decode(chunk)
					const requestLine = head.split('\r\n')[0]
					const host = head.match(/^host: (.*)$/im)?.[1]
					if (requestLine?.startsWith('GET ')) this.requests.push(`${requestLine.split(' ')[1]} host=${host}`)
					// Like a proxy that addresses the upstream by its own host: Chrome then reports 127.0.0.1:<its port>
					const forwarded = host === undefined ? chunk : new TextEncoder().encode(head.replace(/^host: .*$/im, `Host: 127.0.0.1:${this.targetPort}`))
					if (client.data.upstream) client.data.upstream.write(forwarded)
					else client.data.pending.push(forwarded)
				},
				close: client => {
					client.data.upstream?.end()
				},
			},
		})
	}

	get port(): number {
		return this.listener.port
	}

	stop(): void {
		this.listener.stop(true)
	}
}

async function launchChrome(): Promise<{ browser: Browser; port: number }> {
	const browser = await puppeteer.launch({ headless: true })
	return { browser, port: Number(new URL(browser.wsEndpoint()).port) }
}

describe.skipIf(!hasChrome)('Browser Run binding with browser.httpEndpoint', () => {
	let chrome: { browser: Browser; port: number }
	let forward: PortForward

	beforeAll(async () => {
		chrome = await launchChrome()
		forward = new PortForward(chrome.port)
	}, 30_000)

	afterAll(async () => {
		forward.stop()
		await chrome.browser.close()
	})

	test('resolves the WebSocket URL through /json/version and connects through the configured host, also after a Chrome restart', async () => {
		const sessions = new BrowserRunSessions()
		// A hostname, not an IP: Chrome only answers DevTools requests whose Host is an IP or localhost
		const binding = createBrowserRunBinding({ httpEndpoint: `http://chrome-test.localhost:${forward.port}` }, sessions)
		const host = `host=localhost:${forward.port}`

		const versionOf = async (): Promise<string> => {
			const connection = await binding.launch({ targets: true })
			expect(connection.targets?.length).toBeGreaterThan(0)
			const response = await connection.webSocket.fetch('https://browser-binding.invalid', { headers: { Upgrade: 'websocket' } })
			const socket = response.webSocket
			if (!socket) throw new Error('No WebSocket in the upgrade response')
			socket.accept()
			const reply = new Promise<string>(resolve => {
				socket.onmessage = event => resolve(String(event.data))
			})
			socket.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }))
			const { result } = JSON.parse(await reply)
			socket.close()
			await binding.closeSession(connection.sessionId)
			return result.product
		}

		expect(await versionOf()).toContain('Chrome')
		const firstBrowserPath = forward.requests.find(request => request.startsWith('/devtools/browser/'))

		await chrome.browser.close()
		chrome = await launchChrome()
		forward.targetPort = chrome.port
		expect(await versionOf()).toContain('Chrome')

		const browserPaths = forward.requests.filter(request => request.startsWith('/devtools/browser/'))
		expect(browserPaths).toHaveLength(2)
		expect(browserPaths[1]).not.toBe(firstBrowserPath)
		expect(forward.requests).toEqual([
			`/json/version ${host}`,
			`/json/list ${host}`,
			expect.stringMatching(new RegExp(`^/devtools/browser/\\S+ ${host}$`)),
			`/json/version ${host}`,
			`/json/list ${host}`,
			expect.stringMatching(new RegExp(`^/devtools/browser/\\S+ ${host}$`)),
		])
	}, 30_000)

	test('wsEndpoint and httpEndpoint together are rejected', async () => {
		const binding = createBrowserRunBinding(
			{ wsEndpoint: 'ws://127.0.0.1:1/devtools/browser/x', httpEndpoint: 'http://127.0.0.1:1' },
			new BrowserRunSessions(),
		)
		await expect(binding.acquire()).rejects.toThrow('Set either browser.wsEndpoint or browser.httpEndpoint, not both')
	})
})
