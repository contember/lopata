import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { DOExecutor } from '../src/bindings/do-executor'
import { WorkerExecutorFactory } from '../src/bindings/do-executor-worker'
import { DurableObjectNamespaceImpl } from '../src/bindings/durable-object'
import type { WranglerConfig } from '../src/config'
import { runMigrations } from '../src/db'
import { WorkerThreadExecutor } from '../src/worker-thread/executor'

// A dynamic worker is a Worker nested in the thread that owns the loader. Bun terminates nested Workers
// with their parent (pinned in bun-runtime-assumptions.test.ts); these tests check that end to end, and
// that main removes the owner thread's loader directory once the thread closes.

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

/** Wait until the tick count holds still, then require it to stay put for another window. */
async function expectStopped(): Promise<void> {
	const deadline = Date.now() + 5000
	let previous = ticks()
	for (;;) {
		await Bun.sleep(100)
		const current = ticks()
		if (current === previous) break
		if (Date.now() > deadline) throw new Error('The dynamic worker kept running')
		previous = current
	}
	await Bun.sleep(300)
	expect(ticks()).toBe(previous)
}

/** The owner thread's loader directory: the parent of the dynamic worker's module directory. */
function ownerLoaderDir(): string {
	const dir = dirname(readFileSync(`${tickFile}.dir`, 'utf8'))
	expect(basename(dir).startsWith(`${process.pid}-`)).toBe(true)
	expect(existsSync(dir)).toBe(true)
	return dir
}

async function expectRemoved(dir: string): Promise<void> {
	const deadline = Date.now() + 5000
	while (existsSync(dir)) {
		if (Date.now() > deadline) throw new Error(`${dir} was not removed`)
		await Bun.sleep(20)
	}
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
		let loaderDir = ''
		try {
			await executor.ready()
			const response = await executor.executeFetch(new Request(`http://localhost/?file=${encodeURIComponent(tickFile)}`))
			expect(await response.text()).toBe('ticking')
			await untilTicking()
			loaderDir = ownerLoaderDir()
		} finally {
			executor.dispose()
		}
		await expectStopped()
		await expectRemoved(loaderDir)
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
		let loaderDir = ''
		try {
			expect(await h.call('startTicker', tickFile)).toBe('ticking')
			await untilTicking()
			loaderDir = ownerLoaderDir()
		} finally {
			await h.close()
		}
		await expectStopped()
		await expectRemoved(loaderDir)
	}, 15_000)

	test('ctx.abort() in a Durable Object terminates the dynamic workers it spawned', async () => {
		const h = doHarness()
		try {
			expect(await h.call('startTicker', tickFile)).toBe('ticking')
			await untilTicking()
			const loaderDir = ownerLoaderDir()
			await h.call('abortNow').then(() => {}, () => {})
			await expectStopped()
			await expectRemoved(loaderDir)
		} finally {
			await h.close()
		}
	}, 15_000)
})
