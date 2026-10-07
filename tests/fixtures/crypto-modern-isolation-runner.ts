import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { WorkerExecutor } from '../../src/bindings/do-executor-worker'
import { DurableObjectBase, DurableObjectIdImpl } from '../../src/bindings/durable-object'
import type { WranglerConfig } from '../../src/config'
import { runMigrations } from '../../src/db'
import { WorkerThreadExecutor } from '../../src/worker-thread/executor'

const modulePath = join(import.meta.dir, 'crypto-modern-runtime-worker.ts')
const configOn: WranglerConfig = { name: 'crypto-on', compatibility_flags: ['webcrypto_modern_algorithms'] }
const configOff: WranglerConfig = { name: 'crypto-off' }
const workerOn = new WorkerThreadExecutor({ modulePath, config: configOn, baseDir: process.cwd(), mainEnv: {} })
const workerOff = new WorkerThreadExecutor({ modulePath, config: configOff, baseDir: process.cwd(), mainEnv: {} })
const db = new Database(':memory:')
runMigrations(db)
const doOn = new WorkerExecutor({
	id: new DurableObjectIdImpl('1'.repeat(64)),
	db,
	namespaceName: 'CryptoProbe',
	cls: DurableObjectBase,
	env: {},
	dataDir: join(process.cwd(), 'do-on'),
	_modulePath: modulePath,
	_configPath: join(process.cwd(), 'wrangler.json'),
	_wranglerConfig: configOn,
})
const doOff = new WorkerExecutor({
	id: new DurableObjectIdImpl('2'.repeat(64)),
	db,
	namespaceName: 'CryptoProbe',
	cls: DurableObjectBase,
	env: {},
	dataDir: join(process.cwd(), 'do-off'),
	_modulePath: modulePath,
	_configPath: join(process.cwd(), 'wrangler.json'),
	_wranglerConfig: configOff,
})
try {
	const request = () => new Request('https://crypto.example/')
	const responses = await Promise.all([
		workerOn.executeFetch(request()),
		workerOff.executeFetch(request()),
		doOn.executeFetch(request()),
		doOff.executeFetch(request()),
	])
	const reports: unknown[] = await Promise.all(responses.map(response => response.json()))
	const repeated: unknown = await (await workerOn.executeFetch(request())).json()
	const repeatedDo: unknown = await (await doOn.executeFetch(request())).json()
	console.log(`REPORT ${JSON.stringify({ reports, repeated, repeatedDo })}`)
} finally {
	workerOn.dispose()
	workerOff.dispose()
	await Promise.all([doOn.dispose(), doOff.dispose()])
	db.close()
}
