/**
 * Cross-thread WebSocket bridge.
 *
 * The worker creates a `WebSocketPair` locally; `pair[0]` ships in the
 * Response, `pair[1]` stays for the user to interact with. Once main has
 * the response, the real client connects to main's `Bun.serve` upgrade.
 * This module wires the two halves:
 *
 *   user code → pair[1].send → pair[0] message event → ws-worker-send → main → real client
 *   real client → main → ws-client-message → pair[1] event → user listener
 *
 * Each bridged socket is identified by an opaque `wsId`.
 */

import type { CFWebSocket } from '../bindings/websocket-pair'
import { generateId } from '../tracing/context'
import type { WorkerMessage } from './protocol'

interface BridgedSocket {
	/** The user-facing peer (= `pair[1]`) — what the user calls accept/addEventListener/send on. */
	userPeer: CFWebSocket
	closed: boolean
}

export class WorkerWsBridge {
	private _sockets = new Map<string, BridgedSocket>()
	private _post: (msg: WorkerMessage) => void

	constructor(post: (msg: WorkerMessage) => void) {
		this._post = post
	}

	/**
	 * Hook up a `CFWebSocket` that's about to ship in a Response. The returned
	 * `wsId` goes into the serialized response so main can reconstruct.
	 */
	register(shipped: CFWebSocket): string {
		const wsId = generateId(8)
		const userPeer = shipped._peer
		if (!userPeer) {
			throw new Error('Response.webSocket has no peer — was it created via `new WebSocketPair()`?')
		}
		this._sockets.set(wsId, { userPeer, closed: false })

		// Register forwarding listeners BEFORE accepting — `accept()` flushes
		// any queued events (e.g. messages the user already sent via the server
		// peer before returning the response), and we'd lose them otherwise.
		shipped.addEventListener('message', (ev: Event) => {
			const data = (ev as MessageEvent).data
			this._post({ type: 'ws-worker-send', wsId, data })
		})
		shipped.addEventListener('close', (ev: Event) => {
			const ce = ev as CloseEvent
			this._post({ type: 'ws-worker-close', wsId, code: ce.code, reason: ce.reason })
			this._sockets.delete(wsId)
		})
		shipped.accept()

		return wsId
	}

	/** Main delivered a message from the real client → fire it on the user's peer. */
	deliverClientMessage(wsId: string, data: string | ArrayBuffer): void {
		const entry = this._sockets.get(wsId)
		if (!entry || entry.closed) return
		entry.userPeer.dispatchOrQueue({ type: 'message', data })
	}

	/** Main delivered a close from the real client → fire close on the user's peer. */
	deliverClientClose(wsId: string, code: number, reason: string, wasClean: boolean): void {
		const entry = this._sockets.get(wsId)
		if (!entry || entry.closed) return
		entry.closed = true
		entry.userPeer.dispatchOrQueue({ type: 'close', code, reason, wasClean })
		entry.userPeer.readyState = 3 // CLOSED
		this._sockets.delete(wsId)
	}
}
