/**
 * WebSocket bridge for isolated DO mode.
 *
 * Real WebSocket lives in the main thread (Bun.serve). The worker thread
 * gets a BridgeWebSocket proxy that forwards send/close via postMessage.
 * The main thread forwards incoming message/close/error events to the worker.
 *
 * Each bridged WebSocket is identified by a unique wsId.
 */

// --- Messages from worker → main ---
export type WsBridgeOutbound =
	| { type: 'ws-send'; wsId: string; data: string | ArrayBuffer }
	| { type: 'ws-close'; wsId: string; code?: number; reason?: string }
	| { type: 'ws-accept'; wsId: string; tags: string[] }

// --- Messages from main → worker ---
export type WsBridgeInbound =
	| { type: 'ws-message'; wsId: string; data: string | ArrayBuffer }
	| { type: 'ws-close'; wsId: string; code: number; reason: string; wasClean: boolean }
	| { type: 'ws-error'; wsId: string }

/**
 * A WebSocket proxy that lives in the worker thread.
 * Implements enough of the WebSocket interface for DO's state.acceptWebSocket().
 */
export class BridgeWebSocket extends EventTarget {
	readonly wsId: string
	readyState = 1 // OPEN
	private _postMessage: (msg: WsBridgeOutbound) => void
	private _attachment: any = null

	constructor(wsId: string, postMessage: (msg: WsBridgeOutbound) => void) {
		super()
		this.wsId = wsId
		this._postMessage = postMessage
	}

	serializeAttachment(attachment: any): void {
		this._attachment = JSON.parse(JSON.stringify(attachment))
	}

	deserializeAttachment(): any | null {
		return this._attachment
	}

	send(data: string | ArrayBuffer): void {
		if (this.readyState !== 1) return
		this._postMessage({ type: 'ws-send', wsId: this.wsId, data })
	}

	close(code?: number, reason?: string): void {
		if (this.readyState >= 2) return
		this.readyState = 2 // CLOSING
		this._postMessage({ type: 'ws-close', wsId: this.wsId, code, reason })
		this.readyState = 3 // CLOSED
	}

	/** @internal Called by the worker entry when the main thread forwards a message */
	_onMessage(data: string | ArrayBuffer): void {
		this.dispatchEvent(new MessageEvent('message', { data }))
	}

	/** @internal Called by the worker entry when the main thread forwards a close */
	_onClose(code: number, reason: string, wasClean: boolean): void {
		this.readyState = 3
		this.dispatchEvent(new CloseEvent('close', { code, reason, wasClean }))
	}

	/** @internal Called by the worker entry when the main thread forwards an error */
	_onError(): void {
		this.dispatchEvent(new Event('error'))
	}

	/** Signal that this WS has been accepted by the DO (via state.acceptWebSocket) */
	_signalAccepted(tags: string[]): void {
		this._postMessage({ type: 'ws-accept', wsId: this.wsId, tags })
	}
}
