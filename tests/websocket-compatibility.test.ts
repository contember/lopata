import { describe, expect, test } from 'bun:test'
import { CFWebSocket, WebSocketPair, type WSEventType } from '../src/bindings/websocket-pair'
import { type CompatibilityInput, resolveCompatibility } from '../src/compatibility'
import { getActiveCompatibility, legacyCompatibility, runWithCompatibility } from '../src/compatibility-context'
import { installCompatibilityCrypto } from '../src/setup-globals'
import { WsGuestBridge } from '../src/worker-thread/ws-bridge-shared'

const modern = resolveCompatibility({ date: '2026-03-03', flags: ['webcrypto_modern_algorithms'] })
const oversized = '€'.repeat(41) + 'a'

function expectReasonError(callback: () => void): void {
	let error: unknown
	try {
		callback()
	} catch (caught) {
		error = caught
	}
	expect(error).toBeInstanceOf(DOMException)
	expect(error).toMatchObject({ name: 'SyntaxError' })
}

describe('selected WebSocket close reason', () => {
	const cases: { name: string; input: CompatibilityInput; enabled: boolean }[] = [
		{ name: 'before threshold', input: { date: '2026-03-02' }, enabled: false },
		{ name: 'at threshold', input: { date: '2026-03-03' }, enabled: true },
		{ name: 'explicit enable', input: { date: '2026-03-02', flags: ['websocket_close_reason_byte_limit'] }, enabled: true },
		{ name: 'explicit disable', input: { date: '2026-10-05', flags: ['no_websocket_close_reason_byte_limit'] }, enabled: false },
		{ name: 'no-date enable', input: { flags: ['websocket_close_reason_byte_limit'] }, enabled: true },
		{ name: 'no-date disable', input: { flags: ['no_websocket_close_reason_byte_limit'] }, enabled: false },
		{ name: 'legacy local', input: {}, enabled: false },
	]
	for (const { name, input, enabled } of cases) {
		test(name, () => {
			const pair = runWithCompatibility(resolveCompatibility(input), () => new WebSocketPair())
			pair[0].accept()
			pair[1].accept()
			const closes: string[] = []
			pair[1].onclose = event => closes.push(event.reason)
			const close = () => pair[0].close(1000, oversized)
			if (enabled) {
				expectReasonError(close)
				expect(pair[0].readyState).toBe(CFWebSocket.OPEN)
				expect(pair[1].readyState).toBe(CFWebSocket.OPEN)
				expect(closes).toEqual([])
				pair[0].close(1000, '€'.repeat(41))
				expect(closes).toEqual(['€'.repeat(41)])
			} else {
				close()
				expect(closes).toEqual([oversized])
			}
		})
	}

	test('validates before state early returns and counts UTF-8 rather than UTF-16', () => {
		for (const state of [CFWebSocket.CONNECTING, CFWebSocket.OPEN, CFWebSocket.CLOSING, CFWebSocket.CLOSED]) {
			const socket = runWithCompatibility(modern, () => new CFWebSocket())
			socket.readyState = state
			for (const reason of ['a'.repeat(124), '😀'.repeat(31), '\ud800'.repeat(42)]) {
				expectReasonError(() => socket.close(1000, reason))
				expect(socket.readyState).toBe(state)
			}
		}
		const socket = runWithCompatibility(modern, () => new CFWebSocket())
		socket.close(1000, 'a'.repeat(123))
		expectReasonError(() => socket.close(1000, oversized))
	})

	test('close uses construction owner rather than caller selection', () => {
		const enabled = runWithCompatibility(modern, () => new CFWebSocket())
		const baseline = runWithCompatibility(legacyCompatibility, () => new CFWebSocket())
		runWithCompatibility(legacyCompatibility, () => expectReasonError(() => enabled.close(1000, oversized)))
		runWithCompatibility(modern, () => baseline.close(1000, oversized))
		expect(baseline.readyState).toBe(CFWebSocket.CLOSED)
	})
})

describe('socket-owned event delivery', () => {
	installCompatibilityCrypto()

	for (const type of ['message', 'close', 'error', 'open'] satisfies WSEventType[]) {
		test(`${type} listeners and callback properties restore the owner`, async () => {
			const socket = runWithCompatibility(modern, () => new CFWebSocket())
			const pending: Promise<void>[] = []
			const callback = () => {
				expect(getActiveCompatibility()).toBe(modern)
				expect(typeof crypto.subtle.encapsulateBits).toBe('function')
				pending.push((async () => {
					await Promise.resolve()
					expect(getActiveCompatibility()).toBe(modern)
					expect(typeof crypto.subtle.encapsulateBits).toBe('function')
					expectReasonError(() => new WebSocketPair()[0].close(1000, oversized))
				})())
			}
			runWithCompatibility(legacyCompatibility, () => {
				socket.addEventListener(type, callback)
				socket.onmessage = callback
				socket.onclose = callback
				socket.onerror = callback
				socket.onopen = callback
				socket.dispatchOrQueue({ type, data: 'buffered' })
				socket.accept()
				expect(getActiveCompatibility()).toBe(legacyCompatibility)
				expect(typeof crypto.subtle.encapsulateBits).toBe('undefined')
			})
			await Promise.all(pending)
			expect(pending).toHaveLength(2)
		})
	}

	test('overlapping bridge deliveries retain each socket owner after await', async () => {
		const bridge = new WsGuestBridge<string>(() => {}, {
			remoteMessage: id => id,
			remoteClose: id => id,
		})
		const gate = Promise.withResolvers<void>()
		const pending: Promise<void>[] = []
		for (const [id, selection] of [['enabled', modern], ['baseline', legacyCompatibility]] as const) {
			const socket = runWithCompatibility(selection, () => bridge.createBridgedSocket(id))
			socket.accept()
			socket.onmessage = () => {
				pending.push((async () => {
					await gate.promise
					expect(getActiveCompatibility()).toBe(selection)
					expect(typeof crypto.subtle.encapsulateBits === 'function').toBe(selection.modernCrypto)
					const nested = new WebSocketPair()
					if (selection === modern) expectReasonError(() => nested[0].close(1000, oversized))
					else nested[0].close(1000, oversized)
				})())
			}
		}
		runWithCompatibility(legacyCompatibility, () => bridge.deliverClientMessage('enabled', 'first'))
		runWithCompatibility(modern, () => bridge.deliverClientMessage('baseline', 'second'))
		gate.resolve()
		await Promise.all(pending)
		expect(pending).toHaveLength(2)
	})
})
