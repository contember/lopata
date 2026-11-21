/**
 * `cloudflare:sockets` — TCP sockets as workerd exposes them (src/workerd/api/sockets.c++).
 *
 * A {@link Socket} wraps a {@link Transport}:
 *  - {@link TcpTransport}: a real TCP connection over `Bun.connect()` / `Bun.listen()`, with TLS and STARTTLS;
 *  - {@link PortTransport}: a `MessagePort` whose other end is another socket. Service-binding `connect()` and inbound
 *    connections to a worker's `connect()` handler cross threads this way: the caller keeps one port, the handler's
 *    worker thread gets the other.
 */

import { NativeReadableStream } from './cf-streams'

export type SecureTransport = 'off' | 'on' | 'starttls'

export interface SocketAddress {
	hostname: string
	port: number
}

export interface SocketOptions {
	secureTransport?: string
	allowHalfOpen?: boolean
	highWaterMark?: number
}

export interface TlsOptions {
	expectedServerHostname?: string
}

export interface SocketInfo {
	remoteAddress?: string
	localAddress?: string
}

const PROXY_FAILED = 'proxy request failed, cannot connect to the specified address'
const CONNECTION_LOST = 'Network connection lost.'
const SOCKET_CLOSED = 'This socket has been closed.'
/** workerd neuters the handler's socket when `connect()` settles (global-scope.c++, NeuterReason::CLIENT_DISCONNECTED). */
const HANDLER_RETURNED = "Can't read from request stream because client disconnected."

/** Chunks the receiving side of a port may hold before it acknowledges one (see `PortTransport`). */
const PORT_WINDOW = 8
const READABLE_HIGH_WATER_MARK = 8

// ─── Addresses and options ──────────────────────────────────────────

export interface ParsedAddress {
	/** The address as given: `host:port`. Reported as `remoteAddress` and, for a service binding, as the handler's `localAddress`. */
	address: string
	/** Hostname for DNS and TLS, without IPv6 brackets. */
	hostname: string
	port: number
	/** 80 or 443: a failure to connect hints at `fetch()`. */
	isDefaultFetchPort: boolean
}

/** Same checks and messages as workerd's `isValidHost()` and `connectImplNoOutputLock()`. */
export function parseSocketAddress(address: SocketAddress | string): ParsedAddress {
	let hostname: string
	let port: string
	let text: string
	if (typeof address === 'string') {
		let url: URL
		try {
			url = new URL(`fake://${address}`)
		} catch {
			throw new TypeError('Specified address could not be parsed.')
		}
		if (url.hostname === '') throw new TypeError('Specified address is missing hostname.')
		if (url.port === '') throw new TypeError('Specified address is missing port.')
		hostname = url.hostname
		port = url.port
		text = address
	} else if (typeof address === 'object' && address !== null) {
		hostname = String(address.hostname)
		port = String(toUint16(address.port))
		text = `${hostname}:${port}`
	} else {
		throw new TypeError('Specified address could not be parsed.')
	}
	if (!isValidHost(text)) {
		throw new TypeError('Specified address is empty string, contains unsupported characters or is too long.')
	}
	const portNumber = Number(port)
	return {
		address: text,
		hostname: hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname,
		port: portNumber,
		isDefaultFetchPort: portNumber === 80 || portNumber === 443,
	}
}

/** workerd's conversion of a `uint16_t` struct field (jsg/value.h): finite, non-negative, at most 65535, truncated. */
function toUint16(value: unknown): number {
	const number = Number(value)
	if (!Number.isFinite(number)) throw new TypeError('The value cannot be converted because it is not an integer.')
	if (number < 0) throw new TypeError('The value cannot be converted because it is negative and this API expects a positive number.')
	if (number > 65535) throw new TypeError('Value out of range. Must be less than or equal to 65535.')
	return Math.trunc(number)
}

function isValidHost(host: string): boolean {
	return host.length > 0 && host.length <= 255 && /^[A-Za-z0-9\-._[\]:]+$/.test(host)
}

interface ParsedOptions {
	secureTransport: SecureTransport
	allowHalfOpen: boolean
	highWaterMark: number | undefined
}

function parseSocketOptions(options: SocketOptions | undefined): ParsedOptions {
	const value = options?.secureTransport
	let secureTransport: SecureTransport
	if (value === undefined || value === 'off') secureTransport = 'off'
	else if (value === 'on' || value === 'starttls') secureTransport = value
	else throw new TypeError(`Unsupported value in secureTransport socket option: ${value}`)
	return {
		secureTransport,
		allowHalfOpen: Boolean(options?.allowHalfOpen),
		highWaterMark: options?.highWaterMark === undefined ? undefined : Number(options.highWaterMark),
	}
}

// ─── Transports ─────────────────────────────────────────────────────

interface TransportEvents {
	data(chunk: Uint8Array): void
	/** The peer finished sending (TCP FIN). */
	end(): void
	/** The connection is gone; `error` when it broke rather than closed. */
	closed(error?: Error): void
}

interface Transport {
	/** Settles once the peer accepted the connection (for TLS: after a verified handshake); rejects with the cause otherwise. */
	readonly opened: Promise<void>
	attach(events: TransportEvents): void
	/** Resolves once the whole chunk was handed to the connection; waits while the peer is not reading. */
	write(chunk: Uint8Array): Promise<void>
	/** Half-close: the peer sees end of data, reading continues. */
	shutdownWrite(): void
	close(): void
	/** The reader wants more data. */
	resume(): void
	/** The reader's queue is full. */
	pause(): void
	/** Prepare a TLS upgrade: `transport` carries the secured connection once `begin()` hands it over. */
	upgrade(): { transport: Transport; begin(serverName: string): void }
	/** The connection could not be established: `opened` rejects with `error`. */
	fail(error: Error): void
}

type BunSocket = import('bun').Socket<TcpTransport>

const TCP_HANDLERS: import('bun').SocketHandler<TcpTransport> = {
	open: socket => socket.data.onOpen(socket),
	handshake: (socket, success, authorizationError) => socket.data.onHandshake(success, authorizationError),
	data: (socket, data) => socket.data.onData(data),
	drain: socket => socket.data.onDrain(),
	end: socket => socket.data.onEnd(),
	close: (socket, error) => socket.data.onClose(error),
	error: (socket, error) => socket.data.onError(error),
	connectError: (socket, error) => socket.data.fail(error),
}

/** A TCP connection; with `tls`, `opened` waits for a handshake whose certificate verified (system CAs plus `NODE_EXTRA_CA_CERTS`). */
class TcpTransport implements Transport {
	private readonly openedResolvers = Promise.withResolvers<void>()
	readonly opened = this.openedResolvers.promise
	private socket: BunSocket | null = null
	private events: TransportEvents | null = null
	private drainWaiters: (() => void)[] = []
	private isOpen = false
	private isClosed = false
	/** Set on the plaintext transport once its connection was handed to a TLS upgrade: its own events are the ciphertext. */
	private detached = false

	constructor(private readonly tls: boolean) {
		this.opened.catch(() => {})
	}

	static connect(hostname: string, port: number, tls: { serverName: string } | null): TcpTransport {
		const transport = new TcpTransport(tls !== null)
		try {
			Bun.connect({ hostname, port, tls: tls ?? undefined, allowHalfOpen: true, data: transport, socket: TCP_HANDLERS }).catch(error => {
				transport.fail(error)
			})
		} catch (error) {
			transport.fail(error instanceof Error ? error : new Error(String(error)))
		}
		return transport
	}

	/** A connection a `Bun.listen()` listener accepted; the listener's handlers come from {@link tcpListenerHandlers}. */
	static accepted(socket: BunSocket): TcpTransport {
		const transport = new TcpTransport(false)
		socket.data = transport
		transport.onOpen(socket)
		return transport
	}

	attach(events: TransportEvents): void {
		this.events = events
	}

	onOpen(socket: BunSocket): void {
		this.socket = socket
		if (this.isClosed) {
			// Closed while connecting.
			socket.terminate()
			return
		}
		if (this.tls) return
		this.isOpen = true
		this.openedResolvers.resolve()
	}

	onHandshake(success: boolean, authorizationError: Error | null): void {
		if (!this.tls || this.detached || this.isOpen) return
		if (!success) {
			this.fail(authorizationError ?? new Error('TLS handshake failed'))
			this.socket?.terminate()
			return
		}
		this.isOpen = true
		this.openedResolvers.resolve()
	}

	onData(data: Uint8Array): void {
		if (this.detached || !this.isOpen) return
		// A copy: Bun may reuse the buffer it hands to the callback.
		this.events?.data(new Uint8Array(data))
	}

	onDrain(): void {
		const waiters = this.drainWaiters
		this.drainWaiters = []
		for (const wake of waiters) wake()
	}

	onEnd(): void {
		if (this.detached || !this.isOpen) return
		this.events?.end()
	}

	onError(error: Error): void {
		if (this.detached) return
		if (!this.isOpen) this.fail(error)
		else this.finish(error)
	}

	onClose(error?: Error): void {
		if (this.detached) return
		if (!this.isOpen) this.fail(error ?? new Error(CONNECTION_LOST))
		else this.finish(error)
	}

	/** The connection could not be established. */
	fail(error: Error): void {
		if (this.isOpen || this.isClosed) return
		this.isClosed = true
		this.openedResolvers.reject(error)
		this.onDrain()
	}

	private finish(error?: Error): void {
		if (this.isClosed) return
		this.isClosed = true
		this.onDrain()
		this.events?.closed(error)
	}

	async write(chunk: Uint8Array): Promise<void> {
		await this.opened
		let rest = chunk
		while (rest.byteLength > 0) {
			const socket = this.socket
			if (!socket || this.isClosed || this.detached) throw new Error(CONNECTION_LOST)
			const written = socket.write(rest)
			if (written < 0) throw new Error(CONNECTION_LOST)
			if (written >= rest.byteLength) return
			rest = rest.subarray(written)
			// The kernel buffer is full; Bun calls `drain` once it has room again.
			await new Promise<void>(resolve => this.drainWaiters.push(resolve))
		}
	}

	shutdownWrite(): void {
		if (this.isClosed || this.detached) return
		// The argumentless form sends FIN and keeps reading; see tests/bun-runtime-assumptions.test.ts.
		this.socket?.shutdown()
	}

	close(): void {
		if (this.detached) return
		if (!this.isOpen) {
			this.fail(new Error(SOCKET_CLOSED))
			return
		}
		this.socket?.end()
		this.finish()
	}

	resume(): void {
		if (this.isOpen && !this.isClosed && !this.detached) this.socket?.resume()
	}

	pause(): void {
		if (this.isOpen && !this.isClosed && !this.detached) this.socket?.pause()
	}

	upgrade(): { transport: Transport; begin(serverName: string): void } {
		const next = new TcpTransport(true)
		return {
			transport: next,
			begin: serverName => {
				const socket = this.socket
				if (!socket || this.isClosed) {
					next.fail(new TypeError('The connection was closed before startTls completed.'))
					return
				}
				this.detached = true
				socket.upgradeTLS({ data: next, tls: { serverName }, socket: TCP_HANDLERS })
			},
		}
	}
}

/** Handlers for a `Bun.listen()` listener: `onConnection` gets each accepted connection, e.g. for {@link relayTcpConnection}. */
export function tcpListenerHandlers(onConnection: (socket: BunSocket) => void): import('bun').SocketHandler<TcpTransport> {
	return { ...TCP_HANDLERS, open: onConnection }
}

/** The secured half of a STARTTLS upgrade on a connection that cannot run a TLS handshake. */
class NoTlsTransport implements Transport {
	private readonly openedResolvers = Promise.withResolvers<void>()
	readonly opened = this.openedResolvers.promise

	constructor() {
		this.opened.catch(() => {})
	}

	fail(error: Error): void {
		this.openedResolvers.reject(error)
	}

	attach(): void {}

	async write(): Promise<void> {
		await this.opened
	}

	shutdownWrite(): void {}

	close(): void {
		this.fail(new Error(SOCKET_CLOSED))
	}

	resume(): void {}

	pause(): void {}

	upgrade(): never {
		throw new TypeError('Cannot startTls on a TLS socket.')
	}
}

/** Messages on a socket's MessagePort; both ends speak the same protocol. */
type PortMessage =
	/** The connect() handler took the connection (sent by the accepting end). */
	| { type: 'accept' }
	/** No handler took the connection (sent by the accepting end, followed by closing the port). */
	| { type: 'refuse'; reason: string }
	| { type: 'data'; chunk: Uint8Array }
	/** The receiver consumed a chunk: the sender may send one more. */
	| { type: 'ack' }
	/** The sender finished sending. */
	| { type: 'end' }
	/** The sender closed the connection; the port closes next. A port that closes without it lost its thread. */
	| { type: 'close' }

/**
 * One end of a connection carried over a MessagePort. The sender holds {@link PORT_WINDOW} credits and spends one per
 * chunk; the receiver returns one each time its readable has room, so a peer that stops reading stops the writer.
 */
class PortTransport implements Transport {
	private readonly openedResolvers = Promise.withResolvers<void>()
	readonly opened = this.openedResolvers.promise
	private events: TransportEvents | null = null
	private credits = PORT_WINDOW
	private creditWaiters: (() => void)[] = []
	private isOpen = false
	private isClosed = false
	private sentClose = false

	/** `accepting`: the end handed to a connect() handler, already open. Otherwise `opened` waits for the handler's `accept`. */
	constructor(private readonly port: MessagePort, accepting: boolean) {
		this.opened.catch(() => {})
		if (accepting) this.markOpen()
		port.onmessage = event => this.onMessage(event.data)
		port.addEventListener('close', () => this.onPortClosed())
	}

	attach(events: TransportEvents): void {
		this.events = events
	}

	/** Accepting end: the handler took the connection. */
	accept(): void {
		this.post({ type: 'accept' })
	}

	/** Accepting end: no handler took the connection. */
	refuse(reason: string): void {
		this.post({ type: 'refuse', reason })
		this.sentClose = true
		this.isClosed = true
		this.port.close()
	}

	/** The connection could not be established. */
	fail(error: Error): void {
		if (this.isOpen || this.isClosed) return
		this.isClosed = true
		this.openedResolvers.reject(error)
		this.wakeWriters()
		this.closePort()
	}

	private markOpen(): void {
		this.isOpen = true
		this.openedResolvers.resolve()
	}

	private onMessage(message: PortMessage): void {
		switch (message.type) {
			case 'accept':
				if (!this.isOpen && !this.isClosed) this.markOpen()
				return
			case 'refuse':
				this.fail(new Error(message.reason))
				return
			case 'data':
				if (this.isOpen) this.events?.data(message.chunk)
				return
			case 'ack':
				this.credits++
				this.wakeWriters()
				return
			case 'end':
				if (this.isOpen) this.events?.end()
				return
			case 'close':
				this.finish()
				this.closePort()
				return
		}
	}

	private onPortClosed(): void {
		// A clean close was announced first; anything else means the other thread went away.
		if (!this.isOpen) this.fail(new Error(CONNECTION_LOST))
		else this.finish(new Error(CONNECTION_LOST))
	}

	private finish(error?: Error): void {
		if (this.isClosed) return
		this.isClosed = true
		this.wakeWriters()
		this.events?.closed(error)
	}

	private wakeWriters(): void {
		const waiters = this.creditWaiters
		this.creditWaiters = []
		for (const wake of waiters) wake()
	}

	private post(message: PortMessage): void {
		if (this.sentClose) return
		this.port.postMessage(message)
	}

	private closePort(): void {
		if (!this.sentClose) {
			this.sentClose = true
			this.port.postMessage({ type: 'close' } satisfies PortMessage)
		}
		this.port.close()
	}

	async write(chunk: Uint8Array): Promise<void> {
		await this.opened
		while (this.credits === 0 && !this.isClosed) {
			await new Promise<void>(resolve => this.creditWaiters.push(resolve))
		}
		if (this.isClosed) throw new Error(CONNECTION_LOST)
		this.credits--
		this.post({ type: 'data', chunk })
	}

	shutdownWrite(): void {
		if (!this.isClosed) this.post({ type: 'end' })
	}

	close(): void {
		if (!this.isOpen) {
			this.fail(new Error(SOCKET_CLOSED))
			return
		}
		this.finish()
		this.closePort()
	}

	resume(): void {
		if (this.isOpen && !this.isClosed) this.post({ type: 'ack' })
	}

	pause(): void {}

	upgrade(): { transport: Transport; begin(serverName: string): void } {
		const next = new NoTlsTransport()
		return {
			transport: next,
			begin: () => {
				this.close()
				next.fail(new Error('startTls() is not supported on this connection.'))
			},
		}
	}
}

// ─── Socket ─────────────────────────────────────────────────────────

interface SocketInit {
	info: SocketInfo
	secureTransport: SecureTransport
	allowHalfOpen: boolean
	highWaterMark?: number
	/** The hostname a STARTTLS upgrade verifies; null once upgraded and for sockets that cannot upgrade. */
	domain: string | null
	/** When set, a failed connection rejects with `Error(openErrorMessage)` (the cause attached) instead of the cause. */
	openErrorMessage?: string
}

const NEUTER = Symbol('lopata.socket.neuter')

export class Socket {
	readonly readable: ReadableStream<Uint8Array>
	readonly writable: WritableStream<Uint8Array>
	readonly opened: Promise<SocketInfo>
	readonly closed: Promise<void>

	#transport: Transport
	#init: SocketInfo
	#secureTransport: SecureTransport
	#allowHalfOpen: boolean
	#domain: string | null
	#upgraded = false
	#closing = false
	#closedSettled = false
	#closedResolvers = Promise.withResolvers<void>()
	#readController: ReadableStreamDefaultController<Uint8Array>
	#writeController: WritableStreamDefaultController
	/** No more data reaches `readable`: the peer finished, the reader cancelled, or the socket closed. */
	#readDone = false
	/** `writable` accepts no more chunks: closed by its owner, by `allowHalfOpen: false`, or with the socket. */
	#writeDone = false
	/** Error the next write rejects with once the socket is no longer writable. */
	#writeError: Error | null = null
	/** The chunk the sink is writing right now; `startTls()` and `close()` wait for it. */
	#inflight: Promise<void> | null = null

	constructor(transport: Transport, init: SocketInit) {
		this.#transport = transport
		this.#init = init.info
		this.#secureTransport = init.secureTransport
		this.#allowHalfOpen = init.allowHalfOpen
		this.#domain = init.domain

		this.closed = this.#closedResolvers.promise
		this.closed.catch(() => {})
		const controllers: { read?: ReadableStreamDefaultController<Uint8Array>; write?: WritableStreamDefaultController } = {}

		this.readable = new NativeReadableStream<Uint8Array>(
			{
				start: controller => {
					controllers.read = controller
				},
				pull: () => {
					if (!this.#readDone) this.#transport.resume()
				},
				cancel: () => {
					this.#readDone = true
					this.#transport.pause()
				},
			},
			new CountQueuingStrategy({ highWaterMark: READABLE_HIGH_WATER_MARK }),
		)

		this.writable = new WritableStream<Uint8Array>(
			{
				start: controller => {
					controllers.write = controller
				},
				write: (chunk: unknown) => {
					const write = this.#write(chunk)
					this.#inflight = write
					return write.finally(() => {
						if (this.#inflight === write) this.#inflight = null
					})
				},
				close: () => {
					this.#writeDone = true
					this.#transport.shutdownWrite()
				},
				abort: () => {
					this.#writeDone = true
					this.#transport.shutdownWrite()
				},
			},
			init.highWaterMark === undefined ? undefined : new ByteLengthQueuingStrategy({ highWaterMark: init.highWaterMark }),
		)
		// Both constructors call start() synchronously.
		if (!controllers.read || !controllers.write) throw new Error('stream start() did not run during construction')
		this.#readController = controllers.read
		this.#writeController = controllers.write

		this.opened = transport.opened.then(
			() => ({ remoteAddress: this.#init.remoteAddress, localAddress: this.#init.localAddress }),
			(cause: unknown) => {
				const error = init.openErrorMessage !== undefined
					? new Error(init.openErrorMessage, { cause })
					: cause instanceof Error
					? cause
					: new Error(String(cause))
				this.#failConnection(error)
				throw error
			},
		)
		this.opened.catch(() => {})

		transport.attach({
			data: chunk => this.#onData(chunk),
			end: () => this.#onEnd(),
			closed: error => this.#onClosed(error),
		})
	}

	get upgraded(): boolean {
		return this.#upgraded
	}

	get secureTransport(): SecureTransport {
		return this.#secureTransport
	}

	close(): Promise<void> {
		if (this.#closing) return this.closed
		this.#closing = true
		return (async () => {
			await this.opened.then(() => {}, () => {})
			await this.#flush()
			this.#shutStreams(new TypeError(SOCKET_CLOSED))
			this.#transport.close()
			this.#settleClosed()
		})()
	}

	startTls(options?: TlsOptions): Socket {
		if (this.#secureTransport === 'on') throw new TypeError('Cannot startTls on a TLS socket.')
		if (this.#closing || this.#closedSettled) throw new TypeError('The connection was closed before startTls could be started.')
		if (this.#secureTransport !== 'starttls') {
			throw new TypeError("The `secureTransport` socket option must be set to 'starttls' for startTls to be used.")
		}
		const domain = this.#domain
		if (domain === null) throw new TypeError('startTls has already been called on this socket, or the socket was transferred over RPC.')
		this.#domain = null
		const upgrade = this.#transport.upgrade()
		const secured = new Socket(upgrade.transport, {
			info: this.#init,
			secureTransport: 'on',
			allowHalfOpen: this.#allowHalfOpen,
			domain,
		})
		const serverName = options?.expectedServerHostname ?? domain
		void (async () => {
			// startTls() may be called right after connect(); the handshake needs the connection.
			const failure = await this.opened.then(() => null, (error: Error) => error)
			if (failure) {
				upgrade.transport.fail(failure)
				return
			}
			await this.#flush()
			// The plaintext streams end here; the bytes that follow are the handshake.
			this.#upgraded = true
			this.#shutStreams(new TypeError('The socket was upgraded to TLS by startTls().'))
			this.#settleClosed()
			upgrade.begin(serverName)
		})()
		return secured
	}

	/** The connect() handler settled: the connection is over, and late reads or writes fail as in workerd. */
	[NEUTER](): void {
		if (this.#closedSettled) return
		this.#shutStreams(new TypeError(HANDLER_RETURNED))
		this.#transport.close()
		this.#settleClosed()
	}

	async #write(chunk: unknown): Promise<void> {
		if (!ArrayBuffer.isView(chunk)) throw new TypeError('This WritableStream only supports writing byte types.')
		if (this.#writeError) throw this.#writeError
		await this.opened
		if (this.#writeError) throw this.#writeError
		const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
		await this.#transport.write(bytes)
	}

	/** Wait until every chunk queued on `writable` has been handed to the transport. */
	async #flush(): Promise<void> {
		for (;;) {
			const inflight = this.#inflight
			if (inflight) await inflight.catch(() => {})
			// The stream hands its next queued chunk to the sink a few microtasks after the previous write settled.
			await new Promise(resolve => setImmediate(resolve))
			if (!this.#inflight) return
		}
	}

	#onData(chunk: Uint8Array): void {
		if (this.#readDone) return
		this.#readController.enqueue(chunk)
		if ((this.#readController.desiredSize ?? 0) <= 0) this.#transport.pause()
	}

	#onEnd(): void {
		this.#endReadable()
		if (!this.#allowHalfOpen) void this.#closeWriteSide()
	}

	/** `allowHalfOpen: false`: once the peer finished, finish sending what is queued and close our side too. */
	async #closeWriteSide(): Promise<void> {
		if (this.#writeDone) return
		await this.#flush()
		if (this.#writeDone) return
		this.#writeDone = true
		this.#writeError = new TypeError('This WritableStream has been closed.')
		this.#transport.shutdownWrite()
	}

	#onClosed(error?: Error): void {
		if (error) {
			this.#shutStreams(error, error)
			this.#settleClosed(error)
			return
		}
		this.#endReadable()
		if (!this.#writeError) this.#writeError = new Error(CONNECTION_LOST)
		this.#settleClosed()
	}

	/** The connection failed before it opened: what `opened` rejects with, `closed` and both streams report too. */
	#failConnection(error: Error): void {
		this.#shutStreams(undefined, error)
		this.#settleClosed(error)
	}

	#endReadable(): void {
		if (this.#readDone) return
		this.#readDone = true
		try {
			this.#readController.close()
		} catch {}
	}

	/** End both streams: pending reads finish (or fail with `readError`), writes fail with `writeError`. */
	#shutStreams(writeError?: Error, readError?: Error): void {
		if (!this.#readDone) {
			this.#readDone = true
			try {
				if (readError) this.#readController.error(readError)
				else this.#readController.close()
			} catch {}
		}
		const error = writeError ?? readError ?? new TypeError(SOCKET_CLOSED)
		this.#writeError = error
		if (!this.#writeDone) {
			this.#writeDone = true
			this.#writeController.error(error)
		}
	}

	#settleClosed(error?: Error): void {
		if (this.#closedSettled) return
		this.#closedSettled = true
		if (error) this.#closedResolvers.reject(error)
		else this.#closedResolvers.resolve()
	}
}

// ─── Entry points ───────────────────────────────────────────────────

/** `connect()` from `cloudflare:sockets`: an outbound TCP connection. */
export function connect(address: SocketAddress | string, options?: SocketOptions): Socket {
	const parsed = parseSocketAddress(address)
	const opts = parseSocketOptions(options)
	const transport = TcpTransport.connect(parsed.hostname, parsed.port, opts.secureTransport === 'on' ? { serverName: parsed.hostname } : null)
	return new Socket(transport, {
		info: { remoteAddress: parsed.address },
		secureTransport: opts.secureTransport,
		allowHalfOpen: opts.allowHalfOpen,
		highWaterMark: opts.highWaterMark,
		domain: parsed.hostname,
		openErrorMessage: parsed.isDefaultFetchPort
			? `${PROXY_FAILED}. It looks like you might be trying to connect to a HTTP-based service — consider using fetch instead`
			: PROXY_FAILED,
	})
}

/**
 * `connect()` on a service binding: a socket whose peer is the target worker's connect() handler. `deliver` hands the
 * other end of the port to the target (possibly in another thread) together with the address the caller passed.
 */
export function connectThroughPort(
	address: SocketAddress | string,
	options: SocketOptions | undefined,
	deliver: (port: MessagePort, address: string) => void,
): Socket {
	const parsed = parseSocketAddress(address)
	const opts = parseSocketOptions(options)
	const { port1, port2 } = new MessageChannel()
	const transport = new PortTransport(port1, false)
	const socket = new Socket(transport, {
		info: { remoteAddress: parsed.address },
		secureTransport: opts.secureTransport,
		allowHalfOpen: opts.allowHalfOpen,
		highWaterMark: opts.highWaterMark,
		domain: parsed.hostname,
		openErrorMessage: PROXY_FAILED,
	})
	if (opts.secureTransport === 'on') {
		// workerd refuses it unless the target enables connect_handler_immediate_tls (worker-entrypoint.c++).
		port2.close()
		transport.fail(new Error('Incoming CONNECT with TLS not supported'))
		return socket
	}
	try {
		deliver(port2, parsed.address)
	} catch (error) {
		port2.close()
		transport.fail(error instanceof Error ? error : new Error(String(error)))
	}
	return socket
}

/** Refuse a connection delivered over `port` before any socket was built for it (e.g. the target worker is gone). */
export function refuseConnection(port: MessagePort, reason: string): void {
	new PortTransport(port, true).refuse(reason)
}

/**
 * Serve a connection delivered over `port` with a connect() handler. `run` calls the handler with the socket and calls
 * `accept` once the handler exists; a `run` that throws before accepting refuses the connection. When `run` settles the
 * socket closes, as workerd closes the handler's socket when `connect()` returns.
 */
export async function serveConnection(
	port: MessagePort,
	info: SocketInfo,
	run: (socket: Socket, accept: () => void) => Promise<void>,
): Promise<void> {
	const transport = new PortTransport(port, true)
	// The handler is the server side: it may keep sending after the peer finished.
	const socket = new Socket(transport, { info, secureTransport: 'off', allowHalfOpen: true, domain: null })
	let accepted = false
	try {
		await run(socket, () => {
			accepted = true
			transport.accept()
		})
	} catch (error) {
		if (!accepted) transport.refuse(error instanceof Error ? error.message : String(error))
		throw error
	} finally {
		socket[NEUTER]()
	}
}

/** End the connection of a connect() handler that was abandoned (its command failed), as if the handler had returned. */
export function abandonConnection(socket: Socket): void {
	socket[NEUTER]()
}

/**
 * Relay a TCP connection a listener accepted to a connect() handler behind `port`, until either side closes.
 * Resolves once the TCP connection is closed.
 */
export async function relayTcpConnection(tcpSocket: BunSocket, port: MessagePort): Promise<void> {
	const tcp = new Socket(TcpTransport.accepted(tcpSocket), { info: {}, secureTransport: 'off', allowHalfOpen: true, domain: null })
	const handler = new Socket(new PortTransport(port, false), { info: {}, secureTransport: 'off', allowHalfOpen: true, domain: null })
	const toHandler = tcp.readable.pipeTo(handler.writable).catch(() => {})
	const toClient = handler.readable.pipeTo(tcp.writable).catch(() => {})
	// The handler's side ends the connection when it returns; the client's side when it closes or breaks.
	await Promise.race([handler.closed.catch(() => {}), tcp.closed.catch(() => {})])
	await Promise.race([toClient, tcp.closed.catch(() => {})])
	await Promise.all([handler.close(), tcp.close()])
	await toHandler
}
