import { beforeEach, describe, expect, test } from 'bun:test'
import { CFWebSocket } from '../src/bindings/websocket-pair'
import { MainWsBridge } from '../src/worker-thread/main-ws-bridge'
import type { WorkerCommand } from '../src/worker-thread/protocol'

describe('MainWsBridge', () => {
	let posted: WorkerCommand[]
	let bridge: MainWsBridge

	beforeEach(() => {
		posted = []
		bridge = new MainWsBridge(cmd => posted.push(cmd))
	})

	function pending(b: MainWsBridge): Map<string, unknown[]> {
		return (b as unknown as { _pendingEvents: Map<string, unknown[]> })._pendingEvents
	}

	function sockets(b: MainWsBridge): Map<string, CFWebSocket> {
		return (b as unknown as { _sockets: Map<string, CFWebSocket> })._sockets
	}

	test('createSocket → deliver: events dispatch through the cfSocket peer', () => {
		const cf = bridge.createSocket('w-1')
		cf.accept()

		const received: (string | ArrayBuffer)[] = []
		cf.addEventListener('message', ev => received.push((ev as MessageEvent).data))

		bridge.deliverWorkerSend('w-1', 'hi')
		bridge.deliverWorkerSend('w-1', 'there')
		expect(received).toEqual(['hi', 'there'])
	})

	test('deliver before createSocket buffers, then replays after accept()', () => {
		bridge.deliverWorkerSend('w-1', 'first')
		bridge.deliverWorkerSend('w-1', 'second')
		// Nothing exists yet on the socket map; events live in the pending buffer.
		expect(sockets(bridge).has('w-1')).toBe(false)
		expect(pending(bridge).get('w-1')).toHaveLength(2)

		const cf = bridge.createSocket('w-1')
		// createSocket drains the pending buffer onto the new socket's queue.
		expect(pending(bridge).has('w-1')).toBe(false)

		const received: (string | ArrayBuffer)[] = []
		cf.addEventListener('message', ev => received.push((ev as MessageEvent).data))
		expect(received).toEqual([])
		cf.accept()
		expect(received).toEqual(['first', 'second'])
	})

	test('deliverWorkerClose before createSocket buffers a close event', () => {
		bridge.deliverWorkerClose('w-1', 4001, 'gone')
		expect(pending(bridge).get('w-1')).toHaveLength(1)

		const cf = bridge.createSocket('w-1')
		let closeEvt: CloseEvent | null = null
		cf.addEventListener('close', ev => {
			closeEvt = ev as CloseEvent
		})
		cf.accept()
		expect(closeEvt).not.toBeNull()
		expect(closeEvt!.code).toBe(4001)
		expect(closeEvt!.reason).toBe('gone')
	})

	test('disposeAll clears stranded pending events (leak prevention)', () => {
		// Worker pushed events but the matching createSocket never happened
		// (e.g. the binding-fetch errored after the worker had already queued).
		bridge.deliverWorkerSend('orphan-1', 'lost')
		bridge.deliverWorkerSend('orphan-2', 'also-lost')
		expect(pending(bridge).size).toBe(2)

		bridge.disposeAll()
		expect(pending(bridge).size).toBe(0)
	})

	test('disposeAll sends 1012 Service Restart to active sockets', () => {
		const cf = bridge.createSocket('w-1')
		const closes: CloseEvent[] = []
		cf.addEventListener('close', ev => closes.push(ev as CloseEvent))
		cf.accept()

		bridge.disposeAll()
		expect(sockets(bridge).size).toBe(0)
		expect(closes).toHaveLength(1)
		expect(closes[0]!.code).toBe(1012)
		expect(closes[0]!.reason).toBe('Service Restart')
	})

	test('disposeAll skips sockets that are already CLOSED', () => {
		const cf = bridge.createSocket('w-1')
		cf.accept()
		cf.readyState = CFWebSocket.CLOSED

		const closes: CloseEvent[] = []
		cf.addEventListener('close', ev => closes.push(ev as CloseEvent))

		bridge.disposeAll()
		expect(closes).toHaveLength(0)
	})

	test('adoptExisting registers a real peer and getSocket returns it', () => {
		const real = new CFWebSocket()
		const wsId = bridge.adoptExisting(real)
		expect(bridge.getSocket(wsId)).toBe(real)
		expect(sockets(bridge).get(wsId)).toBe(real)
	})

	test('peer events post ws-client-message / ws-client-close to the worker', () => {
		const cf = bridge.createSocket('w-1')
		cf.accept()
		// `cli/dev.ts` would do `cfSocket._peer._dispatchWSEvent(...)` when the
		// real client sends; simulate that here.
		cf._peer!._dispatchWSEvent({ type: 'message', data: 'from-client' })
		cf._peer!._dispatchWSEvent({ type: 'close', code: 1000, reason: 'bye', wasClean: true })

		expect(posted).toEqual([
			{ type: 'ws-client-message', wsId: 'w-1', data: 'from-client' },
			{ type: 'ws-client-close', wsId: 'w-1', code: 1000, reason: 'bye', wasClean: true },
		])
		// close also forgets the socket so we don't leak across generations.
		expect(sockets(bridge).has('w-1')).toBe(false)
	})

	test('deliverWorkerClose removes the socket after delivery', () => {
		const cf = bridge.createSocket('w-1')
		cf.accept()
		bridge.deliverWorkerClose('w-1', 1000, '')
		expect(sockets(bridge).has('w-1')).toBe(false)
	})
})
