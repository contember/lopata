import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer'
import { BrowserRunSessions, createBrowserRunBinding } from '../src/bindings/browser'

const hasChrome = existsSync(puppeteer.executablePath())

describe('Browser Run binding', () => {
	let sessions: BrowserRunSessions

	afterEach(async () => {
		for (const session of sessions.list({})) await sessions.close(session.sessionId)
	})

	test('unknown sessions and unimplemented features fail with a clear error', async () => {
		sessions = new BrowserRunSessions()
		const browser = createBrowserRunBinding({}, sessions)
		await expect(browser.connectSession('missing')).rejects.toThrow('Browser Run session "missing" is not active')
		await expect(browser.closeSession('missing')).rejects.toThrow('Browser Run session "missing" not found')
		await expect(browser.quickAction()).rejects.toThrow('Browser Run quickAction() is not supported locally by lopata')
		await expect(browser.limits()).rejects.toThrow('Browser Run limits() is not supported locally by lopata')
		await expect(browser.getLiveView()).rejects.toThrow('Browser Run getLiveView() is not supported locally by lopata')
		await expect(browser.devtools.listTargets()).rejects.toThrow('Browser Run devtools.listTargets() is not supported locally by lopata')
		await expect(browser.acquire({ guardrails: { allowedDomains: [] } })).rejects.toThrow('acquire option "guardrails" is not supported locally')
		await expect(browser.fetch(new Request('https://browser-binding.invalid/v1/acquire'))).rejects.toThrow(
			'Browser Run fetch() (the raw HTTP API) is not supported locally by lopata',
		)
		expect(await browser.getSession('missing')).toBeNull()
	})

	test.skipIf(!hasChrome)('a session that receives no CDP command for keepAlive closes as BrowserIdle', async () => {
		sessions = new BrowserRunSessions()
		const browser = createBrowserRunBinding({}, sessions)
		const { sessionId } = await browser.acquire({ keepAlive: 300 })
		expect(await browser.listSessions()).toEqual([expect.objectContaining({ sessionId })])

		await new Promise(r => setTimeout(r, 1_000))

		expect(await browser.getSession(sessionId)).toBeNull()
		expect(await browser.listSessions()).toEqual([])
		expect(await browser.history()).toEqual([expect.objectContaining({ sessionId, closeReason: 2, closeReasonText: 'BrowserIdle' })])
		await expect(browser.connectSession(sessionId)).rejects.toThrow('is not active')
	}, 15_000)

	test.skipIf(!hasChrome)('closeSession() closes the open CDP socket', async () => {
		sessions = new BrowserRunSessions()
		const browser = createBrowserRunBinding({}, sessions)
		const connection = await browser.launch()
		const response = await connection.webSocket.fetch('https://browser-binding.invalid', { headers: { Upgrade: 'websocket' } })
		expect(response.status).toBe(101)
		const socket = response.webSocket
		if (!socket) throw new Error('No WebSocket in the upgrade response')
		socket.accept()
		const closed = new Promise<void>(resolve => socket.addEventListener('close', () => resolve()))

		expect(await browser.closeSession(connection.sessionId)).toEqual({ status: 'closed' })
		await closed
		expect(await browser.getSession(connection.sessionId)).toBeNull()
	}, 15_000)
})
