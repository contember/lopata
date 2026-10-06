import { Database } from 'bun:sqlite'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { WorkerExecutor, WorkerExecutorFactory } from '../../src/bindings/do-executor-worker'
import { DurableObjectBase, DurableObjectIdImpl } from '../../src/bindings/durable-object'
import { loadConfig, type WranglerConfig } from '../../src/config'
import { runMigrations } from '../../src/db'
import { GenerationManager } from '../../src/generation-manager'
import { WorkerRegistry } from '../../src/worker-registry'
import { WorkerThreadExecutor } from '../../src/worker-thread/executor'

const modulePath = join(import.meta.dir, 'compatibility-wiring-worker.ts')
const registry = new WorkerRegistry()
const targetConfig: WranglerConfig = {
	name: 'target',
	main: modulePath,
	compatibility_date: '2999-12-31',
	compatibility_flags: ['unknown_flag'],
	durable_objects: { bindings: [{ name: 'DO', class_name: 'CompatibilityProbe' }] },
}
const target = new GenerationManager(targetConfig, process.cwd(), {
	workerRegistry: registry,
	executorFactory: new WorkerExecutorFactory(),
	configPath: join(process.cwd(), 'target.json'),
})
const caller = new GenerationManager(
	{
		name: 'caller',
		main: modulePath,
		compatibility_flags: ['webcrypto_modern_algorithms', 'no_webcrypto_modern_algorithms'],
		services: [{ binding: 'TARGET', service: 'target' }],
	},
	process.cwd(),
	{ workerRegistry: registry },
)
registry.register('target', target)
registry.register('caller', caller)
const modern = { topLevelModern: true, modern: true }
const legacy = { topLevelModern: false, modern: false }
const request = (path = '/') => new Request(`https://worker.test${path}`)
async function fetchCaller(path = '/') {
	const executor = caller.active?.threadExecutor
	assert.ok(executor)
	return (await executor.executeFetch(request(path))).json()
}
async function fetchTargetDo(name: string) {
	const executor = target.active?.threadExecutor
	assert.ok(executor)
	return (await executor.executeFetch(request(`/do/${name}`))).json()
}
const db = new Database(':memory:')
runMigrations(db)
const doConfig = {
	id: new DurableObjectIdImpl('1'.repeat(64)),
	db,
	namespaceName: 'CompatibilityProbe',
	cls: DurableObjectBase,
	env: {},
	_modulePath: modulePath,
	_configPath: join(process.cwd(), 'wrangler.json'),
}
const dos: WorkerExecutor[] = []
try {
	assert.throws(
		() => new WorkerThreadExecutor({ modulePath, config: { name: 'bad', compatibility_date: '2026-02-30' }, baseDir: process.cwd(), mainEnv: {} }),
		/Gregorian/,
	)
	assert.throws(
		() =>
			new WorkerExecutor({
				...doConfig,
				_wranglerConfig: { name: 'bad', compatibility_flags: ['delete_all_deletes_alarm', 'delete_all_preserves_alarm'] },
			}),
		/Conflicting/,
	)
	const factory = new WorkerExecutorFactory()
	assert.throws(() => factory.configure(modulePath, doConfig._configPath, { name: 'bad', compatibility_date: 'bad' }), /YYYY-MM-DD/)
	await target.reload()
	await caller.reload()
	assert.deepEqual(await fetchCaller(), modern)
	assert.deepEqual(await fetchCaller('/target'), legacy)
	targetConfig.compatibility_flags = ['webcrypto_modern_algorithms', 'unknown_flag']
	await target.reload()
	assert.deepEqual(await fetchCaller('/target'), modern)
	assert.deepEqual(await fetchTargetDo('before-rejected-reload'), modern)
	targetConfig.compatibility_flags.push('delete_all_deletes_alarm', 'delete_all_preserves_alarm')
	await assert.rejects(target.reload(), /Conflicting/)
	assert.deepEqual(await fetchCaller('/target'), modern)
	assert.deepEqual(await fetchTargetDo('after-rejected-reload'), modern)

	await Bun.write(
		doConfig._configPath,
		JSON.stringify({
			name: 'do',
			main: modulePath,
			compatibility_date: '2999-12-31',
			env: { modern: { compatibility_flags: ['webcrypto_modern_algorithms'] } },
		}),
	)
	const effective = await loadConfig(doConfig._configPath, 'modern')
	factory.configure(modulePath, doConfig._configPath, effective)
	assert.ok(effective.compatibility_flags)
	effective.compatibility_flags.push('delete_all_deletes_alarm', 'delete_all_preserves_alarm')
	assert.throws(() => factory.configure('must-not-publish.ts', 'must-not-publish.json', effective), /Conflicting/)
	effective.compatibility_date = 'invalid-date'
	assert.throws(() => factory.configure('must-not-publish.ts', 'must-not-publish.json', effective), /YYYY-MM-DD/)
	const retained = factory.create({ ...doConfig, dataDir: join(process.cwd(), 'retained') })
	try {
		assert.deepEqual(await (await retained.executeFetch(request())).json(), modern)
	} finally {
		await retained.dispose()
	}
	const validEffective = await loadConfig(doConfig._configPath, 'modern')
	const configured = new WorkerExecutor({ ...doConfig, dataDir: join(process.cwd(), 'configured'), _wranglerConfig: validEffective })
	const fallback = new WorkerExecutor({ ...doConfig, dataDir: join(process.cwd(), 'fallback') })
	dos.push(configured, fallback)
	assert.deepEqual(await (await configured.executeFetch(request())).json(), modern)
	assert.deepEqual(await (await fallback.executeFetch(request())).json(), legacy)
	console.log('compatibility wiring passed')
} finally {
	await Promise.all(dos.map(executor => executor.dispose()))
	for (const manager of [caller, target]) for (const generation of manager.list()) manager.stop(generation.id)
	db.close()
}
process.exit(0)
