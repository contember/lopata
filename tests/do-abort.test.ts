import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DOExecutor } from '../src/bindings/do-executor'
import { WorkerExecutorFactory } from '../src/bindings/do-executor-worker'
import { DurableObjectBase, DurableObjectNamespaceImpl, SqliteDurableObjectStorage } from '../src/bindings/durable-object'
import { runMigrations } from '../src/db'

async function until(check: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 5000
	while (!await check()) {
		if (Date.now() > deadline) throw new Error('Observation timed out')
		await Bun.sleep(10)
	}
}

function outcome(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(value => value, (error: unknown) => error)
}

function stubCaller(stub: unknown) {
	if (typeof stub !== 'object' || stub === null) throw new Error('Missing Durable Object stub')
	return async (method: string, ...args: unknown[]) => {
		const fn: unknown = Reflect.get(stub, method)
		if (typeof fn !== 'function') throw new Error(`Missing RPC method: ${method}`)
		return Reflect.apply(fn, stub, args)
	}
}

function threadHarness() {
	const directory = mkdtempSync(join(tmpdir(), 'lopata-do-abort-'))
	const db = new Database(join(directory, 'data.sqlite'))
	db.run('PRAGMA journal_mode=WAL')
	db.run('PRAGMA busy_timeout=5000')
	runMigrations(db)
	const factory = new WorkerExecutorFactory()
	factory.configure(join(import.meta.dir, 'fixtures/do-abort-worker.ts'), join(directory, 'wrangler.json'), {
		name: 'abort-probe',
		compatibility_date: '2026-02-24',
	})
	const executors: DOExecutor[] = []
	const namespace = new DurableObjectNamespaceImpl(db, 'AbortProbe', directory, { evictionTimeoutMs: 0 }, {
		create(config) {
			const executor = factory.create(config)
			executors.push(executor)
			return executor
		},
	})
	namespace._setExternalClass('AbortProbe', {})
	const id = namespace.idFromName('probe')
	return {
		directory,
		id,
		namespace,
		storage: new SqliteDurableObjectStorage(db, 'AbortProbe', id.toString()),
		call: stubCaller(namespace.get(id)),
		async close() {
			namespace.destroy({ force: true })
			await Promise.all(executors.map(executor => executor.dispose()))
			db.close()
			rmSync(directory, { recursive: true, force: true })
		},
	}
}

test('thread abort rejects the caller with its reason and the next request constructs a fresh instance', async () => {
	const h = threadHarness()
	try {
		expect(await h.call('status')).toEqual({ constructors: 1, transactionOpen: false })
		const rejection = await outcome(h.call('abortNow'))
		expect(rejection).toBeInstanceOf(Error)
		if (!(rejection instanceof Error)) throw new Error('Expected abort rejection')
		expect(rejection.message).toBe('requested abort')
		expect(await h.call('status')).toEqual({ constructors: 2, transactionOpen: false })
	} finally {
		await h.close()
	}
}, 10000)

test('thread abort rejects pending work, keeps committed writes and rolls back the open transaction', async () => {
	const h = threadHarness()
	try {
		const pending = outcome(h.call('holdTransaction'))
		await until(async () => {
			const status: unknown = await h.call('status')
			return typeof status === 'object' && status !== null && 'transactionOpen' in status && status.transactionOpen === true
		})
		expect(await outcome(h.call('abortNow'))).toBeInstanceOf(Error)
		expect(await pending).toBeInstanceOf(Error)
		expect(await h.call('status')).toEqual({ constructors: 2, transactionOpen: false })
		expect(await h.storage.get<string>('committed')).toBe('kept')
		expect(await h.storage.get('uncommitted')).toBeUndefined()
		const sql = new Database(join(h.directory, 'do-sql', 'AbortProbe', `${h.id}.sqlite`))
		try {
			sql.run('PRAGMA busy_timeout=5000')
			expect(sql.query('SELECT value FROM probe').all()).toEqual([{ value: 'committed' }])
		} finally {
			sql.close()
		}
	} finally {
		await h.close()
	}
}, 10000)

for (const retryAlarm of [undefined, false]) {
	test(
		`thread alarm aborted with retryAlarm=${String(retryAlarm)} ${retryAlarm === false ? 'is not retried' : 'is retried on a fresh instance'}`,
		async () => {
			const h = threadHarness()
			try {
				await h.call('configure', 'abort', retryAlarm)
				await h.namespace.triggerAlarm(h.id.toString())
				if (retryAlarm === false) {
					expect(await h.storage.getAlarm()).toBeNull()
					await Bun.sleep(1100)
					expect(await h.storage.get<number>('attempts')).toBe(1)
				} else {
					await until(async () => await h.storage.get<boolean>('finished') === true)
					expect(await h.storage.get<number>('attempts')).toBe(2)
					expect(await h.storage.get<number>('constructors')).toBe(2)
				}
			} finally {
				await h.close()
			}
		},
		10000,
	)
}

test('thread alarm that replaced its alarm before aborting keeps the replacement instead of retrying', async () => {
	const h = threadHarness()
	try {
		const replacementTime = Date.now() + 60_000
		await h.call('configure', 'replace', undefined, replacementTime)
		await h.namespace.triggerAlarm(h.id.toString())
		expect(await h.storage.getAlarm()).toBe(replacementTime)
		await Bun.sleep(1100)
		expect(await h.storage.get<number>('attempts')).toBe(1)
	} finally {
		await h.close()
	}
}, 10000)

test('thread alarm that deleted its alarm before aborting is not retried', async () => {
	const h = threadHarness()
	try {
		await h.call('configure', 'delete')
		await h.namespace.triggerAlarm(h.id.toString())
		expect(await h.storage.getAlarm()).toBeNull()
		await Bun.sleep(1100)
		expect(await h.storage.get<number>('attempts')).toBe(1)
	} finally {
		await h.close()
	}
}, 10000)

test('in-process abort rejects pending calls and the next request constructs a fresh instance', async () => {
	const db = new Database(':memory:')
	runMigrations(db)
	const entered = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	let constructors = 0
	class Probe extends DurableObjectBase {
		constructor(...args: ConstructorParameters<typeof DurableObjectBase>) {
			super(...args)
			constructors++
		}
		async hold() {
			await this.ctx.storage.put('committed', true)
			entered.resolve()
			await release.promise
		}
		kill() {
			this.ctx.abort('stop')
		}
		count() {
			return constructors
		}
	}
	const namespace = new DurableObjectNamespaceImpl(db, 'Probe', undefined, { evictionTimeoutMs: 0 })
	namespace._setClass(Probe, {})
	const id = namespace.idFromName('probe')
	const call = stubCaller(namespace.get(id))
	try {
		const held = outcome(call('hold'))
		await entered.promise
		const rejection = await outcome(call('kill'))
		expect(rejection).toBeInstanceOf(Error)
		if (!(rejection instanceof Error)) throw new Error('Expected abort rejection')
		expect(rejection.message).toBe('stop')
		expect(await held).toBeInstanceOf(Error)
		expect(await call('count')).toBe(2)
		expect(await new SqliteDurableObjectStorage(db, 'Probe', id.toString()).get<boolean>('committed')).toBe(true)
	} finally {
		release.resolve()
		namespace.destroy({ force: true })
		db.close()
	}
})
