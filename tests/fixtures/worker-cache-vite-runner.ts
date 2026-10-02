import { createServer } from 'vite'
import { ExecutionContext } from '../../src/execution-context'
import { lopata } from '../../src/vite-plugin'

const registrations = new WeakMap<ExecutionContext, number>()
let drainedRegistrations = 0
const originalWaitUntil = ExecutionContext.prototype.waitUntil
const originalDrain = ExecutionContext.prototype._awaitAll
ExecutionContext.prototype.waitUntil = function(promise) {
	registrations.set(this, (registrations.get(this) ?? 0) + 1)
	originalWaitUntil.call(this, promise)
}
ExecutionContext.prototype._awaitAll = function() {
	drainedRegistrations += registrations.get(this) ?? 0
	return originalDrain.call(this)
}

await Bun.write(
	'wrangler.json',
	JSON.stringify({
		name: 'vite-cache',
		main: `${import.meta.dir}/worker-cache-vite-worker.ts`,
		cache: { enabled: true },
	}),
)
const reservation = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) })
const port = reservation.port
await reservation.stop(true)
const server = await createServer({
	configFile: false,
	root: process.cwd(),
	server: { port, strictPort: true, fs: { allow: [process.cwd(), `${import.meta.dir}/../..`] } },
	plugins: [
		{
			name: 'cache-accounting-test',
			configureServer(server) {
				server.middlewares.use((request, response, next) => {
					if (request.url !== '/__accounting') return next()
					response.setHeader('content-type', 'application/json')
					response.end(JSON.stringify({ drainedRegistrations }))
				})
			},
		},
		...lopata({ configPath: 'wrangler.json' }),
	],
})
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('Vite did not listen')
console.log(`READY ${address.port}`)
