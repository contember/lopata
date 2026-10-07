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

describe('selected automatic close-event state', () => {
	const cases: { name: string; input: CompatibilityInput; state: number }[] = [
		{ name: 'before threshold retains existing state', input: { date: '2026-04-06' }, state: CFWebSocket.OPEN },
		{ name: 'at threshold', input: { date: '2026-04-07' }, state: CFWebSocket.CLOSED },
		{ name: 'enable overrides date', input: { date: '2026-04-06', flags: ['web_socket_auto_reply_to_close'] }, state: CFWebSocket.CLOSED },
		{ name: 'disable overrides date', input: { date: '2026-04-07', flags: ['web_socket_manual_reply_to_close'] }, state: CFWebSocket.OPEN },
		{ name: 'no-date enable', input: { flags: ['web_socket_auto_reply_to_close'] }, state: CFWebSocket.CLOSED },
		{ name: 'no-date disable retains existing state', input: { flags: ['web_socket_manual_reply_to_close'] }, state: CFWebSocket.OPEN },
		{ name: 'legacy local retains existing state', input: {}, state: CFWebSocket.OPEN },
	]
	for (const { name, input, state } of cases) {
		test(name, () => {
			const pair = runWithCompatibility(resolveCompatibility(input), () => new WebSocketPair())
			pair[0].accept()
			pair[1].accept()
			const states: number[] = []
			pair[1].addEventListener('close', () => states.push(pair[1].readyState))
			pair[1].onclose = () => states.push(pair[1].readyState)
			pair[0].close(1000, 'peer close')
			expect(states).toEqual([state, state])
			expect(pair[0].readyState).toBe(CFWebSocket.CLOSED)
			expect(pair[1].readyState).toBe(CFWebSocket.CLOSED)
		})
	}

	test('queued close is CLOSED before both callbacks, once, in the captured owner scope', async () => {
		const owner = resolveCompatibility({ date: '2026-04-07', flags: ['webcrypto_modern_algorithms'] })
		const socket = runWithCompatibility(owner, () => new CFWebSocket())
		const events: Event[] = []
		const continuations: Promise<void>[] = []
		const onClose = (event: Event) => {
			events.push(event)
			expect(socket.readyState).toBe(CFWebSocket.CLOSED)
			expect(getActiveCompatibility()).toBe(owner)
			socket.close(1000, 'nested close')
			continuations.push((async () => {
				await Promise.resolve()
				expect(typeof crypto.subtle.encapsulateBits).toBe('function')
				expect(getActiveCompatibility()).toBe(owner)
			})())
		}
		runWithCompatibility(legacyCompatibility, () => {
			socket.addEventListener('close', onClose)
			socket.onclose = onClose
			socket.dispatchOrQueue({ type: 'close', code: 1000, reason: 'queued', wasClean: true })
			expect(events).toHaveLength(0)
			socket.accept()
			socket.close()
			expect(getActiveCompatibility()).toBe(legacyCompatibility)
		})
		await Promise.all(continuations)
		expect(events).toHaveLength(2)
		expect(events[0]).toBe(events[1])
	})

	test('hibernation preserves existing close state while raw transport peers still use automatic selection', () => {
		const selected = resolveCompatibility({ date: '2026-04-07' })
		for (const hibernation of [false, true]) {
			const pair = runWithCompatibility(selected, () => new WebSocketPair())
			if (hibernation) pair[1]._useHibernationDelivery()
			else pair[1]._useRawBinaryDelivery()
			pair[0].accept()
			pair[1].accept()
			const states: number[] = []
			pair[1].onclose = () => states.push(pair[1].readyState)
			pair[0].close()
			expect(states).toEqual([hibernation ? CFWebSocket.OPEN : CFWebSocket.CLOSED])
		}
	})

	test('server close and a synchronous transport close echo deliver one event', () => {
		const owner = resolveCompatibility({ date: '2026-04-07' })
		const pair = runWithCompatibility(owner, () => new WebSocketPair())
		pair[0].accept()
		pair[1].accept()
		pair[0].onclose = event => {
			pair[1].dispatchOrQueue({ type: 'close', code: event.code, reason: event.reason, wasClean: true })
		}
		const events: CloseEvent[] = []
		pair[1].onclose = event => events.push(event)
		pair[1].close(4000, 'server close')
		pair[1].dispatchOrQueue({ type: 'close', code: 4000, reason: 'server close', wasClean: true })
		expect(events).toHaveLength(1)
		expect(events[0]?.code).toBe(4000)
		expect(events[0]?.reason).toBe('server close')
		expect(pair[1].readyState).toBe(CFWebSocket.CLOSED)
	})
})

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
