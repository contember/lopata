import { createServer } from 'vite'
import { SqliteWorkflowBinding, WorkflowEntrypointBase } from '../../src/bindings/workflow'
import { getDatabase } from '../../src/db'
import { getTraceStore } from '../../src/tracing/store'
import { lopata } from '../../src/vite-plugin'

await Bun.write(
	'wrangler.json',
	JSON.stringify({
		name: 'vite-tracing',
		main: `${import.meta.dir}/tracing-vite-worker.ts`,
		workflows: [{ binding: 'PENDING', name: 'vite-pending', class_name: 'PendingWorkflow' }],
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
const environment = server.environments.ssr
if (!environment) throw new Error('Missing SSR environment')
const runner: unknown = Reflect.get(environment, 'runner')
if (!runner || typeof runner !== 'object') throw new Error('Missing SSR runner')
const importModule: unknown = Reflect.get(runner, 'import')
if (typeof importModule !== 'function') throw new Error('Missing SSR import')
const module: unknown = await Reflect.apply(importModule, runner, [`${import.meta.dir}/tracing-vite-worker.ts`])
if (!module || typeof module !== 'object') throw new Error('Invalid SSR module')
const releaseWorkflow: unknown = Reflect.get(module, 'releaseWorkflow')
if (typeof releaseWorkflow !== 'function') throw new Error('Missing workflow release')
const otherRelease = Promise.withResolvers<void>()
class OtherWorkflow extends WorkflowEntrypointBase {
	override async run() {
		this.ctx.waitUntil(otherRelease.promise)
	}
}
const other = new SqliteWorkflowBinding(getDatabase(), 'other-runtime', 'OtherWorkflow')
other._setClass(OtherWorkflow, {})
const control = Bun.serve({
	port: 0,
	async fetch(request) {
		const path = new URL(request.url).pathname
		if (path === '/prepare') {
			const instance = await other.create({ id: 'other-pending' })
			const deadline = Date.now() + 3000
			while ((await instance.status()).status !== 'complete') {
				if (Date.now() > deadline) throw new Error('Other engine did not finish')
				await Bun.sleep(1)
			}
		} else if (path === '/close') {
			await server.close()
			getDatabase().close()
		} else if (path === '/release-vite') {
			await Reflect.apply(releaseWorkflow, module, [])
			await Bun.sleep(0)
		} else if (path === '/release-other') {
			otherRelease.resolve()
			await Bun.sleep(0)
		}
		return Response.json(spans())
	},
})
console.log(`READY ${address.port} CONTROL ${control.port}`)
