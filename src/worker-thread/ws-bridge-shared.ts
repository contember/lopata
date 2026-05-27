/**
 * Cross-thread WebSocket bridge — shared primitive.
 *
 * Used by both worker channels (main ↔ user-worker, main ↔ DO-instance worker)
 * to ferry events for a CFWebSocket whose two halves live on opposite threads.
 *
 * Direction & terminology:
 *  - *Guest* — the side that owns the user-facing peer (worker thread).
 *    The user code created a `WebSocketPair` locally and shipped `pair[0]`
 *    in a `Response{webSocket}`. The guest keeps `pair[1]` and forwards
 *    everything the user does on it through to the host.
 *  - *Host* — the side that hands the upgraded `CFWebSocket` to `Bun.serve`
 *    (main thread). It owns a synthetic CFWebSocket whose `_peer` posts every
 *    inbound event (from the real client) back to the guest.
 *
 * Each bridged socket is identified by an opaque `wsId` generated on the
 * guest side. The host-side `register()` call is the message that ferries
 * the id over and creates the local half. A late `deliverRemote*` for a
 * wsId that hasn't been `register()`ed yet is buffered until it appears —
 * see `_pendingEvents` for why.
 *
 * Channel-specific envelopes (`ws-worker-send` vs `fetch-ws-outgoing`, etc.)
 * are encoded by the `WsBridgeEnvelopes` callbacks each consumer supplies.
 */

import { CFWebSocket, type WSEvent } from '../bindings/websocket-pair'
import { generateId } from '../tracing/context'

/**
 * Channel-specific message builders. Each callback returns the exact envelope
 * the consumer's transport expects; the bridge just calls `post(envelope)`.
 */
export interface WsHostEnvelopes<O> {
	/** Inbound from the real client → guest's user peer. */
	clientMessage(wsId: string, data: string | ArrayBuffer): O
	clientClose(wsId: string, code: number, reason: string, wasClean: boolean): O
}

export interface WsGuestEnvelopes<O> {
	/** User-facing peer sent bytes → forward to real client via host. */
	remoteMessage(wsId: string, data: string | ArrayBuffer): O
	remoteClose(wsId: string, code: number, reason: string, wasClean: boolean): O
}

/**
 * Host side: owns the `CFWebSocket` that gets handed to `Bun.serve.upgrade`
 * and bridges events to/from the guest worker.
 */
export class WsHostBridge<O> {
	/** wsId → cfSocket (the side handed to `Bun.serve.upgrade`). */
	private _sockets = new Map<string, CFWebSocket>()
	/**
	 * Events from the guest that arrived before the matching `register()` /
	 * `adoptExisting()` was called. The guest's `accept()` flushes queued events
	 * synchronously and posts them; those posts race ahead of the binding-fetch /
	 * fetch result that triggers host-side registration. Without buffering, the
	 * first message would be lost.
	 */
	private _pendingEvents = new Map<string, WSEvent[]>()
	private _post: (msg: O) => void
	private _envelopes: WsHostEnvelopes<O>

	constructor(post: (msg: O) => void, envelopes: WsHostEnvelopes<O>) {
		this._post = post
		this._envelopes = envelopes
	}

	/**
	 * Build a host-side `CFWebSocket` paired with a bridge peer that posts every
	 * inbound event back to the guest. Drains any pending events queued before
	 * this call.
	 */
	register(wsId: string): CFWebSocket {
		const cfSocket = new CFWebSocket()
		const peer = new BridgeWebSocketPeer(wsId, this._post, this._envelopes, id => this._sockets.delete(id))
		cfSocket._peer = peer
		peer._peer = cfSocket
		this._sockets.set(wsId, cfSocket)
		const pending = this._pendingEvents.get(wsId)
		if (pending) {
			cfSocket._eventQueue.push(...pending)
			this._pendingEvents.delete(wsId)
		}
		return cfSocket
	}

	/**
	 * Adopt an already-real `CFWebSocket` (typically the client peer returned
	 * from a DO/service binding inside a nested binding fetch). The peer is
	 * already wired to its server counterpart, so we just need to keep it
	 * addressable by id when the guest echoes the response back up.
	 */
	adoptExisting(ws: CFWebSocket): string {
		const wsId = generateId(8)
		this._sockets.set(wsId, ws)
		return wsId
	}

	/** Look up a previously-registered or adopted CFWebSocket. */
	getSocket(wsId: string): CFWebSocket | undefined {
		return this._sockets.get(wsId)
	}

	/** Guest reports its user-facing peer emitted a message → fire it on the host socket. */
	deliverRemoteMessage(wsId: string, data: string | ArrayBuffer): void {
		const cfSocket = this._sockets.get(wsId)
		const evt: WSEvent = { type: 'message', data }
		if (!cfSocket) {
			this._bufferPending(wsId, evt)
			return
		}
		cfSocket.dispatchOrQueue(evt)
	}

	/** Guest reports its user-facing peer closed → fire close on the host socket. */
	deliverRemoteClose(wsId: string, code: number, reason: string, wasClean: boolean): void {
		const cfSocket = this._sockets.get(wsId)
		const evt: WSEvent = { type: 'close', code, reason, wasClean }
		if (!cfSocket) {
			this._bufferPending(wsId, evt)
			return
		}
		cfSocket.dispatchOrQueue(evt)
		cfSocket.readyState = CFWebSocket.CLOSED
		this._sockets.delete(wsId)
	}

	private _bufferPending(wsId: string, evt: WSEvent): void {
		let q = this._pendingEvents.get(wsId)
		if (!q) {
			q = []
			this._pendingEvents.set(wsId, q)
		}
		q.push(evt)
	}

	/**
	 * Notify any active real clients that this generation is going away, then
	 * drop them. Mirrors the `1012 Service Restart` close code WebSockets use
	 * for planned restarts. Also drops any stranded pending events for ids that
	 * never reached `register()` (e.g. binding-fetch errored mid-flight).
	 */
	disposeAll(): void {
		for (const cfSocket of this._sockets.values()) {
			if (cfSocket.readyState === CFWebSocket.CLOSED) continue
			cfSocket.dispatchOrQueue({ type: 'close', code: 1012, reason: 'Service Restart', wasClean: true })
		}
		this._sockets.clear()
		this._pendingEvents.clear()
	}
}

/**
 * Peer that lives next to a host-side `CFWebSocket` and posts every dispatched
 * event back to the guest. Pinned to `OPEN`/`accepted` so the cli/dev.ts
 * upgrade handler — which only dispatches on accepted peers — can always
 * relay client traffic.
 */
class BridgeWebSocketPeer<O> extends CFWebSocket {
	private _wsId: string
	private _post: (msg: O) => void
	private _envelopes: WsHostEnvelopes<O>
	private _onForget: (wsId: string) => void

	constructor(wsId: string, post: (msg: O) => void, envelopes: WsHostEnvelopes<O>, onForget: (wsId: string) => void) {
		super()
		this._wsId = wsId
		this._post = post
		this._envelopes = envelopes
		this._onForget = onForget
		this._accepted = true
		this.readyState = CFWebSocket.OPEN
	}

	override _dispatchWSEvent(evt: WSEvent): void {
		if (evt.type === 'message' && evt.data !== undefined) {
			this._post(this._envelopes.clientMessage(this._wsId, evt.data))
			return
		}
		if (evt.type === 'close') {
			this._post(this._envelopes.clientClose(this._wsId, evt.code ?? 1000, evt.reason ?? '', evt.wasClean ?? true))
			this._onForget(this._wsId)
		}
	}
}

/**
 * Guest side: hooks the CFWebSocket that's about to ship in a Response and
 * forwards events between the user-facing peer and the host.
 */
export class WsGuestBridge<O> {
	private _sockets = new Map<string, { userPeer: CFWebSocket; closed: boolean }>()
	private _post: (msg: O) => void
	private _envelopes: WsGuestEnvelopes<O>

	constructor(post: (msg: O) => void, envelopes: WsGuestEnvelopes<O>) {
		this._post = post
		this._envelopes = envelopes
	}

	/**
	 * Reverse of `register`: build a fresh `CFWebSocket` for a wsId allocated on
	 * the host (e.g. main adopted an upstream WS returned from an env-binding
	 * fetch). The returned socket is what user code interacts with — calling
	 * `accept()` / `send()` / `addEventListener('message')` here drives the
	 * remote peer through the bridge.
	 */
	createBridgedSocket(wsId: string): CFWebSocket {
		const userPeer = new CFWebSocket()
		const bridgePeer = new BridgeGuestPeer<O>(wsId, this._post, this._envelopes, id => this._sockets.delete(id))
		userPeer._peer = bridgePeer
		bridgePeer._peer = userPeer
		this._sockets.set(wsId, { userPeer, closed: false })
		return userPeer
	}

	/**
	 * Hook up a `CFWebSocket` that's about to ship in a Response. Listeners must
	 * be attached BEFORE `accept()` so the synchronous flush of any queued events
	 * (e.g. the user already called `server.send()` before returning the response)
	 * reaches the bridge instead of being lost.
	 *
	 * If the shipped peer was pre-accepted by user code (e.g. `client.accept()`
	 * before returning the Response), any events dispatched between that
	 * pre-accept and this `register()` call were emitted with no listeners
	 * attached — they're already gone. We still attach listeners so anything
	 * *after* this point flows correctly, and emit a console.warn so the user
	 * knows to drop the early `accept()`.
	 */
	register(shipped: CFWebSocket): string {
		const wsId = generateId(8)
		const userPeer = shipped._peer
		if (!userPeer) {
			throw new Error('Response.webSocket has no peer — was it created via `new WebSocketPair()`?')
		}
		this._sockets.set(wsId, { userPeer, closed: false })

		const wasPreAccepted = shipped._accepted

		shipped.addEventListener('message', (ev: Event) => {
			const data = (ev as MessageEvent).data
			this._post(this._envelopes.remoteMessage(wsId, data))
		})
		shipped.addEventListener('close', (ev: Event) => {
			const ce = ev as CloseEvent
			this._post(this._envelopes.remoteClose(wsId, ce.code, ce.reason, ce.wasClean ?? true))
			this._sockets.delete(wsId)
		})
		shipped.accept()

		if (wasPreAccepted) {
			console.warn(
				'[lopata] Response.webSocket was already accept()ed before returning; '
					+ 'any events sent between accept() and the response return were lost. '
					+ 'Remove the early accept() — lopata accepts the shipped peer for you.',
			)
		}

		return wsId
	}

	/** Host delivered a message from the real client → fire it on the user peer. */
	deliverClientMessage(wsId: string, data: string | ArrayBuffer): void {
		const entry = this._sockets.get(wsId)
		if (!entry || entry.closed) return
		entry.userPeer.dispatchOrQueue({ type: 'message', data })
	}

	/** Host delivered a close from the real client → fire close on the user peer. */
	deliverClientClose(wsId: string, code: number, reason: string, wasClean: boolean): void {
		const entry = this._sockets.get(wsId)
		if (!entry || entry.closed) return
		entry.closed = true
		entry.userPeer.dispatchOrQueue({ type: 'close', code, reason, wasClean })
		entry.userPeer.readyState = CFWebSocket.CLOSED
		this._sockets.delete(wsId)
	}
}

/**
 * Peer attached to the user-facing `CFWebSocket` returned by
 * {@link WsGuestBridge.createBridgedSocket}. Pinned to `OPEN`/`accepted` so
 * bytes the user-peer sends (`peer._dispatchWSEvent` from `CFWebSocket.send`)
 * are forwarded to the host immediately without waiting for accept().
 */
class BridgeGuestPeer<O> extends CFWebSocket {
	private _wsId: string
	private _post: (msg: O) => void
	private _envelopes: WsGuestEnvelopes<O>
	private _onForget: (wsId: string) => void

	constructor(wsId: string, post: (msg: O) => void, envelopes: WsGuestEnvelopes<O>, onForget: (wsId: string) => void) {
		super()
		this._wsId = wsId
		this._post = post
		this._envelopes = envelopes
		this._onForget = onForget
		this._accepted = true
		this.readyState = CFWebSocket.OPEN
	}

	override _dispatchWSEvent(evt: WSEvent): void {
		if (evt.type === 'message' && evt.data !== undefined) {
			this._post(this._envelopes.remoteMessage(this._wsId, evt.data))
			return
		}
		if (evt.type === 'close') {
			this._post(this._envelopes.remoteClose(this._wsId, evt.code ?? 1000, evt.reason ?? '', evt.wasClean ?? true))
			this._onForget(this._wsId)
		}
	}
}
