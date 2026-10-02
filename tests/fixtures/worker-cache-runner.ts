import { GenerationManager } from '../../src/generation-manager'
import { WorkerRegistry } from '../../src/worker-registry'

const crossVersion = process.env.CROSS_VERSION === 'true'
const registry = new WorkerRegistry()
const manager = new GenerationManager(
	{
		name: 'cache-runtime',
		main: `${import.meta.dir}/${process.env.CONSTRUCTOR_WORKER === 'true' ? 'worker-cache-constructor-worker.ts' : 'worker-cache-worker.ts'}`,
		cache: { enabled: true, cross_version_cache: crossVersion },
		exports: { default: { type: 'worker', cache: { enabled: false } }, Backend: { type: 'worker', cache: { enabled: true } } },
		services: [{ binding: 'SELF', service: 'cache-runtime', entrypoint: 'Backend', props: { tenant: 'public' } }],
		kv_namespaces: [{ binding: 'RECEIPTS', id: 'cache-receipts' }],
		queues: { producers: [{ binding: 'TASKS', queue: 'cache-tasks' }], consumers: [{ queue: 'cache-tasks', max_batch_size: 1, max_batch_timeout: 0 }] },
	},
	process.cwd(),
	{ workerRegistry: registry },
)
registry.register('cache-runtime', manager, true)
await manager.reload()
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		if (new URL(request.url).pathname === '/__reload') {
			await manager.reload()
			return new Response('reloaded')
		}
		const executor = manager.active?.threadExecutor
		if (!executor) throw new Error('No active worker')
		if (new URL(request.url).pathname === '/__scheduled') return Response.json(await executor.executeScheduled('* * * * *', Date.now()))
		if (new URL(request.url).pathname === '/__email') {
			return Response.json(await executor.executeEmail('cache-context-email', 'a@example.com', 'b@example.com', new Uint8Array()))
		}
		return executor.executeFetch(request)
	},
})
console.log(`READY ${server.port}`)
