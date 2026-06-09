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

	test('adoptExisting cleans up _sockets when adopted peer closes', () => {
		const real = new CFWebSocket()
		// Pair it so close() can run end-to-end.
		const farSide = new CFWebSocket()
		real._peer = farSide
		farSide._peer = real
		real.accept()

		const wsId = bridge.adoptExisting(real)
		expect(sockets(bridge).get(wsId)).toBe(real)

		real.close(1000, 'bye')
		expect(sockets(bridge).has(wsId)).toBe(false)
	})

	test('adoptExisting with bridgeEvents cleans up _sockets when peer closes', () => {
		const real = new CFWebSocket()
		const farSide = new CFWebSocket()
		real._peer = farSide
		farSide._peer = real

		const wsId = bridge.adoptExisting(real, { bridgeEvents: true })
		expect(sockets(bridge).get(wsId)).toBe(real)

		real.close(1000, 'bye')
		expect(sockets(bridge).has(wsId)).toBe(false)
	})

	test('disposeAll marks sockets CLOSED so consumer polls see stale-OPEN no more', () => {
		const cf1 = bridge.register('w-1')
		const cf2 = bridge.register('w-2')
		cf1.accept()
		cf2.accept()
		expect(cf1.readyState).toBe(CFWebSocket.OPEN)
		expect(cf2.readyState).toBe(CFWebSocket.OPEN)

		bridge.disposeAll()
		expect(cf1.readyState).toBe(CFWebSocket.CLOSED)
		expect(cf2.readyState).toBe(CFWebSocket.CLOSED)
	})

	test('late message after peer close does not leak into _pendingEvents', () => {
		const cf = bridge.register('w-1')
		cf.accept()
		// Real client closed first, host forgets the wsId.
		cf._peer!._dispatchWSEvent({ type: 'close', code: 1000, reason: 'bye', wasClean: true })
		expect(sockets(bridge).has('w-1')).toBe(false)

		// In-flight guest-side message arrives after the close.
		bridge.deliverRemoteMessage('w-1', 'late')
		expect(pending(bridge).has('w-1')).toBe(false)
	})

	test('BridgeWebSocketPeer drops late messages after its close was dispatched', () => {
		const cf = bridge.register('w-1')
		cf.accept()
		const peer = cf._peer!
		peer._dispatchWSEvent({ type: 'close', code: 1000, reason: 'bye', wasClean: true })

		posted.length = 0
		peer._dispatchWSEvent({ type: 'message', data: 'after-close' })
		expect(posted).toEqual([])
	})

	test('BridgeWebSocketPeer is idempotent on repeated close dispatch', () => {
		const cf = bridge.register('w-1')
		cf.accept()
		const peer = cf._peer!
		peer._dispatchWSEvent({ type: 'close', code: 1000, reason: 'bye', wasClean: true })
		const afterFirst = posted.length
		peer._dispatchWSEvent({ type: 'close', code: 1000, reason: 'bye', wasClean: true })
		expect(posted.length).toBe(afterFirst)
		expect(peer.readyState).toBe(CFWebSocket.CLOSED)
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

	test('createBridgedSocket flushes a client message buffered before creation', () => {
		const wsId = 'race-msg'
		// env-ws-incoming raced ahead of the rpc-fetch-result that creates the socket
		bridge.deliverClientMessage(wsId, 'early')

		const userPeer = bridge.createBridgedSocket(wsId)
		const received: (string | ArrayBuffer)[] = []
		userPeer.addEventListener('message', ev => received.push((ev as MessageEvent).data))
		userPeer.accept()

		expect(received).toEqual(['early'])
	})

	test('createBridgedSocket flushes a buffered message + close in order', () => {
		const wsId = 'race-close'
		bridge.deliverClientMessage(wsId, 'm1')
		bridge.deliverClientClose(wsId, 4001, 'gone', true)

		const userPeer = bridge.createBridgedSocket(wsId)
		const order: string[] = []
		userPeer.addEventListener('message', () => order.push('msg'))
		userPeer.addEventListener('close', ev => order.push(`close:${(ev as CloseEvent).code}`))
		userPeer.accept()

		expect(order).toEqual(['msg', 'close:4001'])
	})

	test('client events after a normal close are dropped, not re-buffered', () => {
		const wsId = 'race-forgotten'
		const userPeer = bridge.createBridgedSocket(wsId)
		userPeer.accept()
		bridge.deliverClientClose(wsId, 1000, '', true)
		// A late message for the now-forgotten id must not resurrect a pending queue.
		bridge.deliverClientMessage(wsId, 'late')

		const next = bridge.createBridgedSocket(wsId)
		const received: unknown[] = []
		next.addEventListener('message', ev => received.push((ev as MessageEvent).data))
		next.accept()
		expect(received).toEqual([])
	})

	test('register warns when shipped peer was pre-accepted; later events still flow', () => {
		const { client, server } = makePair()
		client.accept()
		server.accept()
		server.send('lost-before-register')

		const warnings: string[] = []
		const origWarn = console.warn
		console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '))
		try {
			bridge.register(client)
		} finally {
			console.warn = origWarn
		}

		expect(warnings.length).toBe(1)
		expect(warnings[0]).toMatch(/already accept\(\)ed/)

		posted.length = 0
		server.send('after-register')
		expect(posted).toHaveLength(1)
		expect(posted[0]).toMatchObject({ type: 'remote-message', data: 'after-register' })
	})

	test('register does not warn for the normal (not pre-accepted) path', () => {
		const { client, server } = makePair()
		server.accept()
		server.send('queued-on-client')

		const warnings: string[] = []
		const origWarn = console.warn
		console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '))
		try {
			bridge.register(client)
		} finally {
			console.warn = origWarn
		}

		expect(warnings).toEqual([])
		expect(posted).toHaveLength(1)
		expect(posted[0]).toMatchObject({ type: 'remote-message', data: 'queued-on-client' })
	})
})
