/**
 * Main-thread side of the worker WebSocket bridge.
 *
 * For each worker-shipped WebSocket (identified by `wsId`) we build:
 *
 * - `cfSocket` — a real `CFWebSocket` we hand to `Bun.serve.upgrade`. Its
 *   message/close listeners (added by `cli/dev.ts`) forward outgoing bytes
 *   to the real client. We synthesise message events on this side whenever
 *   the worker emits `ws-worker-send`.
 *
 * - `cfSocket._peer` — a `BridgeWebSocketPeer` (subclass of `CFWebSocket`)
 *   that overrides `_dispatchWSEvent` to post the inbound event back to the
 *   worker instead of dispatching it locally.
 */

import { CFWebSocket, type WSEvent } from '../bindings/websocket-pair'
import type { WorkerCommand } from './protocol'

class BridgeWebSocketPeer extends CFWebSocket {
	private _post: (cmd: WorkerCommand) => void
	private _wsId: string
	private _onForget: (wsId: string) => void

	constructor(wsId: string, post: (cmd: WorkerCommand) => void, onForget: (wsId: string) => void) {
		super()
		this._wsId = wsId
		this._post = post
		this._onForget = onForget
		// `cli/dev.ts:467` requires `_accepted` so it dispatches inbound messages
		// without queuing — we're always ready to forward to the worker.
		this._accepted = true
		this.readyState = CFWebSocket.OPEN
	}

	override _dispatchWSEvent(evt: WSEvent): void {
		if (evt.type === 'message' && evt.data !== undefined) {
			this._post({ type: 'ws-client-message', wsId: this._wsId, data: evt.data })
			return
		}
		if (evt.type === 'close') {
			this._post({
				type: 'ws-client-close',
				wsId: this._wsId,
				code: evt.code ?? 1000,
				reason: evt.reason ?? '',
				wasClean: evt.wasClean ?? true,
			})
			this._onForget(this._wsId)
		}
	}
}

export class MainWsBridge {
	/** wsId → cfSocket (the side handed to `Bun.serve.upgrade`). */
	private _sockets = new Map<string, CFWebSocket>()
	private _post: (cmd: WorkerCommand) => void

	constructor(post: (cmd: WorkerCommand) => void) {
		this._post = post
	}

	createSocket(wsId: string): CFWebSocket {
		const cfSocket = new CFWebSocket()
		const peer = new BridgeWebSocketPeer(wsId, this._post, id => this._sockets.delete(id))
		cfSocket._peer = peer
		peer._peer = cfSocket
		this._sockets.set(wsId, cfSocket)
		return cfSocket
	}

	deliverWorkerSend(wsId: string, data: string | ArrayBuffer): void {
		const cfSocket = this._sockets.get(wsId)
		if (!cfSocket) return
		if (cfSocket._accepted) {
			cfSocket._dispatchWSEvent({ type: 'message', data })
		} else {
			cfSocket._eventQueue.push({ type: 'message', data })
		}
	}

	deliverWorkerClose(wsId: string, code: number, reason: string): void {
		const cfSocket = this._sockets.get(wsId)
		if (!cfSocket) return
		const evt: WSEvent = { type: 'close', code, reason, wasClean: true }
		if (cfSocket._accepted) {
			cfSocket._dispatchWSEvent(evt)
		} else {
			cfSocket._eventQueue.push(evt)
		}
		this._sockets.delete(wsId)
	}

	/**
	 * Notify any active real clients that this generation is going away, then
	 * drop them. Mirrors the `1012 Service Restart` close code WebSockets use
	 * for planned restarts.
	 */
	disposeAll(): void {
		for (const cfSocket of this._sockets.values()) {
			if (cfSocket.readyState === CFWebSocket.CLOSED) continue
			const evt: WSEvent = { type: 'close', code: 1012, reason: 'Service Restart', wasClean: true }
			if (cfSocket._accepted) {
				cfSocket._dispatchWSEvent(evt)
			} else {
				cfSocket._eventQueue.push(evt)
			}
		}
		this._sockets.clear()
	}
}
