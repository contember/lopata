import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DOExecutor } from '../src/bindings/do-executor'
import { WorkerExecutorFactory } from '../src/bindings/do-executor-worker'
import { DurableObjectNamespaceImpl, SqliteDurableObjectStorage } from '../src/bindings/durable-object'
import { resolveCompatibility } from '../src/compatibility'
import { runWithCompatibility } from '../src/compatibility-context'
import { runMigrations } from '../src/db'

async function until(check: () => Promise<boolean>) {
	const deadline = Date.now() + 5000
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error('Alarm observation timed out')
		await Bun.sleep(10)
	}
}

test('real DO bridge cancels scheduled alarms, preserves replacements and survives reopening', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'lopata-alarm-compatibility-'))
	let db = new Database(join(directory, 'data.sqlite'))
	runMigrations(db)
	const factory = new WorkerExecutorFactory()
	factory.configure(join(import.meta.dir, 'fixtures/do-alarm-compatibility-worker.ts'), join(directory, 'wrangler.json'), {
		name: 'alarm-target',
		compatibility_date: '2026-02-24',
	})
	const executors = new Map<string, DOExecutor>()
	const namespace = new DurableObjectNamespaceImpl(db, 'AlarmCompatibility', directory, { evictionTimeoutMs: 0 }, {
		create(config) {
			const executor = factory.create(config)
			executors.set(config.id.toString(), executor)
			return executor
		},
	})
	namespace._setExternalClass('AlarmCompatibility', {})
	const id = namespace.idFromName('cancelled')
	const otherId = namespace.idFromName('other')
	namespace.get(id)
	namespace.get(otherId)
	const object = executors.get(id.toString())
	const other = executors.get(otherId.toString())
	if (!object || !other) throw new Error('Missing executors')
	const storage = new SqliteDurableObjectStorage(db, 'AlarmCompatibility', id.toString())
	const otherStorage = new SqliteDurableObjectStorage(db, 'AlarmCompatibility', otherId.toString())
	try {
		await object.executeRpc('release', [])
		await other.executeRpc('release', [])
		const time = Date.now() + 1000
		await object.executeRpc('arm', [time])
		await other.executeRpc('arm', [time])
		const rejection: unknown = await other.executeRpc('transactionalClear', []).then(() => null, (error: unknown) => error)
		expect(rejection).toBeInstanceOf(Error)
		if (!(rejection instanceof Error)) throw new Error('Expected transaction rejection')
		expect(rejection.message).toBe('Cannot call deleteAll() within a transaction')
		expect(await otherStorage.getAlarm()).toBe(time)
		await runWithCompatibility(resolveCompatibility({ flags: ['delete_all_preserves_alarm'] }), () => object.executeRpc('clear', []))
		expect(await storage.getAlarm()).toBeNull()
		expect(await storage.get('value')).toBeUndefined()
		expect(await otherStorage.get<string>('value')).toBe('kept')
		await until(async () => await otherStorage.get('finished') === true)
		expect(await storage.get('started')).toBeUndefined()

		const replacement = Date.now() + 300
		await object.executeRpc('arm', [replacement])
		await object.executeRpc('replace', [replacement])
		expect(await storage.getAlarm()).toBe(replacement)
		await until(async () => await storage.get('finished') === true)
		const cancelled = Date.now() + 300
		await object.executeRpc('arm', [cancelled])
		await object.executeRpc('replace', [cancelled])
		await object.executeRpc('clear', [])
		await Bun.sleep(400)
		expect(await storage.get('started')).toBeUndefined()

		await object.executeRpc('hold', [])
		await object.executeRpc('arm', [Date.now()])
		await until(async () => await storage.get('started') === true)
		await object.executeRpc('clear', [])
		await object.executeRpc('release', [])
		await until(async () => await storage.get('finished') === true)

		await object.executeRpc('arm', [Date.now() + 60_000])
		await object.executeRpc('clear', [])
		namespace.destroy({ force: true })
		await Promise.all([...executors.values()].map(executor => executor.dispose()))
		db.close()
		db = new Database(join(directory, 'data.sqlite'))
		const reopened = new SqliteDurableObjectStorage(db, 'AlarmCompatibility', id.toString())
		expect(await reopened.getAlarm()).toBeNull()
		const restored = new DurableObjectNamespaceImpl(db, 'AlarmCompatibility', directory, { evictionTimeoutMs: 0 })
		try {
			restored._setExternalClass('AlarmCompatibility', {})
			expect(restored._fireReadyAlarms()).toEqual([])
		} finally {
			restored.destroy({ force: true })
		}
	} finally {
		namespace.destroy({ force: true })
		await Promise.all([...executors.values()].map(executor => executor.dispose()))
		db.close()
		rmSync(directory, { recursive: true, force: true })
	}
}, 15000)

test('real DO constructor cancels an already-restored alarm timer', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'lopata-constructor-alarm-'))
	const db = new Database(join(directory, 'data.sqlite'))
	runMigrations(db)
	const factory = new WorkerExecutorFactory()
	factory.configure(join(import.meta.dir, 'fixtures/do-alarm-compatibility-worker.ts'), join(directory, 'wrangler.json'), {
		name: 'constructor-alarm-target',
		compatibility_date: '2026-02-24',
	})
	const executors: DOExecutor[] = []
	const namespace = new DurableObjectNamespaceImpl(db, 'ConstructorAlarmCompatibility', directory, { evictionTimeoutMs: 0 }, {
		create(config) {
			const executor = factory.create(config)
			executors.push(executor)
			return executor
		},
	})
	const id = namespace.idFromName('constructor')
	const storage = new SqliteDurableObjectStorage(db, 'ConstructorAlarmCompatibility', id.toString())
	try {
		const deadline = Date.now() + 1500
		await storage.put('value', 'persisted')
		await storage.setAlarm(deadline)
		namespace._setExternalClass('ConstructorAlarmCompatibility', {})
		namespace.get(id)
		const executor = executors[0]
		if (!executor) throw new Error('Missing executor')
		await executor.executeRpc('release', [])
		expect(Date.now()).toBeLessThan(deadline)
		expect(await storage.getAlarm()).toBeNull()
		expect(await storage.get('value')).toBeUndefined()
		await Bun.sleep(Math.max(0, deadline - Date.now()) + 100)
		expect(await storage.get('started')).toBeUndefined()
		expect(await storage.get('finished')).toBeUndefined()
	} finally {
		namespace.destroy({ force: true })
		await Promise.all(executors.map(executor => executor.dispose()))
		db.close()
		rmSync(directory, { recursive: true, force: true })
	}
}, 10000)
