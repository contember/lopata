/**
 * Cloudflare-compatible WebSocketPair for regular Workers.
 *
 * Creates two linked in-memory WebSocket-like objects.
 * Messages sent on one side appear on the other.
 * Events are buffered until accept() is called.
 */

type WSEventType = 'message' | 'close' | 'error' | 'open'

interface WSEvent {
	type: WSEventType
	data?: string | ArrayBuffer
	code?: number
	reason?: string
	wasClean?: boolean
}

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

/**
 * A single side of a WebSocketPair. Implements the CF WebSocket interface
 * with accept() gating — events are queued until accept() is called.
 */
export class CFWebSocket extends EventTarget {
	static readonly CONNECTING = CONNECTING
	static readonly OPEN = OPEN
	static readonly CLOSING = CLOSING
	static readonly CLOSED = CLOSED

	readonly CONNECTING = CONNECTING
	readonly OPEN = OPEN
	readonly CLOSING = CLOSING
	readonly CLOSED = CLOSED

	readyState: number = CONNECTING

	/** @internal */ _peer: CFWebSocket | null = null
	/** @internal */ _accepted = false
	/** @internal */ _eventQueue: WSEvent[] = []
	/** @internal */ _attachment: any = null

	// Callback-style handlers (standard WebSocket compat)
	onopen: ((ev: Event) => void) | null = null
	onmessage: ((ev: MessageEvent) => void) | null = null
	onclose: ((ev: CloseEvent) => void) | null = null
	onerror: ((ev: Event) => void) | null = null

	/**
	 * CF-specific: attach serializable data to this WebSocket.
	 * Survives hibernation in production; here it's just in-memory.
	 */
	serializeAttachment(attachment: any): void {
		this._attachment = JSON.parse(JSON.stringify(attachment))
	}

	deserializeAttachment(): any | null {
		return this._attachment
	}

	/**
	 * CF-specific: begin dispatching events.
	 * Must be called before messages can be sent or received.
	 */
	accept(): void {
		if (this._accepted) return
		this._accepted = true
		this.readyState = OPEN

		// Flush queued events
		const queue = this._eventQueue
		this._eventQueue = []
		for (const evt of queue) {
			this._dispatchWSEvent(evt)
		}
	}

	send(message: string | ArrayBuffer | ArrayBufferView): void {
		if (this.readyState !== OPEN) {
			throw new Error('WebSocket is not open')
		}

		const peer = this._peer
		if (!peer || peer.readyState === CLOSED) return

		// Normalize ArrayBufferView to ArrayBuffer
		let data: string | ArrayBuffer
		if (ArrayBuffer.isView(message)) {
			data = (message.buffer as ArrayBuffer).slice(message.byteOffset, message.byteOffset + message.byteLength)
		} else {
			data = message
		}

		const evt: WSEvent = { type: 'message', data }
		if (peer._accepted) {
			peer._dispatchWSEvent(evt)
		} else {
			peer._eventQueue.push(evt)
		}
	}

	close(code?: number, reason?: string): void {
		if (this.readyState === CLOSED || this.readyState === CLOSING) return

		this.readyState = CLOSING

		const peer = this._peer
		const closeEvt: WSEvent = {
			type: 'close',
			code: code ?? 1000,
			reason: reason ?? '',
			wasClean: true,
		}

		// Notify peer about closure
		if (peer && peer.readyState !== CLOSED && peer.readyState !== CLOSING) {
			if (peer._accepted) {
				peer._dispatchWSEvent(closeEvt)
			} else {
				peer._eventQueue.push(closeEvt)
			}
			peer.readyState = CLOSED
		}

		// Notify self
		this.readyState = CLOSED
		if (this._accepted) {
			this._dispatchWSEvent(closeEvt)
		} else {
			this._eventQueue.push(closeEvt)
		}
	}

	/** @internal */
	_dispatchWSEvent(evt: WSEvent): void {
		switch (evt.type) {
			case 'message': {
				const me = new MessageEvent('message', { data: evt.data })
				this.dispatchEvent(me)
				this.onmessage?.(me)
				break
			}
			case 'close': {
				const ce = new CloseEvent('close', {
					code: evt.code,
					reason: evt.reason,
					wasClean: evt.wasClean,
				})
				this.dispatchEvent(ce)
				this.onclose?.(ce)
				break
			}
			case 'error': {
				const ee = new Event('error')
				this.dispatchEvent(ee)
				this.onerror?.(ee)
				break
			}
			case 'open': {
				const oe = new Event('open')
				this.dispatchEvent(oe)
				this.onopen?.(oe)
				break
			}
		}
	}
}

/**
 * Cloudflare WebSocketPair — creates two linked CFWebSocket instances.
 *
 * Usage:
 *   const pair = new WebSocketPair();
 *   const [client, server] = Object.values(pair);
 */
export class WebSocketPair {
	readonly 0: CFWebSocket
	readonly 1: CFWebSocket

	constructor() {
		const a = new CFWebSocket()
		const b = new CFWebSocket()
		a._peer = b
		b._peer = a
		this[0] = a
		this[1] = b
	}
}
