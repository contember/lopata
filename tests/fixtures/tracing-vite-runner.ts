import { createServer } from 'vite'
import { getTraceStore } from '../../src/tracing/store'
import { lopata } from '../../src/vite-plugin'

await Bun.write(
	'wrangler.json',
	JSON.stringify({
		name: 'vite-tracing',
		main: `${import.meta.dir}/tracing-vite-worker.ts`,
	}),
)

function spans() {
	const store = getTraceStore()
	const ids = new Set(store.listAllSpans({ limit: 1000 }).items.map(span => span.traceId))
	return [...ids].flatMap(id => store.getTrace(id).spans)
}
const reservation = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) })
const port = reservation.port
await reservation.stop(true)
const server = await createServer({
	configFile: false,
	root: process.cwd(),
	server: { port, strictPort: true, fs: { allow: [process.cwd(), `${import.meta.dir}/../..`] } },
	plugins: [
		{
			name: 'tracing-inspection',
			configureServer(server) {
				server.middlewares.use((request, response, next) => {
					if (request.url !== '/__spans') return next()
					response.setHeader('content-type', 'application/json')
					response.end(JSON.stringify(spans()))
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
