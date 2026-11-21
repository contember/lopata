import { connect } from 'cloudflare:sockets'
import { WorkerEntrypoint } from 'cloudflare:workers'

interface Socket {
	readonly readable: ReadableStream<Uint8Array>
	readonly writable: WritableStream<Uint8Array>
	readonly opened: Promise<{ remoteAddress?: string; localAddress?: string }>
	readonly closed: Promise<void>
	close(): Promise<void>
	startTls(): Socket
}

interface Env {
	SELF: { connect(address: string): Socket }
	GREETER: { connect(address: string): Socket }
	CRASHER: { connect(address: string): Socket }
}

const encoder = new TextEncoder()

async function readAll(socket: Socket): Promise<string> {
	const decoder = new TextDecoder()
	let text = ''
	for await (const chunk of socket.readable) text += decoder.decode(chunk, { stream: true })
	return text + decoder.decode()
}

/** Read one `\n`-terminated line. */
async function readLine(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
	const decoder = new TextDecoder()
	let line = ''
	while (!line.endsWith('\n')) {
		const { value, done } = await reader.read()
		if (done) throw new Error(`peer closed mid-line: ${line}`)
		line += decoder.decode(value, { stream: true })
	}
	return line.trim()
}

/** Send everything, finish our side, read the reply to the end. */
async function exchange(socket: Socket, message: string): Promise<string> {
	const writer = socket.writable.getWriter()
	await writer.write(encoder.encode(message))
	await writer.close()
	const reply = await readAll(socket)
	await socket.closed
	return reply
}

export class Greeter extends WorkerEntrypoint {
	async connect(socket: Socket): Promise<void> {
		const { localAddress, remoteAddress } = await socket.opened
		const writer = socket.writable.getWriter()
		await writer.write(encoder.encode(JSON.stringify({ localAddress: localAddress ?? null, remoteAddress: remoteAddress ?? null })))
		await writer.close()
	}
}

/** Throws an uncaught error while it still holds the connection. */
export class Crasher extends WorkerEntrypoint {
	async connect(socket: Socket): Promise<void> {
		const writer = socket.writable.getWriter()
		await writer.write(encoder.encode('partial'))
		setTimeout(() => {
			throw new Error('uncaught in connect()')
		})
		await new Promise(() => {})
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)
		const port = Number(url.searchParams.get('port'))
		try {
			switch (url.pathname) {
				case '/plain': {
					const socket = connect({ hostname: '127.0.0.1', port })
					const { remoteAddress } = await socket.opened
					return Response.json({ remoteAddress, reply: await exchange(socket, 'ping') })
				}
				case '/tls': {
					const socket = connect({ hostname: 'localhost', port }, { secureTransport: 'on' })
					return Response.json({ reply: await exchange(socket, 'ping\n') })
				}
				case '/starttls': {
					// The protocol of workerd's starttls-nodejs-server.js: greeting, upgrade request, then ping/pong over TLS.
					const socket: Socket = connect(`localhost:${port}`, { secureTransport: 'starttls' })
					const reader = socket.readable.getReader()
					const writer = socket.writable.getWriter()
					const greeting = await readLine(reader)
					await writer.write(encoder.encode('HELLO_BACK\n'))
					const signal = await readLine(reader)
					reader.releaseLock()
					writer.releaseLock()
					const secure = socket.startTls()
					await secure.opened
					const secureWriter = secure.writable.getWriter()
					await secureWriter.write(encoder.encode('ping\n'))
					const secureReader = secure.readable.getReader()
					const reply = await readLine(secureReader)
					secureReader.releaseLock()
					await secure.close()
					return Response.json({ greeting, signal, upgraded: socket.upgraded, reply })
				}
				case '/refused': {
					const socket = connect('127.0.0.1:1')
					const error = await socket.opened.then(() => null, (e: Error) => e.message)
					return Response.json({ error })
				}
				case '/service':
					return Response.json({ reply: await exchange(env.SELF.connect('example.com:1234'), 'ping') })
				case '/entrypoint':
					return Response.json(JSON.parse(await readAll(env.GREETER.connect('example.com:1234'))))
				case '/crash': {
					const socket = env.CRASHER.connect('example.com:1234')
					const reply = await readAll(socket)
					// Whether it closes cleanly or breaks is not pinned; it must not stay open.
					const closed = await socket.closed.then(() => true, () => true)
					return Response.json({ reply, closed })
				}
			}
			return new Response('not found', { status: 404 })
		} catch (error) {
			return new Response(error instanceof Error ? error.stack : String(error), { status: 500 })
		}
	},

	/** Greets with the connection's addresses, echoes until the client finishes, then says bye and closes. */
	async connect(socket: Socket): Promise<void> {
		const { remoteAddress, localAddress } = await socket.opened
		const writer = socket.writable.getWriter()
		await writer.write(encoder.encode(`hello ${remoteAddress} -> ${localAddress}\n`))
		for await (const chunk of socket.readable) await writer.write(chunk)
		await writer.write(encoder.encode('bye\n'))
		await writer.close()
	},
}
