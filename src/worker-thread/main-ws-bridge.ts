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
 * - `cfSocket._peer` — a `BridgeWebSocketPeer`. `cli/dev.ts` calls
 *   `_dispatchWSEvent` on it when the real client sends data, and reads
 *   `_accepted` / `readyState`. The peer's job: post `ws-client-message`
 *   to the worker so the user-facing pair fires its listener.
 */

import { CFWebSocket } from '../bindings/websocket-pair'
import type { WorkerCommand } from './protocol'

const OPEN = 1
const CLOSED = 3

class BridgeWebSocketPeer extends EventTarget {
	static readonly OPEN = OPEN
	static readonly CLOSED = CLOSED
	readyState: number = OPEN
	/** @internal Set so `cli/dev.ts:467` dispatches incoming messages immediately. */
	_accepted = true
	/** @internal Back-ref keeps the `cli/dev.ts` close handler happy. */
	_peer: CFWebSocket | null = null
	/** @internal Required by `cli/dev.ts` close handler — never used here. */
	_eventQueue: unknown[] = []
	/** @internal Required by hibernation API code paths; unused for plain WS. */
	_attachment: unknown = null

	private _post: (cmd: WorkerCommand) => void
	private _wsId: string

	constructor(wsId: string, post: (cmd: WorkerCommand) => void) {
		super()
		this._wsId = wsId
		this._post = post
	}

	_dispatchWSEvent(evt: { type: string; data?: string | ArrayBuffer; code?: number; reason?: string; wasClean?: boolean }): void {
		if (evt.type === 'message' && evt.data !== undefined) {
			this._post({ type: 'ws-client-message', wsId: this._wsId, data: evt.data })
			return
		}
		if (evt.type === 'close') {
			this.readyState = CLOSED
			this._post({
				type: 'ws-client-close',
				wsId: this._wsId,
				code: evt.code ?? 1000,
				reason: evt.reason ?? '',
				wasClean: evt.wasClean ?? true,
			})
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
		const peer = new BridgeWebSocketPeer(wsId, this._post)
		cfSocket._peer = peer as unknown as CFWebSocket
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
		const evt = { type: 'close' as const, code, reason, wasClean: true }
		if (cfSocket._accepted) {
			cfSocket._dispatchWSEvent(evt)
		} else {
			cfSocket._eventQueue.push(evt)
		}
		this._sockets.delete(wsId)
	}

	disposeAll(): void {
		for (const cfSocket of this._sockets.values()) {
			if (cfSocket.readyState !== CLOSED) cfSocket.readyState = CLOSED
		}
		this._sockets.clear()
	}
}
