import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import { lopata } from '../../src/vite-plugin'

const servers: ViteDevServer[] = []
const source = (revision: number) => `
import { nativeTopLevel } from 'crypto-scope-native'
const topLevel = typeof crypto.subtle.encapsulateBits === 'function'
const cached = crypto.subtle
await Promise.resolve()
const afterTopLevelAwait = typeof crypto.subtle.encapsulateBits === 'function'
export default class {
	constructor() { this.constructed = typeof crypto.subtle.encapsulateBits === 'function' }
	async fetch(request) {
		if (request.headers.get('upgrade') === 'websocket') {
			const pair = new WebSocketPair()
			pair[1].accept()
			pair[1].addEventListener('message', async event => {
				const before = typeof crypto.subtle.encapsulateBits === 'function'
				await new Promise(resolve => setTimeout(resolve, 20))
				const nested = new WebSocketPair()
				nested[0].accept()
				let reasonError = null
				try { nested[0].close(1000, '€'.repeat(42)) }
				catch (error) { reasonError = error instanceof DOMException ? error.name : 'unexpected' }
				const bytes = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data
				pair[1].send(JSON.stringify({
					before, after: typeof crypto.subtle.encapsulateBits === 'function', reasonError,
					binaryType: pair[1].binaryType, kind: event.data instanceof Blob ? 'blob' : 'arraybuffer',
					bytes: [...new Uint8Array(bytes)]
				}))
				pair[1].close(1000, 'done')
			})
			return new Response(null, { status: 101, webSocket: pair[0] })
		}
		const before = typeof crypto.subtle.encapsulateBits === 'function'
		await new Promise(resolve => setTimeout(resolve, 20))
		return Response.json({ topLevel, afterTopLevelAwait, nativeTopLevel, before, after: typeof crypto.subtle.encapsulateBits === 'function', cached: typeof cached.encapsulateBits === 'function', constructed: this.constructed, revision: ${revision} })
	}
}
`

async function start(name: string, modern: boolean) {
	const root = join(process.cwd(), name)
	await Bun.write(
		join(root, 'node_modules/crypto-scope-native/package.json'),
		JSON.stringify({ name: 'crypto-scope-native', type: 'module', exports: './index.js' }),
	)
	await Bun.write(
		join(root, 'node_modules/crypto-scope-native/index.js'),
		`export const nativeTopLevel = typeof crypto.subtle.encapsulateBits === 'function'`,
	)
	await Bun.write(join(root, 'worker.ts'), source(1))
	await Bun.write(
		join(root, 'wrangler.json'),
		JSON.stringify({
			name,
			main: './worker.ts',
			compatibility_flags: modern
				? ['webcrypto_modern_algorithms', 'websocket_close_reason_byte_limit', 'websocket_standard_binary_type']
				: ['no_websocket_standard_binary_type'],
		}),
	)
	const reservation = Bun.serve({ port: 0, fetch: () => new Response() })
	const port = reservation.port
	await reservation.stop(true)
	const server = await createServer({
		configFile: false,
		root,
		ssr: { external: ['crypto-scope-native'] },
		server: { port, strictPort: true },
		plugins: lopata({ configPath: 'wrangler.json' }),
	})
	servers.push(server)
	await server.listen()
	return { server, root, url: `http://localhost:${port}/` }
}

function expected(modern: boolean, revision = 1) {
	return {
		topLevel: modern,
		afterTopLevelAwait: modern,
		nativeTopLevel: false,
		before: modern,
		after: modern,
		cached: modern,
		constructed: modern,
		revision,
	}
}

async function socketProbe(url: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url.replace('http:', 'ws:'))
		const timeout = setTimeout(() => {
			socket.close()
			reject(new Error('WebSocket compatibility probe timed out'))
		}, 5000)
		socket.onopen = () => socket.send(new Uint8Array([9, 8, 7]))
		socket.onerror = () => {
			clearTimeout(timeout)
			reject(new Error('WebSocket compatibility probe failed'))
		}
		socket.onmessage = event => {
			clearTimeout(timeout)
			if (typeof event.data !== 'string') {
				reject(new Error('Expected WebSocket probe JSON'))
				return
			}
			resolve(JSON.parse(event.data))
		}
	})
}

try {
	const on = await start('modern', true)
	const off = await start('legacy', false)
	const results = await Promise.all([fetch(on.url).then(response => response.json()), fetch(off.url).then(response => response.json())])
	assert.deepEqual(results, [expected(true), expected(false)])
	assert.deepEqual(await Promise.all([socketProbe(on.url), socketProbe(off.url)]), [
		{ before: true, after: true, reasonError: 'SyntaxError', binaryType: 'blob', kind: 'blob', bytes: [9, 8, 7] },
		{ before: false, after: false, reasonError: null, binaryType: 'arraybuffer', kind: 'arraybuffer', bytes: [9, 8, 7] },
	])
	await Bun.write(join(on.root, 'worker.ts'), source(2))
	on.server.environments.ssr.moduleGraph.invalidateAll()
	const environment = on.server.environments.ssr
	if (!('runner' in environment)) throw new Error('Missing module runner')
	const runner = environment.runner
	if (!runner || typeof runner !== 'object' || !('clearCache' in runner) || typeof runner.clearCache !== 'function') {
		throw new Error('Missing clearCache')
	}
	runner.clearCache()
	assert.deepEqual(await (await fetch(on.url)).json(), expected(true, 2))
	assert.deepEqual(await (await fetch(off.url)).json(), expected(false))
	console.log('scoped Vite passed')
} finally {
	await Promise.all(servers.map(server => server.close()))
}
process.exit(0)
