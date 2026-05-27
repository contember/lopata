import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkerExecutorFactory } from '../src/bindings/do-executor-worker'
import { DurableObjectIdImpl, DurableObjectNamespaceImpl } from '../src/bindings/durable-object'
import { runMigrations } from '../src/db'

/**
 * Isolated-mode tests.
 *
 * These run the same DO contract as the in-process tests but with each
 * DO instance in a separate Bun Worker thread (WorkerExecutor).
 *
 * Setup: writes a temp worker module + wrangler config to disk, then
 * creates a WorkerExecutorFactory pointing at them.
 */

let tempDir: string
let dataDir: string
let db: Database
let factory: WorkerExecutorFactory
let modulePath: string
let configPath: string

beforeAll(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'lopata-isolated-'))
	dataDir = join(tempDir, '.lopata')
	mkdirSync(dataDir, { recursive: true })

	// Create a worker module with test DO classes
	modulePath = join(tempDir, 'worker.ts')
	writeFileSync(
		modulePath,
		`
    import { DurableObject } from "cloudflare:workers";

    export class TestCounter extends DurableObject {
      async getCount() {
        return (await this.ctx.storage.get("count")) ?? 0;
      }
      async increment() {
        const count = ((await this.ctx.storage.get("count")) ?? 0) + 1;
        await this.ctx.storage.put("count", count);
        return count;
      }
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/count") {
          const count = await this.getCount();
          return new Response(String(count));
        }
        if (url.pathname === "/increment") {
          const count = await this.increment();
          return new Response(String(count));
        }
        return new Response("Not Found", { status: 404 });
      }
    }

    export class AlarmDO extends DurableObject {
      async alarm(info) {
        await this.ctx.storage.put("alarm-fired", true);
        await this.ctx.storage.put("retry-count", info.retryCount);
      }
    }

    export class FireAndForgetDO extends DurableObject {
      async startBackground() {
        // Fire-and-forget: this promise should die with worker.terminate()
        (async () => {
          await new Promise(r => setTimeout(r, 5000));
          await this.ctx.storage.put("background-done", true);
        })();
        return "started";
      }
      async checkBackground() {
        return (await this.ctx.storage.get("background-done")) ?? false;
      }
    }

    export class HibernationDO extends DurableObject {
      async fetch(request) {
        if (request.headers.get('Upgrade') !== 'websocket') {
          return new Response('Expected websocket', { status: 426 });
        }
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        this.ctx.acceptWebSocket(server);
        return new Response(null, { status: 101, webSocket: client });
      }
    }

    export class SelfRefDO extends DurableObject {
      async probeSelf() {
        // Touching this.env.SELF_REF.anything must throw — see Finding D.
        try {
          const id = this.env.SELF_REF.idFromName('peer');
          await this.env.SELF_REF.get(id).probeSelf();
          return 'ok';
        } catch (e) {
          return 'threw:' + e.message;
        }
      }
      async probeCrossProbes() {
        // Introspection-only members on a cross-DO stub must NOT throw — see Finding E.
        const ref = this.env.OTHER_DO;
        return {
          then: ref.then,
          toJSON: ref.toJSON,
          toString: ref.toString,
          inspectSym: ref[Symbol.for('nodejs.util.inspect.custom')],
        };
      }
      async probeCrossUse() {
        try {
          await this.env.OTHER_DO.something();
          return 'no-throw';
        } catch (e) {
          return 'threw:' + e.message;
        }
      }
    }

    export class OtherDO extends DurableObject {
      async noop() { return 'noop'; }
    }

    export default {
      async fetch() {
        return new Response("ok");
      }
    };
  `,
	)

	// Create wrangler config
	configPath = join(tempDir, 'wrangler.json')
	writeFileSync(
		configPath,
		JSON.stringify({
			name: 'test-isolated',
			main: './worker.ts',
			durable_objects: {
				bindings: [
					{ name: 'COUNTER', class_name: 'TestCounter' },
					{ name: 'ALARM', class_name: 'AlarmDO' },
					{ name: 'FIRE_AND_FORGET', class_name: 'FireAndForgetDO' },
					{ name: 'HIBERNATION', class_name: 'HibernationDO' },
					{ name: 'SELF_REF', class_name: 'SelfRefDO' },
					{ name: 'OTHER_DO', class_name: 'OtherDO' },
				],
			},
		}),
	)

	// Create DB
	const dbPath = join(dataDir, 'data.sqlite')
	db = new Database(dbPath, { create: true })
	db.run('PRAGMA journal_mode=WAL')
	runMigrations(db)

	// Create factory
	factory = new WorkerExecutorFactory()
	factory.configure(modulePath, configPath)
})

afterAll(() => {
	db.close()
})

describe('Isolated DO — basic RPC', () => {
	test('RPC method calls work through worker thread', async () => {
		const ns = new DurableObjectNamespaceImpl(db, 'TestCounter', dataDir, { evictionTimeoutMs: 0 }, factory)
		ns._setClass(class {} as any, {}) // Dummy class — worker loads the real one

		const id = ns.idFromName('rpc-test')
		const stub = ns.get(id) as any

		const count0 = await stub.getCount()
		expect(count0).toBe(0)

		const count1 = await stub.increment()
		expect(count1).toBe(1)

		const count2 = await stub.increment()
		expect(count2).toBe(2)

		const count = await stub.getCount()
		expect(count).toBe(2)

		// Cleanup
		const executor = ns._getExecutor(id.toString())
		if (executor) await executor.dispose()
	})

	test('stub.fetch works through worker thread', async () => {
		const ns = new DurableObjectNamespaceImpl(db, 'TestCounter', dataDir, { evictionTimeoutMs: 0 }, factory)
		ns._setClass(class {} as any, {})

		const id = ns.idFromName('fetch-test')
		const stub = ns.get(id) as any

		// Increment twice via fetch
		await stub.fetch('http://fake/increment')
		await stub.fetch('http://fake/increment')

		// Read count via fetch
		const resp = await stub.fetch('http://fake/count')
		expect(resp.status).toBe(200)
		expect(await resp.text()).toBe('2')

		const executor = ns._getExecutor(id.toString())
		if (executor) await executor.dispose()
	})

	test('different ids have independent state', async () => {
		const ns = new DurableObjectNamespaceImpl(db, 'TestCounter', dataDir, { evictionTimeoutMs: 0 }, factory)
		ns._setClass(class {} as any, {})

		const id1 = ns.idFromName('iso-a')
		const id2 = ns.idFromName('iso-b')
		const stub1 = ns.get(id1) as any
		const stub2 = ns.get(id2) as any

		await stub1.increment()
		await stub1.increment()

		expect(await stub1.getCount()).toBe(2)
		expect(await stub2.getCount()).toBe(0)

		const exec1 = ns._getExecutor(id1.toString())
		const exec2 = ns._getExecutor(id2.toString())
		if (exec1) await exec1.dispose()
		if (exec2) await exec2.dispose()
	})
})

describe('Isolated DO — dispose terminates worker', () => {
	test('fire-and-forget promises die with worker.terminate()', async () => {
		const ns = new DurableObjectNamespaceImpl(db, 'FireAndForgetDO', dataDir, { evictionTimeoutMs: 0 }, factory)
		ns._setClass(class {} as any, {})

		const id = ns.idFromName('fire-forget-test')
		const stub = ns.get(id) as any

		// Start background work
		const result = await stub.startBackground()
		expect(result).toBe('started')

		// Dispose (terminate worker) — background promise should die
		const executor = ns._getExecutor(id.toString())
		if (executor) await executor.dispose()

		// Wait a bit
		await new Promise(r => setTimeout(r, 200))

		// Create a new instance to check if background work completed
		// (it should NOT have because the worker was terminated)
		const ns2 = new DurableObjectNamespaceImpl(db, 'FireAndForgetDO', dataDir, { evictionTimeoutMs: 0 }, factory)
		ns2._setClass(class {} as any, {})

		const stub2 = ns2.get(id) as any
		const bgDone = await stub2.checkBackground()
		expect(bgDone).toBe(false)

		const exec2 = ns2._getExecutor(id.toString())
		if (exec2) await exec2.dispose()
	})

	test('dispose rejects in-flight commands', async () => {
		// Worker thread startup + message passing can be slow in CI
		const ns = new DurableObjectNamespaceImpl(db, 'TestCounter', dataDir, { evictionTimeoutMs: 0 }, factory)
		ns._setClass(class {} as any, {})

		const id = ns.idFromName('dispose-reject-test')
		const stub = ns.get(id) as any

		// Get stub working first
		await stub.getCount()

		// Start a slow operation and immediately dispose
		const executor = ns._getExecutor(id.toString())!
		const slowPromise = stub.increment()
		await executor.dispose()

		// The slow operation should be rejected
		await expect(slowPromise).rejects.toThrow()
	}, 15_000)
})

describe('Isolated DO — stub properties', () => {
	test('stub.id and stub.name work', async () => {
		const ns = new DurableObjectNamespaceImpl(db, 'TestCounter', dataDir, { evictionTimeoutMs: 0 }, factory)
		ns._setClass(class {} as any, {})

		const id = ns.idFromName('props-test')
		const stub = ns.get(id) as any

		expect(stub.id).toBe(id)
		expect(stub.name).toBe('props-test')

		const executor = ns._getExecutor(id.toString())
		if (executor) await executor.dispose()
	})

	test('stub.then is undefined (not thenable)', () => {
		const ns = new DurableObjectNamespaceImpl(db, 'TestCounter', dataDir, { evictionTimeoutMs: 0 }, factory)
		ns._setClass(class {} as any, {})

		const id = ns.idFromName('then-test')
		const stub = ns.get(id) as any

		expect(stub.then).toBeUndefined()
		expect(stub.catch).toBeUndefined()
		expect(stub.finally).toBeUndefined()
	})
})

describe('Isolated DO — data persistence', () => {
	test('data persists across executor lifecycles (same DB)', async () => {
		const ns1 = new DurableObjectNamespaceImpl(db, 'TestCounter', dataDir, { evictionTimeoutMs: 0 }, factory)
		ns1._setClass(class {} as any, {})

		const id = ns1.idFromName('persist-test')
		const stub1 = ns1.get(id) as any
		await stub1.increment()
		await stub1.increment()
		expect(await stub1.getCount()).toBe(2)

		// Dispose first executor
		const exec1 = ns1._getExecutor(id.toString())
		if (exec1) await exec1.dispose()

		// Create new namespace + executor pointing to same DB
		const ns2 = new DurableObjectNamespaceImpl(db, 'TestCounter', dataDir, { evictionTimeoutMs: 0 }, factory)
		ns2._setClass(class {} as any, {})

		const stub2 = ns2.get(id) as any
		expect(await stub2.getCount()).toBe(2)

		const exec2 = ns2._getExecutor(id.toString())
		if (exec2) await exec2.dispose()
	})
})

describe('Isolated DO — env-binding stubs (Findings D + E)', () => {
	test('self-DO env access throws with a clear error (Finding D)', async () => {
		const ns = new DurableObjectNamespaceImpl(db, 'SelfRefDO', dataDir, { evictionTimeoutMs: 0 }, factory)
		ns._setClass(class {} as any, {})

		const stub = ns.get(ns.idFromName('self-d')) as any
		const result = (await stub.probeSelf()) as string
		// Forking instance state would silently return 'ok'. The fix throws with
		// the cross-DO stub message — verify both that it threw and that the
		// message names the binding.
		expect(result.startsWith('threw:')).toBe(true)
		expect(result).toContain('SELF_REF')

		const executor = ns._getExecutor(ns.idFromName('self-d').toString())
		if (executor) await executor.dispose()
	})

	test('cross-DO stub allows JS introspection probes (Finding E)', async () => {
		const ns = new DurableObjectNamespaceImpl(db, 'SelfRefDO', dataDir, { evictionTimeoutMs: 0 }, factory)
		ns._setClass(class {} as any, {})

		const stub = ns.get(ns.idFromName('probe-e')) as any
		// `console.log(other)` / `JSON.stringify(other)` / `await other` /
		// `nodejs.util.inspect.custom` all hit the proxy through these props
		// without intending to use the binding. Must not throw.
		const probes = await stub.probeCrossProbes()
		expect(probes).toBeDefined()
		expect(probes.then).toBeUndefined()
		expect(probes.toJSON).toBeUndefined()
		expect(probes.toString).toBeUndefined()
		expect(probes.inspectSym).toBeUndefined()

		// Actual cross-DO method *use* still throws loudly.
		const useResult = (await stub.probeCrossUse()) as string
		expect(useResult.startsWith('threw:')).toBe(true)
		expect(useResult).toContain('OTHER_DO')

		const executor = ns._getExecutor(ns.idFromName('probe-e').toString())
		if (executor) await executor.dispose()
	})
})

describe('Isolated DO — pump on disposed executor (Finding C)', () => {
	test('executeFetch on a disposed executor cancels (not locks) the body source', async () => {
		const ns = new DurableObjectNamespaceImpl(db, 'TestCounter', dataDir, { evictionTimeoutMs: 0 }, factory)
		ns._setClass(class {} as any, {})

		const id = ns.idFromName('disposed-pump')
		const stub = ns.get(id) as any
		// Warm up so the worker is actually created, then dispose.
		await stub.fetch('http://do/count')
		const executor = ns._getExecutor(id.toString())!
		await executor.dispose()

		// Streaming body — `Request.body` becomes a `ReadableStream` from this.
		// Before the fix, `_pumpFetchRequestBody` would still kick off after
		// `_sendCommand` rejected; `pumpStream` grabbed the source reader and
		// its loop returned early because `_disposed=true` (so it never
		// released the reader), leaving the source stream perpetually locked.
		// After the fix, the disposed branch cancels the body directly.
		let cancelReason: unknown = null
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('chunk1'))
				// Don't close — simulates a long-lived upload.
			},
			cancel(reason) {
				cancelReason = reason ?? 'cancelled'
			},
		})
		const request = new Request('http://do/stream', { method: 'POST', body, duplex: 'half' } as RequestInit)

		await expect(executor.executeFetch(request)).rejects.toThrow()

		// The body must have been cancelled (no longer locked, and `cancel`
		// callback fired). Pre-fix, neither happened.
		await new Promise(r => setTimeout(r, 50))
		expect(cancelReason).not.toBe(null)
		expect(body.locked).toBe(false)
	})
})

describe('Isolated DO — hibernation WS count (Finding B)', () => {
	test('state.acceptWebSocket increments activeWebSocketCount on main', async () => {
		const ns = new DurableObjectNamespaceImpl(db, 'HibernationDO', dataDir, { evictionTimeoutMs: 0 }, factory)
		ns._setClass(class {} as any, {})

		const id = ns.idFromName('hib-count')
		const stub = ns.get(id) as any
		const upgrade = new Request('http://do/', { headers: { Upgrade: 'websocket' } })
		const resp = await stub.fetch(upgrade)
		expect(resp.status).toBe(101)
		expect((resp as Response & { webSocket?: unknown }).webSocket).toBeDefined()

		// The post-`ws-bridge ws-accept` signal hops to main asynchronously;
		// give it a tick to land. Without the fix the counter never moves.
		await new Promise(r => setTimeout(r, 50))

		// Without the fix, `state.acceptWebSocket(server)` never signalled main
		// and `activeWebSocketCount()` stayed 0, so `hasActiveWebSockets()`
		// returned false and the idle reaper would evict the executor mid-WS.
		expect(ns.hasActiveWebSockets()).toBe(true)

		const executor = ns._getExecutor(id.toString())!
		expect(executor.activeWebSocketCount()).toBeGreaterThan(0)

		await executor.dispose()
	})
})
