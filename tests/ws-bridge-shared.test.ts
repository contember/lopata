import { beforeEach, describe, expect, test } from 'bun:test'
import { CFWebSocket } from '../src/bindings/websocket-pair'
import { WsGuestBridge, WsHostBridge } from '../src/worker-thread/ws-bridge-shared'

type HostMsg =
	| { type: 'client-message'; wsId: string; data: string | ArrayBuffer }
	| { type: 'client-close'; wsId: string; code: number; reason: string; wasClean: boolean }

type GuestMsg =
	| { type: 'remote-message'; wsId: string; data: string | ArrayBuffer }
	| { type: 'remote-close'; wsId: string; code: number; reason: string }

describe('WsHostBridge', () => {
	let posted: HostMsg[]
	let bridge: WsHostBridge<HostMsg>

	beforeEach(() => {
		posted = []
		bridge = new WsHostBridge<HostMsg>(m => posted.push(m), {
			clientMessage: (wsId, data) => ({ type: 'client-message', wsId, data }),
			clientClose: (wsId, code, reason, wasClean) => ({ type: 'client-close', wsId, code, reason, wasClean }),
		})
	})

	function pending(b: WsHostBridge<HostMsg>): Map<string, unknown[]> {
		return (b as unknown as { _pendingEvents: Map<string, unknown[]> })._pendingEvents
	}

	function sockets(b: WsHostBridge<HostMsg>): Map<string, CFWebSocket> {
		return (b as unknown as { _sockets: Map<string, CFWebSocket> })._sockets
	}

	test('register → deliver: events dispatch through the cfSocket peer', () => {
		const cf = bridge.register('w-1')
		cf.accept()

		const received: (string | ArrayBuffer)[] = []
		cf.addEventListener('message', ev => received.push((ev as MessageEvent).data))

		bridge.deliverRemoteMessage('w-1', 'hi')
		bridge.deliverRemoteMessage('w-1', 'there')
		expect(received).toEqual(['hi', 'there'])
	})

	test('deliver before register buffers, then replays after accept()', () => {
		bridge.deliverRemoteMessage('w-1', 'first')
		bridge.deliverRemoteMessage('w-1', 'second')
		expect(sockets(bridge).has('w-1')).toBe(false)
		expect(pending(bridge).get('w-1')).toHaveLength(2)

		const cf = bridge.register('w-1')
		expect(pending(bridge).has('w-1')).toBe(false)

		const received: (string | ArrayBuffer)[] = []
		cf.addEventListener('message', ev => received.push((ev as MessageEvent).data))
		expect(received).toEqual([])
		cf.accept()
		expect(received).toEqual(['first', 'second'])
	})

	test('deliverRemoteClose before register buffers a close event', () => {
		bridge.deliverRemoteClose('w-1', 4001, 'gone', true)
		expect(pending(bridge).get('w-1')).toHaveLength(1)

		const cf = bridge.register('w-1')
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
		bridge.deliverRemoteMessage('orphan-1', 'lost')
		bridge.deliverRemoteMessage('orphan-2', 'also-lost')
		expect(pending(bridge).size).toBe(2)

		bridge.disposeAll()
		expect(pending(bridge).size).toBe(0)
	})

	test('disposeAll sends 1012 Service Restart to active sockets', () => {
		const cf = bridge.register('w-1')
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
		const cf = bridge.register('w-1')
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

	test('peer events post client-message / client-close to the remote', () => {
		const cf = bridge.register('w-1')
		cf.accept()
		// `cli/dev.ts` would do `cfSocket._peer._dispatchWSEvent(...)` when the
		// real client sends; simulate that here.
		cf._peer!._dispatchWSEvent({ type: 'message', data: 'from-client' })
		cf._peer!._dispatchWSEvent({ type: 'close', code: 1000, reason: 'bye', wasClean: true })

		expect(posted).toEqual([
			{ type: 'client-message', wsId: 'w-1', data: 'from-client' },
			{ type: 'client-close', wsId: 'w-1', code: 1000, reason: 'bye', wasClean: true },
		])
		// close also forgets the socket so we don't leak across generations.
		expect(sockets(bridge).has('w-1')).toBe(false)
	})

	test('deliverRemoteClose removes the socket after delivery', () => {
		const cf = bridge.register('w-1')
		cf.accept()
		bridge.deliverRemoteClose('w-1', 1000, '', true)
		expect(sockets(bridge).has('w-1')).toBe(false)
	})
})

describe('WsGuestBridge', () => {
	let posted: GuestMsg[]
	let bridge: WsGuestBridge<GuestMsg>

	beforeEach(() => {
		posted = []
		bridge = new WsGuestBridge<GuestMsg>(m => posted.push(m), {
			remoteMessage: (wsId, data) => ({ type: 'remote-message', wsId, data }),
			remoteClose: (wsId, code, reason) => ({ type: 'remote-close', wsId, code, reason }),
		})
	})

	function makePair(): { client: CFWebSocket; server: CFWebSocket } {
		const client = new CFWebSocket()
		const server = new CFWebSocket()
		client._peer = server
		server._peer = client
		return { client, server }
	}

	test('register hooks listeners before accept() so flushed events post', () => {
		const { client, server } = makePair()
		// Simulate user calling `server.accept()` + `server.send()` BEFORE the
		// response ships — the message lands on `client._eventQueue` because
		// client hasn't accepted yet.
		server.accept()
		server.send('queued')
		expect(client._eventQueue).toHaveLength(1)

		bridge.register(client)
		// accept() flushed the queue, listener posted to remote.
		expect(posted).toHaveLength(1)
		expect(posted[0]).toMatchObject({ type: 'remote-message', data: 'queued' })
	})

	test('deliverClientMessage dispatches on the user-facing peer', () => {
		const { client, server } = makePair()
		const wsId = bridge.register(client)
		server.accept()

		const received: (string | ArrayBuffer)[] = []
		server.addEventListener('message', ev => received.push((ev as MessageEvent).data))

		bridge.deliverClientMessage(wsId, 'inbound')
		expect(received).toEqual(['inbound'])
	})

	test('deliverClientClose dispatches close + marks user peer CLOSED', () => {
		const { client, server } = makePair()
		const wsId = bridge.register(client)
		server.accept()

		const closes: CloseEvent[] = []
		server.addEventListener('close', ev => closes.push(ev as CloseEvent))

		bridge.deliverClientClose(wsId, 4002, 'bye', false)
		expect(closes).toHaveLength(1)
		expect(closes[0]!.code).toBe(4002)
		expect(server.readyState).toBe(CFWebSocket.CLOSED)
	})

	test('register throws when shipped socket has no peer', () => {
		const lone = new CFWebSocket()
		expect(() => bridge.register(lone)).toThrow(/has no peer/)
	})
})
