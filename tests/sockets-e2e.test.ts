// TCP sockets in a worker run by `lopata dev`: outbound `connect()` from cloudflare:sockets (plain, TLS, STARTTLS) to
// servers in this process, service-binding `connect()`, and inbound connections to the worker's `connect()` handler
// through the `connect` listener of its wrangler config.

import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import tls from 'node:tls'

const CLI = resolve(import.meta.dir, '../src/cli.ts')
const WORKER = resolve(import.meta.dir, 'fixtures/sockets-worker.ts')
const CERT_PATH = resolve(import.meta.dir, 'fixtures/tls/localhost.pem')
const key = readFileSync(resolve(import.meta.dir, 'fixtures/tls/localhost.key'))
const cert = readFileSync(CERT_PATH)

function freePort(): number {
	const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
	const port = listener.port
	listener.stop(true)
	return port
}

function addressOf(server: net.Server): number {
	const address = server.address()
	if (address === null || typeof address === 'string') throw new Error('server is not listening on TCP')
	return address.port
}

async function listening(server: net.Server): Promise<number> {
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	return addressOf(server)
}

/** Echoes, and finishes its side once the client finished. */
const echoServer = net.createServer({ allowHalfOpen: true }, socket => {
	socket.on('data', data => socket.write(data))
	socket.on('end', () => socket.end())
})

/** Answers `ping` with `pong` over TLS from the first byte. */
const tlsServer = tls.createServer({ key, cert }, socket => {
	socket.on('data', () => socket.end('pong\n'))
	socket.on('error', () => {})
})

/** workerd's STARTTLS sidecar protocol (src/workerd/api/tests/starttls-nodejs-server.js). */
const starttlsServer = net.createServer(socket => {
	socket.on('error', () => {})
	socket.write('HELLO\n')
	socket.once('data', data => {
		if (data.toString().trim() !== 'HELLO_BACK') return socket.destroy()
		socket.write('START_TLS\n', () => {
			const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: tls.createSecureContext({ key, cert }) })
			secure.on('data', () => secure.end('pong\n'))
			secure.on('error', () => {})
		})
	})
})

describe('TCP sockets in a worker run by lopata dev', () => {
	let root: string
	let server: Subprocess
	let base: string
	let connectPort: number
	const ports = { echo: 0, tls: 0, starttls: 0 }

	beforeAll(async () => {
		ports.echo = await listening(echoServer)
		ports.tls = await listening(tlsServer)
		ports.starttls = await listening(starttlsServer)
		root = mkdtempSync(join(tmpdir(), 'lopata-sockets-'))
		connectPort = freePort()
		const httpPort = freePort()
		writeFileSync(
			join(root, 'wrangler.json'),
			JSON.stringify({
				name: 'sockets',
				main: WORKER,
				compatibility_date: '2026-11-01',
				services: [{ binding: 'SELF', service: 'sockets' }, { binding: 'GREETER', service: 'sockets', entrypoint: 'Greeter' }, {
					binding: 'CRASHER',
					service: 'sockets',
					entrypoint: 'Crasher',
				}],
				connect: [{ protocol: 'tcp', port: connectPort }],
			}),
		)
		server = Bun.spawn(['bun', CLI, 'dev', '--port', String(httpPort), '--listen', '127.0.0.1'], {
			cwd: root,
			// The TLS test servers use a self-signed certificate; trust it the way a developer would.
			env: { ...process.env, NODE_EXTRA_CA_CERTS: CERT_PATH },
			stdout: Bun.file(join(root, 'out.log')),
			stderr: Bun.file(join(root, 'err.log')),
		})
		base = `http://127.0.0.1:${httpPort}`
		const deadline = Date.now() + 30_000
		while (Date.now() < deadline) {
			if (server.exitCode !== null) throw new Error(`lopata dev exited: ${readFileSync(join(root, 'err.log'), 'utf8')}`)
			try {
				if ((await fetch(`${base}/missing`)).status === 404) return
			} catch {}
			await Bun.sleep(100)
		}
		throw new Error('lopata dev did not start')
	}, 40_000)

	afterAll(async () => {
		server?.kill()
		if (server) await server.exited
		for (const s of [echoServer, tlsServer, starttlsServer]) s.close()
		if (root) rmSync(root, { recursive: true, force: true })
	})

	async function call(path: string): Promise<unknown> {
		const response = await fetch(`${base}${path}`)
		const body = await response.text()
		if (response.status !== 200) throw new Error(`${path}: ${response.status} ${body}`)
		return JSON.parse(body)
	}

	test('connect() writes, reads and closes a plain connection', async () => {
		expect(await call(`/plain?port=${ports.echo}`)).toEqual({ remoteAddress: `127.0.0.1:${ports.echo}`, reply: 'ping' })
	})

	test('connect() with secureTransport "on" talks TLS from the first byte', async () => {
		expect(await call(`/tls?port=${ports.tls}`)).toEqual({ reply: 'pong\n' })
	})

	test('startTls() upgrades a connection opened with secureTransport "starttls"', async () => {
		expect(await call(`/starttls?port=${ports.starttls}`)).toEqual({ greeting: 'HELLO', signal: 'START_TLS', upgraded: true, reply: 'pong' })
	})

	test("a refused connection rejects opened with workerd's message", async () => {
		expect(await call('/refused')).toEqual({ error: 'proxy request failed, cannot connect to the specified address' })
	})

	test("connect() on a service binding reaches the target's connect() handler", async () => {
		expect(await call('/service')).toEqual({ reply: 'hello undefined -> example.com:1234\npingbye\n' })
		expect(await call('/entrypoint')).toEqual({ localAddress: 'example.com:1234', remoteAddress: null })
	})

	test('an uncaught error in a connect() handler ends its connection', async () => {
		expect(await call('/crash')).toEqual({ reply: 'partial', closed: true })
	})

	test('the connect listener hands a raw TCP connection to the connect() handler', async () => {
		const reply = await new Promise<string>((resolve, reject) => {
			let text = ''
			const client = net.connect({ host: '127.0.0.1', port: connectPort, allowHalfOpen: true }, () => {
				client.write('abc')
				client.end()
			})
			client.on('data', data => {
				text += data.toString()
			})
			client.on('close', () => resolve(text))
			client.on('error', reject)
		})
		expect(reply).toMatch(new RegExp(`^hello 127\\.0\\.0\\.1:\\d+ -> 127\\.0\\.0\\.1:${connectPort}\\nabcbye\\n$`))
	})
})
