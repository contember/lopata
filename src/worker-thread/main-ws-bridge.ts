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
import { generateId } from '../tracing/context'
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
		// The message handler in cli/dev.ts forwards inbound bytes by calling
		// `_dispatchWSEvent` directly only when `_accepted` is true — keep it
		// pinned so we're always ready to relay to the worker.
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
	/**
	 * Events that arrived from the worker before `createSocket()` was called for
	 * their wsId. Happens when the worker dispatches queued events during
	 * `accept()` (e.g. a `server.send()` issued before the response is shipped)
	 * — the post races ahead of the binding-fetch / fetch result.
	 */
	private _pendingEvents = new Map<string, WSEvent[]>()
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
		const pending = this._pendingEvents.get(wsId)
		if (pending) {
			cfSocket._eventQueue.push(...pending)
			this._pendingEvents.delete(wsId)
		}
		return cfSocket
	}

	/**
	 * Adopt an already-real `CFWebSocket` (typically the client peer returned
	 * from a DO/service binding inside `_dispatchBindingFetch`). The peer is
	 * already wired to its server counterpart, so we just need to keep it
	 * addressable by id when the worker echoes the response back up.
	 */
	adoptExisting(ws: CFWebSocket): string {
		const wsId = generateId(8)
		this._sockets.set(wsId, ws)
		return wsId
	}

	/** Look up a previously-adopted or created CFWebSocket. */
	getSocket(wsId: string): CFWebSocket | undefined {
		return this._sockets.get(wsId)
	}

	deliverWorkerSend(wsId: string, data: string | ArrayBuffer): void {
		const cfSocket = this._sockets.get(wsId)
		const evt: WSEvent = { type: 'message', data }
		if (!cfSocket) {
			this._bufferPending(wsId, evt)
			return
		}
		cfSocket.dispatchOrQueue(evt)
	}

	deliverWorkerClose(wsId: string, code: number, reason: string): void {
		const cfSocket = this._sockets.get(wsId)
		const evt: WSEvent = { type: 'close', code, reason, wasClean: true }
		if (!cfSocket) {
			this._bufferPending(wsId, evt)
			return
		}
		cfSocket.dispatchOrQueue(evt)
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
	 * for planned restarts.
	 */
	disposeAll(): void {
		for (const cfSocket of this._sockets.values()) {
			if (cfSocket.readyState === CFWebSocket.CLOSED) continue
			cfSocket.dispatchOrQueue({ type: 'close', code: 1012, reason: 'Service Restart', wasClean: true })
		}
		this._sockets.clear()
		// Drop anything still queued for a wsId that never reached createSocket
		// (e.g. binding-fetch errored after the worker pushed events).
		this._pendingEvents.clear()
	}
}
