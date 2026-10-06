import { describe, expect, test } from 'bun:test'
import { CFWebSocket, copyWebSocketBytes, WebSocketPair, type WSEventType } from '../src/bindings/websocket-pair'
import { type CompatibilityInput, resolveCompatibility } from '../src/compatibility'
import { getActiveCompatibility, legacyCompatibility, runWithCompatibility } from '../src/compatibility-context'
import { installCompatibilityCrypto } from '../src/setup-globals'
import { WsGuestBridge } from '../src/worker-thread/ws-bridge-shared'

const modern = resolveCompatibility({ date: '2026-03-03', flags: ['webcrypto_modern_algorithms'] })
const oversized = '€'.repeat(41) + 'a'

describe('selected WebSocket binary delivery', () => {
	const cases: { name: string; input: CompatibilityInput; initial: string | undefined }[] = [
		{ name: 'before threshold', input: { date: '2026-03-16' }, initial: 'arraybuffer' },
		{ name: 'at threshold', input: { date: '2026-03-17' }, initial: 'blob' },
		{ name: 'enable overrides date', input: { date: '2026-03-16', flags: ['websocket_standard_binary_type'] }, initial: 'blob' },
		{ name: 'disable overrides date', input: { date: '2026-03-17', flags: ['no_websocket_standard_binary_type'] }, initial: 'arraybuffer' },
		{ name: 'no-date enable', input: { flags: ['websocket_standard_binary_type'] }, initial: 'blob' },
		{ name: 'no-date disable', input: { flags: ['no_websocket_standard_binary_type'] }, initial: 'arraybuffer' },
		{ name: 'legacy local', input: {}, initial: undefined },
	]
	for (const { name, input, initial } of cases) {
		test(name, async () => {
			const pair = runWithCompatibility(resolveCompatibility(input), () => new WebSocketPair())
			const [sender, receiver] = [pair[0], pair[1]]
			sender.accept()
			receiver.accept()
			expect('binaryType' in receiver).toBe(initial !== undefined)
			expect(receiver.binaryType).toBe(initial)
			const received: unknown[] = []
			receiver.onmessage = event => received.push(event.data)
			sender.send(new Uint8Array([1, 2]))
			expect(received[0]).toBeInstanceOf(initial === 'blob' ? Blob : ArrayBuffer)
			for (const value of ['arraybuffer', 'blob', 'arraybuffer', 'blob']) {
				receiver.binaryType = value
				sender.send(new Uint8Array([3, 4]))
				const message = received.at(-1)
				if (initial !== undefined && value === 'blob') {
					if (!(message instanceof Blob)) throw new Error('Expected Blob')
					expect(message.type).toBe('')
					expect([...new Uint8Array(await message.arrayBuffer())]).toEqual([3, 4])
				} else {
					if (!(message instanceof ArrayBuffer)) throw new Error('Expected ArrayBuffer')
					expect([...new Uint8Array(message)]).toEqual([3, 4])
				}
				if (initial !== undefined) {
					for (const invalid of ['', 'Blob', 'ARRAYBUFFER', 'bytes']) {
						receiver.binaryType = invalid
						expect(receiver.binaryType).toBe(value)
					}
				}
			}
			sender.send(new ArrayBuffer(0))
			const empty = received.at(-1)
			if (empty instanceof Blob) expect(empty.size).toBe(0)
			else if (empty instanceof ArrayBuffer) expect(empty.byteLength).toBe(0)
			else throw new Error('Expected empty binary message')
			sender.send('text')
			expect(received.at(-1)).toBe('text')
		})
	}

	test('queued messages select the receiver type at delivery and share one event across callbacks', () => {
		const pair = runWithCompatibility(resolveCompatibility({ date: '2026-03-17' }), () => new WebSocketPair())
		pair[0].accept()
		pair[0].send(new Uint8Array([1]))
		pair[0].send('between binary messages')
		pair[0].send(new Uint8Array([2]))
		pair[1].binaryType = 'arraybuffer'
		const listeners: MessageEvent<unknown>[] = []
		const callbacks: MessageEvent<unknown>[] = []
		pair[1].addEventListener('message', event => {
			if (!(event instanceof MessageEvent)) throw new Error('Expected MessageEvent')
			listeners.push(event)
			pair[1].binaryType = 'blob'
		})
		pair[1].onmessage = event => callbacks.push(event)
		pair[1].accept()
		expect(callbacks).toHaveLength(3)
		expect(callbacks[0]).toBe(listeners[0])
		expect(callbacks[1]).toBe(listeners[1])
		expect(callbacks[2]).toBe(listeners[2])
		expect(callbacks[0]?.data).toBeInstanceOf(ArrayBuffer)
		expect(callbacks[1]?.data).toBe('between binary messages')
		expect(callbacks[2]?.data).toBeInstanceOf(Blob)
	})

	test('raw mode ignores public binaryType and applies before queued delivery', () => {
		const pair = runWithCompatibility(resolveCompatibility({ date: '2026-03-17' }), () => new WebSocketPair())
		pair[0].accept()
		pair[0].send(new Uint8Array([7]))
		pair[1]._useRawBinaryDelivery()
		const received: unknown[] = []
		pair[1].onmessage = event => received.push(event.data)
		pair[1].accept()
		pair[1].binaryType = 'arraybuffer'
		pair[1].binaryType = 'blob'
		pair[0].send(new Uint8Array([8]))
		expect(pair[1].binaryType).toBe('blob')
		expect(received.every(data => data instanceof ArrayBuffer)).toBe(true)
		expect(received).toHaveLength(2)
	})

	test('view normalization copies only the selected bytes for Buffer, DataView and typed arrays', () => {
		const backing = new Uint8Array([99, 1, 2, 88])
		const views: ArrayBufferView[] = [backing.subarray(1, 3), new DataView(backing.buffer, 1, 2), Buffer.from(backing.buffer, 1, 2)]
		for (const view of views) {
			const copy = copyWebSocketBytes(view)
			expect([...new Uint8Array(copy)]).toEqual([1, 2])
			const pair = new WebSocketPair()
			pair[0].accept()
			pair[1].accept()
			pair[1].onmessage = event => {
				const data: unknown = event.data
				if (!(data instanceof ArrayBuffer)) throw new Error('Expected ArrayBuffer')
				expect([...new Uint8Array(data)]).toEqual([1, 2])
			}
			pair[0].send(view)
		}
	})
})

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
