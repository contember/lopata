import type { TCPSocketListener } from 'bun'
import { afterEach, describe, expect, test } from 'bun:test'
import { connect, connectThroughPort, serveConnection, type Socket } from '../src/bindings/sockets'

const encoder = new TextEncoder()
const PROXY_FAILED = 'proxy request failed, cannot connect to the specified address'

async function readAll(socket: Socket): Promise<string> {
	const decoder = new TextDecoder()
	let text = ''
	for await (const chunk of socket.readable) text += decoder.decode(chunk, { stream: true })
	return text + decoder.decode()
}

interface Server {
	port: number
	/** Bytes the connection received, once it saw end of data. */
	received: Promise<Uint8Array>
}

const listeners: TCPSocketListener<unknown>[] = []
afterEach(() => {
	for (const listener of listeners.splice(0)) listener.stop(true)
})

/** One-connection server: `onData` answers each chunk; with `endAfterGreeting` it sends `greeting` and closes its side at once. */
function listen(options: { echo?: boolean; greeting?: string; endAfterGreeting?: boolean } = {}): Server {
	const chunks: Uint8Array[] = []
	const received = Promise.withResolvers<Uint8Array>()
	const listener = Bun.listen({
		hostname: '127.0.0.1',
		port: 0,
		allowHalfOpen: true,
		socket: {
			open(socket) {
				if (options.greeting !== undefined) socket.write(options.greeting)
				if (options.endAfterGreeting) socket.shutdown()
			},
			data(socket, data) {
				chunks.push(new Uint8Array(data))
				if (options.echo) socket.write(data)
			},
			end(socket) {
				received.resolve(Buffer.concat(chunks))
				if (!options.endAfterGreeting) socket.end()
			},
			// Bun reports a peer's end of data as `close` once its own side is shut down already.
			close() {
				received.resolve(Buffer.concat(chunks))
			},
		},
	})
	listeners.push(listener)
	return { port: listener.port, received: received.promise }
}

describe('connect() from cloudflare:sockets', () => {
	test('writes, reads and closes a connection', async () => {
		const server = listen({ echo: true })
		const socket = connect({ hostname: '127.0.0.1', port: server.port })
		expect(await socket.opened).toEqual({ remoteAddress: `127.0.0.1:${server.port}`, localAddress: undefined })
		const writer = socket.writable.getWriter()
		await writer.write(encoder.encode('ping'))
		await writer.close()
		expect(await readAll(socket)).toBe('ping')
		await socket.closed
		expect(new TextDecoder().decode(await server.received)).toBe('ping')
	})

	test("a refused connection rejects opened and closed with workerd's error", async () => {
		const socket = connect('127.0.0.1:1')
		for (const promise of [socket.opened, socket.closed]) {
			const error = await promise.then(() => null, (e: unknown) => e)
			if (!(error instanceof Error)) throw new Error('expected an Error')
			expect(error.constructor).toBe(Error)
			expect(error.message).toBe(PROXY_FAILED)
			expect(Object.keys(error)).toEqual([])
			expect('code' in error).toBe(false)
		}
		await expect(socket.writable.getWriter().write(encoder.encode('x'))).rejects.toThrow(PROXY_FAILED)
	})

	test('a refused connection on port 80 or 443 suggests fetch()', async () => {
		// Nothing listens on the loopback alias 127.0.0.2.
		const socket = connect({ hostname: '127.0.0.2', port: 443 })
		await expect(socket.opened).rejects.toThrow(`${PROXY_FAILED}. It looks like you might be trying to connect to a HTTP-based service`)
	})

	test('closes its own side when the peer finishes, unless allowHalfOpen', async () => {
		const closing = listen({ greeting: 'bye', endAfterGreeting: true })
		const socket = connect({ hostname: '127.0.0.1', port: closing.port })
		expect(await readAll(socket)).toBe('bye')
		// The peer saw our end of data without us closing the writable.
		expect(await closing.received).toEqual(new Uint8Array())
		await socket.closed
		await expect(socket.writable.getWriter().write(encoder.encode('late'))).rejects.toThrow(TypeError)

		const halfOpen = listen({ greeting: 'bye', endAfterGreeting: true })
		const kept = connect({ hostname: '127.0.0.1', port: halfOpen.port }, { allowHalfOpen: true })
		expect(await readAll(kept)).toBe('bye')
		const writer = kept.writable.getWriter()
		await writer.write(encoder.encode('after end'))
		await writer.close()
		expect(new TextDecoder().decode(await halfOpen.received)).toBe('after end')
	})

	test('a write larger than the kernel buffer arrives whole', async () => {
		const server = listen()
		const socket = connect({ hostname: '127.0.0.1', port: server.port })
		const payload = new Uint8Array(16 * 1024 * 1024).map((_, i) => i % 251)
		const writer = socket.writable.getWriter()
		await writer.write(payload)
		await writer.close()
		const received = await server.received
		expect(received.byteLength).toBe(payload.byteLength)
		expect(Buffer.compare(received, payload)).toBe(0)
	})

	test('close() ends reads and rejects later writes', async () => {
		const server = listen()
		const socket = connect({ hostname: '127.0.0.1', port: server.port })
		await socket.opened
		const reader = socket.readable.getReader()
		const pending = reader.read()
		await socket.close()
		expect(await pending).toEqual({ done: true, value: undefined })
		await socket.closed
		const writer = socket.writable.getWriter()
		await expect(writer.write(encoder.encode('x'))).rejects.toThrow('This socket has been closed.')
	})

	test('rejects what workerd rejects', () => {
		expect(() => connect('localhost')).toThrow(new TypeError('Specified address is missing port.'))
		expect(() => connect(':80')).toThrow(new TypeError('Specified address could not be parsed.'))
		expect(() => connect('bad host!:80')).toThrow(TypeError)
		expect(() => connect({ hostname: 'bad/host', port: 80 })).toThrow(
			new TypeError('Specified address is empty string, contains unsupported characters or is too long.'),
		)
		expect(() => connect('localhost:1', { secureTransport: 'maybe' })).toThrow(
			new TypeError('Unsupported value in secureTransport socket option: maybe'),
		)
	})

	test('startTls() needs secureTransport "starttls" and runs once', async () => {
		const server = listen({ echo: true })
		const plain = connect({ hostname: '127.0.0.1', port: server.port })
		expect(() => plain.startTls()).toThrow(
			new TypeError("The `secureTransport` socket option must be set to 'starttls' for startTls to be used."),
		)
		const tls = connect({ hostname: '127.0.0.1', port: server.port }, { secureTransport: 'on' })
		expect(() => tls.startTls()).toThrow(new TypeError('Cannot startTls on a TLS socket.'))
		const starttls = connect({ hostname: '127.0.0.1', port: server.port }, { secureTransport: 'starttls' })
		expect(starttls.secureTransport).toBe('starttls')
		const secured = starttls.startTls()
		expect(secured.secureTransport).toBe('on')
		expect(() => starttls.startTls()).toThrow(
			new TypeError('startTls has already been called on this socket, or the socket was transferred over RPC.'),
		)
		await starttls.closed
		expect(starttls.upgraded).toBe(true)
		// The echo server answers the ClientHello with itself, which is no handshake.
		await expect(secured.opened).rejects.toThrow()
		await plain.close()
		await tls.closed.catch(() => {})
	})

	test('the writable takes only bytes', async () => {
		const server = listen()
		const socket = connect({ hostname: '127.0.0.1', port: server.port })
		// Typed as user code without types sees it.
		const writer: WritableStreamDefaultWriter<unknown> = socket.writable.getWriter()
		await expect(writer.write('text')).rejects.toThrow(new TypeError('This WritableStream only supports writing byte types.'))
		await socket.close()
	})
})

describe('sockets carried over a MessagePort (service-binding connect())', () => {
	test("the handler sees the caller's address, replies after the caller finished, and the connection closes when it returns", async () => {
		let handlerInfo: unknown
		const socket = connectThroughPort('example.com:1234', undefined, port => {
			void serveConnection(port, { localAddress: 'example.com:1234' }, async (inbound, accept) => {
				accept()
				handlerInfo = await inbound.opened
				const received = await readAll(inbound)
				const writer = inbound.writable.getWriter()
				await writer.write(encoder.encode(`echo:${received}`))
				await writer.close()
			})
		})
		expect(await socket.opened).toEqual({ remoteAddress: 'example.com:1234', localAddress: undefined })
		const writer = socket.writable.getWriter()
		await writer.write(encoder.encode('ping'))
		await writer.close()
		expect(await readAll(socket)).toBe('echo:ping')
		await socket.closed
		expect(handlerInfo).toEqual({ remoteAddress: undefined, localAddress: 'example.com:1234' })
	})

	test('a worker without a handler refuses the connection', async () => {
		const socket = connectThroughPort('example.com:1', undefined, port => {
			void serveConnection(port, {}, async () => {
				throw new Error('Handler does not export a connect() function.')
			}).catch(() => {})
		})
		await expect(socket.opened).rejects.toThrow(PROXY_FAILED)
		await expect(socket.closed).rejects.toThrow(PROXY_FAILED)
	})

	test('a write after the handler returned fails as in workerd', async () => {
		let late: Promise<void> | undefined
		const socket = connectThroughPort('example.com:1', undefined, port => {
			void serveConnection(port, {}, async (inbound, accept) => {
				accept()
				const writer = inbound.writable.getWriter()
				late = (async () => {
					await Bun.sleep(0)
					await writer.write(new Uint8Array([0x41]))
				})()
			})
		})
		await socket.closed
		if (!late) throw new Error('handler did not run')
		await expect(late).rejects.toThrow(new TypeError("Can't read from request stream because client disconnected."))
	})

	test('a writer waits while the peer does not read, and resumes when it does', async () => {
		let inbound: Socket | undefined
		const socket = connectThroughPort('example.com:1', undefined, port => {
			void serveConnection(port, {}, async (s, accept) => {
				accept()
				inbound = s
				await s.closed
			})
		})
		await socket.opened
		const writer = socket.writable.getWriter()
		let written = 0
		const writing = (async () => {
			for (let i = 0; i < 100; i++) {
				await writer.write(new Uint8Array(1024))
				written++
			}
		})()
		await Bun.sleep(50)
		expect(written).toBeLessThan(40)
		if (!inbound) throw new Error('handler did not run')
		const reader = inbound.readable.getReader()
		let read = 0
		while (read < 100) {
			const { done } = await reader.read()
			if (done) break
			read++
		}
		await writing
		expect(written).toBe(100)
		await socket.close()
	})

	test('startTls() is not supported over a service binding', async () => {
		const socket = connectThroughPort('example.com:1', { secureTransport: 'starttls' }, port => {
			void serveConnection(port, {}, async (s, accept) => {
				accept()
				await s.closed
			})
		})
		await socket.opened
		const secured = socket.startTls()
		await expect(secured.opened).rejects.toThrow('startTls() is not supported on this connection.')
	})
})
