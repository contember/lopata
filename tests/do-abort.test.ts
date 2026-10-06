import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DOAlarmMutationOwnership, DOExecutor, ExecutorConfig } from '../src/bindings/do-executor'
import { InProcessExecutor } from '../src/bindings/do-executor-inprocess'
import { WorkerExecutorFactory } from '../src/bindings/do-executor-worker'
import { DurableObjectBase, DurableObjectIdImpl, DurableObjectNamespaceImpl, SqliteDurableObjectStorage } from '../src/bindings/durable-object'
import { RPC_TARGET_BRAND } from '../src/bindings/rpc-stub'
import { resolveCompatibility } from '../src/compatibility'
import { runMigrations } from '../src/db'
import { runTracingMigrations } from '../src/tracing/db'
import { createInvocationTrace } from '../src/tracing/invocation'
import { setTraceStore, TraceStore } from '../src/tracing/store'

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
	const stub = namespace.get(id)
	if (typeof stub !== 'object' || stub === null) throw new Error('Missing Durable Object stub')
	const storage = new SqliteDurableObjectStorage(db, 'AbortProbe', id.toString())
	const call = async (method: string, ...args: unknown[]) => {
		const fn: unknown = Reflect.get(stub, method)
		if (typeof fn !== 'function') throw new Error('Missing RPC method')
		return Reflect.apply(fn, stub, args)
	}
	return {
		db,
		directory,
		id,
		namespace,
		executors,
		storage,
		call,
		async close() {
			namespace.destroy({ force: true })
			await Promise.all(executors.map(executor => executor.dispose()))
			db.close()
			rmSync(directory, { recursive: true, force: true })
		},
	}
}

for (const concurrent of [false, true]) {
	for (const retryAlarm of [undefined, true, false]) {
		test(`thread ${concurrent ? 'concurrent' : 'self'} abort retry=${String(retryAlarm)}`, async () => {
			const h = threadHarness()
			try {
				await h.call('configure', concurrent ? 'hold' : 'self', retryAlarm)
				const firing = h.namespace.triggerAlarm(h.id.toString())
				if (concurrent) {
					await until(async () => await h.storage.get<number>('attempts') === 1)
					expect(await outcome(h.call('abortNow', retryAlarm))).toBeInstanceOf(Error)
				}
				await firing
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
		}, 10000)
	}
}

test('thread abort waits for rollback and lock release before replacement construction', async () => {
	const h = threadHarness()
	try {
		const pending = outcome(h.call('holdTransaction'))
		await until(async () => {
			const status: unknown = await h.call('status')
			return typeof status === 'object' && status !== null && 'transactionOpen' in status && status.transactionOpen === true
		})
		expect(await outcome(h.call('abortNow', false))).toBeInstanceOf(Error)
		expect(await pending).toBeInstanceOf(Error)
		expect(await h.call('status')).toEqual({ constructors: 2, transactionOpen: false })
		expect(await h.storage.get<string>('committed')).toBe('kept')
		expect(await h.storage.get('uncommitted')).toBeUndefined()
		const sql = new Database(join(h.directory, 'do-sql', 'AbortProbe', `${h.id}.sqlite`))
		try {
			sql.run('PRAGMA busy_timeout=0')
			expect(sql.query('SELECT value FROM probe').all()).toEqual([{ value: 'committed' }])
			sql.run("INSERT INTO probe VALUES ('replacement')")
		} finally {
			sql.close()
		}
	} finally {
		await h.close()
	}
}, 10000)

test('main terminates a worker spinning after catching abort before constructing its replacement', async () => {
	const h = threadHarness()
	try {
		expect(await outcome(h.call('spinAfterAbort'))).toBeInstanceOf(Error)
		expect(await h.call('status')).toEqual({ constructors: 2, transactionOpen: false })
	} finally {
		await h.close()
	}
}, 10000)

test('abort closes executor-owned alarm spans without closing the adopted caller', async () => {
	const traceDb = new Database(':memory:')
	runTracingMigrations(traceDb)
	setTraceStore(new TraceStore(traceDb))
	const outer = createInvocationTrace({ name: 'abort-caller', kind: 'server' })
	const h = threadHarness()
	try {
		await h.call('configure', 'hold')
		const firing = outer.run(() => h.namespace.triggerAlarm(h.id.toString()))
		await until(() => traceDb.query('SELECT 1 FROM spans WHERE name = ? AND end_time IS NULL').get('abort-alarm-owned') !== null)
		await outcome(h.call('abortNow', false))
		await firing
		expect(traceDb.query('SELECT status FROM spans WHERE name = ? AND end_time IS NOT NULL').get('abort-alarm-owned')).toEqual({ status: 'error' })
		expect(traceDb.query('SELECT status FROM spans WHERE name = ? AND end_time IS NOT NULL').get('do.alarm AbortProbe')).toEqual({ status: 'error' })
		expect(outer.closed).toBe(false)
		expect(traceDb.query('SELECT end_time FROM spans WHERE name = ?').get('abort-caller')).toEqual({ end_time: null })
	} finally {
		await h.close()
		outer.finishHandler()
		setTraceStore(null)
		traceDb.close()
	}
})

for (const change of ['replace', 'cancel']) {
	test(`stale ordinary failure cannot overwrite ${change}; identical timestamp replacements survive`, async () => {
		const h = threadHarness()
		try {
			await h.call('configure', 'fail')
			const time = Date.now() + 60_000
			await h.call('arm', time)
			const firing = h.namespace.triggerAlarm(h.id.toString())
			await until(async () => await h.storage.get<number>('attempts') === 1)
			await h.call(change === 'replace' ? 'arm' : 'cancel', time)
			await h.call('release')
			await firing
			expect(await h.storage.getAlarm()).toBe(change === 'replace' ? time : null)
		} finally {
			await h.close()
		}
	})
}

test('no-retry abort preserves a newer scheduled alarm', async () => {
	const h = threadHarness()
	try {
		await h.call('configure', 'hold')
		const firing = h.namespace.triggerAlarm(h.id.toString())
		await until(async () => await h.storage.get<number>('attempts') === 1)
		const time = Date.now() + 300
		await h.call('arm', time)
		await outcome(h.call('abortNow', false))
		await firing
		expect(await h.storage.getAlarm()).toBe(time)
		await until(async () => await h.storage.get<boolean>('finished') === true)
		expect(await h.storage.get<number>('constructors')).toBe(2)
	} finally {
		await h.close()
	}
})

test('user error properties cannot suppress retry', async () => {
	const h = threadHarness()
	try {
		await h.call('configure', 'fail')
		const firing = h.namespace.triggerAlarm(h.id.toString())
		await until(async () => await h.storage.get<number>('attempts') === 1)
		await h.call('release')
		await firing
		await until(async () => await h.storage.get<boolean>('finished') === true)
	} finally {
		await h.close()
	}
})

test('in-process first abort wins, captured storage is fenced, pending call rejects before actual settlement', async () => {
	const db = new Database(':memory:')
	runMigrations(db)
	const release = Promise.withResolvers<void>()
	const entered = Promise.withResolvers<void>()
	let caught = 0
	class Probe extends DurableObjectBase {
		async hold() {
			entered.resolve()
			await release.promise
		}
		async alarm() {
			const storage = this.ctx.storage
			const kv = storage.kv
			const sql = storage.sql
			try {
				this.ctx.abort('first', { retryAlarm: false })
			} catch {
				caught++
			}
			try {
				this.ctx.abort('second', { retryAlarm: true })
			} catch {
				caught++
			}
			try {
				kv.put('late', true)
			} catch {
				caught++
			}
			try {
				sql.exec('CREATE TABLE late (id INTEGER)')
			} catch {
				caught++
			}
			try {
				await storage.put('late', true)
			} catch {
				caught++
			}
		}
	}
	const config: ExecutorConfig = { id: new DurableObjectIdImpl('id'), db, namespaceName: 'Probe', cls: Probe, env: {} }
	const executor = new InProcessExecutor(config)
	try {
		const pending = outcome(executor.executeRpc('hold', []))
		await entered.promise
		expect(await executor.executeAlarm(0)).toEqual({ type: 'aborted', policy: { reason: 'first', retryAlarm: false } })
		expect(await pending).toBeInstanceOf(Error)
		let stopped = false
		const stopping = executor.whenStopped().then(() => {
			stopped = true
		})
		await Bun.sleep(10)
		expect(stopped).toBe(false)
		release.resolve()
		await stopping
		expect(caught).toBe(5)
		expect(await new SqliteDurableObjectStorage(db, 'Probe', 'id').get('late')).toBeUndefined()
	} finally {
		release.resolve()
		await executor.whenStopped()
		await executor.dispose()
		db.close()
	}
})

test('alarm transaction notifications publish after commit and rollback keeps the preceding revision', async () => {
	const db = new Database(':memory:')
	runMigrations(db)
	const storage = new SqliteDurableObjectStorage(db, 'Probe', 'id', undefined, resolveCompatibility({ date: '2026-02-24' }))
	const notifications: { time: number | null; revision: number }[] = []
	storage._setAlarmCallback((time, revision) => notifications.push({ time, revision }))
	try {
		await storage.setAlarm(100)
		const original = notifications[0]
		if (!original) throw new Error('Missing initial alarm notification')
		await expect(storage.transaction(async txn => {
			await txn.setAlarm(200)
			await txn.deleteAlarm()
			expect(notifications).toEqual([original])
			throw new Error('rollback')
		})).rejects.toThrow('rollback')
		expect(await storage.getAlarm()).toBe(100)
		expect(notifications).toEqual([original])
		await storage.transaction(async txn => {
			await txn.setAlarm(100)
			expect(notifications).toEqual([original])
		})
		expect(notifications).toEqual([{ time: 100, revision: 1 }, { time: 100, revision: 2 }])
	} finally {
		db.close()
	}
})

test('in-process replacement waits for actual transaction settlement and preserves committed data', async () => {
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
			await this.ctx.storage.transaction(async txn => {
				await txn.put('uncommitted', true)
				entered.resolve()
				await release.promise
			})
		}
		kill() {
			this.ctx.abort('stop', { retryAlarm: false })
		}
		status() {
			return constructors
		}
	}
	const namespace = new DurableObjectNamespaceImpl(db, 'Probe', undefined, { evictionTimeoutMs: 0 })
	namespace._setClass(Probe, {})
	const id = namespace.idFromName('probe')
	const stub = namespace.get(id)
	if (typeof stub !== 'object' || stub === null) throw new Error('Missing stub')
	const call = async (method: string) => {
		const fn: unknown = Reflect.get(stub, method)
		if (typeof fn !== 'function') throw new Error('Missing method')
		return Reflect.apply(fn, stub, [])
	}
	try {
		const held = outcome(call('hold'))
		await entered.promise
		expect(await outcome(call('kill'))).toBeInstanceOf(Error)
		expect(await held).toBeInstanceOf(Error)
		let restarted = false
		const next = call('status').then(value => {
			restarted = true
			return value
		})
		await Bun.sleep(10)
		expect(restarted).toBe(false)
		expect(constructors).toBe(1)
		release.resolve()
		expect(await next).toBe(2)
		const storage = new SqliteDurableObjectStorage(db, 'Probe', id.toString())
		expect(await storage.get<boolean>('committed')).toBe(true)
		expect(await storage.get('uncommitted')).toBeUndefined()
	} finally {
		release.resolve()
		namespace.destroy({ force: true })
		db.close()
	}
})

test('delayed alarm notifications cannot rearm or cancel a newer revision', async () => {
	const db = new Database(':memory:')
	runMigrations(db)
	const notifications: { time: number | null; revision: number; ownership: DOAlarmMutationOwnership }[] = []
	let deliver: ExecutorConfig['onAlarmSet']
	let object: InProcessExecutor | undefined
	let fired = 0
	class Probe extends DurableObjectBase {
		alarm() {
			fired++
		}
	}
	const namespace = new DurableObjectNamespaceImpl(db, 'Probe', undefined, { evictionTimeoutMs: 0 }, {
		create(config) {
			deliver = config.onAlarmSet
			object = new InProcessExecutor({
				...config,
				onAlarmSet(time, revision, ownership) {
					notifications.push({ time, revision, ownership })
					config.onAlarmSet?.(time, revision, ownership)
				},
			})
			return object
		},
	})
	namespace._setClass(Probe, {})
	namespace.get(namespace.idFromName('probe'))
	if (!object || !deliver) throw new Error('Missing executor')
	try {
		const storage = object._rawState.storage
		await storage.setAlarm(Date.now() + 60_000)
		await storage.deleteAlarm()
		const stale = [...notifications]
		await storage.setAlarm(Date.now() + 100)
		for (const message of stale) deliver(message.time, message.revision, message.ownership)
		await until(() => fired === 1)
		expect(await storage.getAlarm()).toBeNull()
	} finally {
		namespace.destroy({ force: true })
		await object.dispose()
		db.close()
	}
})

test('aborted in-process constructor retains its settlement gate before replacement', async () => {
	const db = new Database(':memory:')
	runMigrations(db)
	const release = Promise.withResolvers<void>()
	let constructors = 0
	class Probe extends DurableObjectBase {
		constructor(...args: ConstructorParameters<typeof DurableObjectBase>) {
			super(...args)
			constructors++
			if (constructors === 1) {
				this.ctx.blockConcurrencyWhile(() => release.promise)
				this.ctx.abort('constructor abort')
			}
		}
		status() {
			return constructors
		}
	}
	const namespace = new DurableObjectNamespaceImpl(db, 'Probe', undefined, { evictionTimeoutMs: 0 })
	namespace._setClass(Probe, {})
	const stub = namespace.get(namespace.idFromName('probe'))
	if (typeof stub !== 'object' || stub === null) throw new Error('Missing stub')
	const status: unknown = Reflect.get(stub, 'status')
	if (typeof status !== 'function') throw new Error('Missing status method')
	try {
		let finished = false
		const pending = Promise.resolve(Reflect.apply(status, stub, [])).then(value => {
			finished = true
			return value
		})
		await Bun.sleep(10)
		expect(finished).toBe(false)
		expect(constructors).toBe(1)
		release.resolve()
		expect(await pending).toBe(2)
	} finally {
		release.resolve()
		namespace.destroy({ force: true })
		db.close()
	}
})

for (const concurrentAbort of [false, true]) {
	for (const retryAlarm of [undefined, true, false]) {
		test(`own deleteAll permits ${concurrentAbort ? 'concurrent' : 'self'} abort retry=${String(retryAlarm)}`, async () => {
			const h = threadHarness()
			try {
				await h.call('configure', concurrentAbort ? 'delete-hold' : 'delete-self', retryAlarm)
				const firing = h.namespace.triggerAlarm(h.id.toString())
				if (concurrentAbort) {
					await until(async () => await h.storage.get<boolean>('deleted') === true)
					expect(await outcome(h.call('abortNow', retryAlarm))).toBeInstanceOf(Error)
				}
				await firing
				if (retryAlarm === false) {
					expect(await h.storage.getAlarm()).toBeNull()
					await Bun.sleep(1100)
					expect(await h.storage.get<number>('attempts')).toBe(1)
					expect(h.executors).toHaveLength(1)
				} else {
					expect(await h.storage.getAlarm()).not.toBeNull()
					await until(async () => await h.storage.get<boolean>('finished') === true)
					expect(await h.storage.get<number>('attempts')).toBe(2)
					expect(h.executors).toHaveLength(2)
				}
			} finally {
				await h.close()
			}
		}, 10000)
	}
}

for (const change of ['cancel', 'replace']) {
	test(`external ${change} before own late deleteAll permanently supersedes the attempt`, async () => {
		const h = threadHarness()
		try {
			await h.call('configure', 'hold-delete', true)
			const firing = h.namespace.triggerAlarm(h.id.toString())
			await until(async () => await h.storage.get<number>('attempts') === 1)
			await h.call(change === 'cancel' ? 'cancel' : 'arm', Date.now() + 60_000)
			await outcome(h.call('release'))
			await firing
			expect(await h.storage.getAlarm()).toBeNull()
			expect(await h.storage.get<boolean>('deleted')).toBe(true)
			expect(h.executors).toHaveLength(1)
		} finally {
			await h.close()
		}
	})

	for (const retryAlarm of [undefined, true, false]) {
		test(`external ${change} after own deletion wins over concurrent abort retry=${String(retryAlarm)}`, async () => {
			const h = threadHarness()
			try {
				await h.call('configure', 'delete-hold')
				const firing = h.namespace.triggerAlarm(h.id.toString())
				await until(async () => await h.storage.get<boolean>('deleted') === true)
				const time = Date.now() + 60_000
				await h.call(change === 'cancel' ? 'cancel' : 'arm', time)
				await outcome(h.call('abortNow', retryAlarm))
				await firing
				expect(await h.storage.getAlarm()).toBe(change === 'cancel' ? null : time)
				expect(h.executors).toHaveLength(1)
			} finally {
				await h.close()
			}
		})
	}
}

test('an alarm own replacement at the original timestamp is never overwritten by its default retry', async () => {
	const h = threadHarness()
	try {
		const time = Date.now() + 60_000
		await h.call('configure', 'own-replace', undefined, time)
		await h.call('arm', time)
		await h.namespace.triggerAlarm(h.id.toString())
		expect(await h.storage.getAlarm()).toBe(time)
	} finally {
		await h.close()
	}
})

for (const mode of ['transaction-own-set-delete', 'transaction-hold-delete']) {
	test(`committed mutation history preserves supersession: ${mode}`, async () => {
		const h = threadHarness()
		try {
			await h.call('configure', mode, true, Date.now() + 60_000)
			const firing = h.namespace.triggerAlarm(h.id.toString())
			if (mode === 'transaction-hold-delete') {
				await until(async () => await h.storage.get<number>('attempts') === 1)
				await h.call('cancel')
				await outcome(h.call('release'))
			}
			await firing
			expect(await h.storage.getAlarm()).toBeNull()
			expect(h.executors).toHaveLength(1)
		} finally {
			await h.close()
		}
	})
}

for (const nestedRpc of [false, true]) {
	test(`in-process attempt ownership ${nestedRpc ? 'does not cross a nested RPC' : 'survives handler awaits'}`, async () => {
		const db = new Database(':memory:')
		runMigrations(db)
		let attempts = 0
		let cancelSelf: () => Promise<unknown> = async () => {
			throw new Error('Stub not initialized')
		}
		class Probe extends DurableObjectBase {
			async cancel() {
				await this.ctx.storage.deleteAlarm()
			}
			async alarm() {
				attempts++
				if (attempts > 1) return
				await this.ctx.storage.deleteAll()
				if (nestedRpc) await cancelSelf()
				this.ctx.abort('after deletion')
			}
		}
		const namespace = new DurableObjectNamespaceImpl(db, 'Probe', undefined, { evictionTimeoutMs: 0 })
		namespace._setClass(Probe, {}, undefined, resolveCompatibility({ date: '2026-02-24' }))
		const id = namespace.idFromName('probe')
		const stub = namespace.get(id)
		if (typeof stub !== 'object' || stub === null) throw new Error('Missing stub')
		cancelSelf = async () => {
			const cancel: unknown = Reflect.get(stub, 'cancel')
			if (typeof cancel !== 'function') throw new Error('Missing cancellation method')
			return Reflect.apply(cancel, stub, [])
		}
		try {
			await namespace.triggerAlarm(id.toString())
			const storage = new SqliteDurableObjectStorage(db, 'Probe', id.toString())
			if (nestedRpc) {
				expect(await storage.getAlarm()).toBeNull()
				expect(attempts).toBe(1)
			} else {
				expect(await storage.getAlarm()).not.toBeNull()
				await until(() => attempts === 2)
			}
		} finally {
			namespace.destroy({ force: true })
			db.close()
		}
	})
}

test('awaited property rejects when constructing an abort replacement fails', async () => {
	const db = new Database(':memory:')
	runMigrations(db)
	let constructors = 0
	class Probe extends DurableObjectBase {
		constructor(...args: ConstructorParameters<typeof DurableObjectBase>) {
			super(...args)
			constructors++
			if (constructors > 1) throw new Error('replacement constructor failed')
		}
		get value() {
			return 'ready'
		}
		kill() {
			this.ctx.abort('reset')
		}
	}
	const namespace = new DurableObjectNamespaceImpl(db, 'Probe', undefined, { evictionTimeoutMs: 0 })
	namespace._setClass(Probe, {})
	const stub = namespace.get(namespace.idFromName('probe'))
	if (typeof stub !== 'object' || stub === null) throw new Error('Missing stub')
	try {
		expect(await Reflect.get(stub, 'value')).toBe('ready')
		const kill: unknown = Reflect.get(stub, 'kill')
		if (typeof kill !== 'function') throw new Error('Missing abort method')
		expect(await outcome(Promise.resolve(Reflect.apply(kill, stub, [])))).toBeInstanceOf(Error)
		const rejection = await outcome(Promise.resolve(Reflect.get(stub, 'value')))
		expect(rejection).toBeInstanceOf(Error)
		if (!(rejection instanceof Error)) throw new Error('Expected replacement failure')
		expect(rejection.message).toBe('replacement constructor failed')
	} finally {
		namespace.destroy({ force: true })
		db.close()
	}
})

for (const capabilityKind of ['method-property', 'returned-function', 'target-method', 'target-getter', 'descendant', 'forwarded-function']) {
	test(`retained ${capabilityKind} abort rejects its caller and waits for transaction settlement before replacement writes`, async () => {
		const db = new Database(':memory:')
		runMigrations(db)
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		const settled = Promise.withResolvers<void>()
		let constructors = 0
		let holding = false
		class Probe extends DurableObjectBase {
			constructor(...args: ConstructorParameters<typeof DurableObjectBase>) {
				super(...args)
				constructors++
				this.ctx.storage.kv.put('generation', constructors)
			}
			async hold() {
				holding = true
				try {
					await this.ctx.storage.transaction(async txn => {
						await txn.put('uncommitted', true)
						entered.resolve()
						await release.promise
					})
				} finally {
					settled.resolve()
				}
			}
			callable() {
				return () => this.hold()
			}
			target() {
				const hold = () => this.hold()
				return {
					[RPC_TARGET_BRAND]: true,
					hold,
					get pending() {
						return hold()
					},
					child() {
						return { [RPC_TARGET_BRAND]: true, hold }
					},
				}
			}
			kill() {
				this.ctx.abort('reset retained call')
			}
			status() {
				return constructors
			}
		}
		const namespace = new DurableObjectNamespaceImpl(db, 'Probe', undefined, { evictionTimeoutMs: 0 })
		namespace._setClass(Probe, {})
		const id = namespace.idFromName('probe')
		const stub = namespace.get(id)
		if (typeof stub !== 'object' || stub === null) throw new Error('Missing stub')
		const call = (method: string): Promise<unknown> => {
			const fn: unknown = Reflect.get(stub, method)
			if (typeof fn !== 'function') throw new Error(`Missing method: ${method}`)
			return Promise.resolve(Reflect.apply(fn, stub, []))
		}
		let pending: Promise<unknown> | undefined
		let relay: DurableObjectNamespaceImpl | undefined
		try {
			let capability: unknown = capabilityKind === 'method-property' || capabilityKind === 'forwarded-function'
				? await Reflect.get(stub, 'hold')
				: await call(capabilityKind === 'returned-function' ? 'callable' : 'target')
			if (capabilityKind === 'forwarded-function') {
				const original = capability
				class Relay extends DurableObjectBase {
					pass() {
						return original
					}
				}
				relay = new DurableObjectNamespaceImpl(db, 'Relay', undefined, { evictionTimeoutMs: 0 })
				relay._setClass(Relay, {})
				const relayStub = relay.get(relay.idFromName('relay'))
				if (typeof relayStub !== 'object' || relayStub === null) throw new Error('Missing relay stub')
				const pass: unknown = Reflect.get(relayStub, 'pass')
				if (typeof pass !== 'function') throw new Error('Missing forwarding method')
				capability = await Reflect.apply(pass, relayStub, [])
			}
			if (capabilityKind === 'descendant') {
				if (typeof capability !== 'object' || capability === null) throw new Error('Missing target')
				const child: unknown = Reflect.get(capability, 'child')
				if (typeof child !== 'function') throw new Error('Missing child method')
				capability = await Reflect.apply(child, capability, [])
			}
			let operation: unknown
			if (typeof capability === 'function') operation = Reflect.apply(capability, undefined, [])
			else {
				if (typeof capability !== 'object' || capability === null) throw new Error('Missing target')
				if (capabilityKind === 'target-getter') operation = Reflect.get(capability, 'pending')
				else {
					const hold: unknown = Reflect.get(capability, 'hold')
					if (typeof hold !== 'function') throw new Error('Missing retained method')
					operation = Reflect.apply(hold, capability, [])
				}
			}
			let rejected = false
			pending = outcome(Promise.resolve(operation)).then(result => {
				rejected = result instanceof Error
				return result
			})
			await entered.promise
			expect(await outcome(call('kill'))).toBeInstanceOf(Error)
			const replacement = call('status')
			await Bun.sleep(0)
			const beforeRelease = { rejected, constructors }
			release.resolve()
			await settled.promise
			expect(await pending).toBeInstanceOf(Error)
			const replacementGeneration = await replacement
			const storage = new SqliteDurableObjectStorage(db, 'Probe', id.toString())
			expect({
				beforeRelease,
				replacementGeneration,
				persistedGeneration: await storage.get<number>('generation'),
				uncommitted: await storage.get('uncommitted'),
			}).toEqual({
				beforeRelease: { rejected: true, constructors: 1 },
				replacementGeneration: 2,
				persistedGeneration: 2,
				uncommitted: undefined,
			})
		} finally {
			release.resolve()
			if (pending) await pending
			if (holding) await settled.promise
			relay?.destroy({ force: true })
			namespace.destroy({ force: true })
			db.close()
		}
	})
}
