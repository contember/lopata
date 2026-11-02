import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DOExecutor } from '../src/bindings/do-executor'
import { WorkerExecutorFactory } from '../src/bindings/do-executor-worker'
import { DurableObjectNamespaceImpl } from '../src/bindings/durable-object'
import type { WranglerConfig } from '../src/config'
import { runMigrations } from '../src/db'
import { WorkerThreadExecutor } from '../src/worker-thread/executor'

// Bun keeps a nested Worker running after its parent thread is terminated, so tearing down the
// thread that owns a Worker Loader must dispose the dynamic workers it spawned.

const FIXTURE = join(import.meta.dir, 'fixtures/loader-owner-worker.ts')
const CONFIG = {
	name: 'loader-owner',
	main: 'loader-owner-worker.ts',
	compatibility_date: '2026-03-01',
	worker_loaders: [{ binding: 'LOADER' }],
} as WranglerConfig

let directory: string
let tickFile: string

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'lopata-loader-owner-'))
	tickFile = join(directory, 'ticks')
})

afterEach(() => {
	rmSync(directory, { recursive: true, force: true })
})

function ticks(): number {
	return existsSync(tickFile) ? readFileSync(tickFile, 'utf8').length : 0
}

async function untilTicking(): Promise<void> {
	const deadline = Date.now() + 5000
	while (ticks() === 0) {
		if (Date.now() > deadline) throw new Error('The dynamic worker never started')
		await Bun.sleep(10)
	}
}

async function expectStopped(): Promise<void> {
	await Bun.sleep(150)
	const before = ticks()
	await Bun.sleep(200)
	expect(ticks()).toBe(before)
}

function stubCaller(stub: unknown) {
	if (typeof stub !== 'object' || stub === null) throw new Error('Missing Durable Object stub')
	return async (method: string, ...args: unknown[]) => {
		const fn: unknown = Reflect.get(stub, method)
		if (typeof fn !== 'function') throw new Error(`Missing RPC method: ${method}`)
		return Reflect.apply(fn, stub, args)
	}
}

describe('Worker Loader threads end with their owner', () => {
	test('disposing a worker thread terminates the dynamic workers it spawned', async () => {
		const executor = new WorkerThreadExecutor({ modulePath: FIXTURE, config: CONFIG, baseDir: directory, mainEnv: {} })
		try {
			await executor.ready()
			const response = await executor.executeFetch(new Request(`http://localhost/?file=${encodeURIComponent(tickFile)}`))
			expect(await response.text()).toBe('ticking')
			await untilTicking()
		} finally {
			executor.dispose()
		}
		await expectStopped()
	}, 15_000)

	function doHarness() {
		const db = new Database(join(directory, 'data.sqlite'))
		db.run('PRAGMA journal_mode=WAL')
		db.run('PRAGMA busy_timeout=5000')
		runMigrations(db)
		const factory = new WorkerExecutorFactory()
		factory.configure(FIXTURE, join(directory, 'wrangler.json'), CONFIG)
		const executors: DOExecutor[] = []
		const namespace = new DurableObjectNamespaceImpl(db, 'LoaderOwner', directory, { evictionTimeoutMs: 0 }, {
			create(config) {
				const executor = factory.create(config)
				executors.push(executor)
				return executor
			},
		})
		namespace._setExternalClass('LoaderOwner', {})
		return {
			call: stubCaller(namespace.get(namespace.idFromName('owner'))),
			async close() {
				namespace.destroy({ force: true })
				await Promise.all(executors.map(executor => executor.dispose()))
				db.close()
			},
		}
	}

	test('disposing a Durable Object thread terminates the dynamic workers it spawned', async () => {
		const h = doHarness()
		try {
			expect(await h.call('startTicker', tickFile)).toBe('ticking')
			await untilTicking()
		} finally {
			await h.close()
		}
		await expectStopped()
	}, 15_000)

	test('ctx.abort() in a Durable Object terminates the dynamic workers it spawned', async () => {
		const h = doHarness()
		try {
			expect(await h.call('startTicker', tickFile)).toBe('ticking')
			await untilTicking()
			await h.call('abortNow').then(() => {}, () => {})
			await expectStopped()
		} finally {
			await h.close()
		}
	}, 15_000)
})
