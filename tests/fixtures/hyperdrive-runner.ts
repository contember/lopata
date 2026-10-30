import { WorkerExecutorFactory } from '../../src/bindings/do-executor-worker'
import { GenerationManager } from '../../src/generation-manager'
import { snapshot } from './hyperdrive-worker'

const manager = new GenerationManager(
	{
		name: 'hyperdrive-runtime',
		main: `${import.meta.dir}/hyperdrive-worker.ts`,
		hyperdrive: [
			{ binding: 'PRIMARY', id: 'primary', localConnectionString: 'postgres://u:p@config.example/db' },
			{ binding: 'SECONDARY', id: 'secondary', localConnectionString: 'mysql://u:p@secondary.example:3310/db' },
			{ binding: 'MISSING', id: 'missing' },
		],
		durable_objects: { bindings: [{ name: 'PROBE', class_name: 'HyperdriveDO' }] },
	},
	process.cwd(),
	{ executorFactory: new WorkerExecutorFactory() },
)
await manager.reload()
const generation = manager.active
if (!generation?.threadExecutor) throw new Error('No active worker')
const worker = await generation.threadExecutor.executeFetch(new Request('http://localhost/'))
const durableObject = await generation.threadExecutor.executeFetch(new Request('http://localhost/do'))
if (worker.status !== 200 || durableObject.status !== 200) throw new Error('Hyperdrive worker request failed')
console.log(`RESULT ${JSON.stringify({ main: snapshot(generation.env), worker: await worker.json(), durableObject: await durableObject.json() })}`)
process.exit(0)
