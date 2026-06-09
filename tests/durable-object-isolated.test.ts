import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkerExecutorFactory } from '../src/bindings/do-executor-worker'
import { DurableObjectIdImpl, DurableObjectNamespaceImpl } from '../src/bindings/durable-object'
import type { CFWebSocket } from '../src/bindings/websocket-pair'
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
      async whoAmI() {
        // Identify the instance by its name (preserved via instanceName flow).
        return this.ctx.id.name ?? '<no-name>';
      }
      async incHere() {
        const v = ((await this.ctx.storage.get('n')) ?? 0) + 1;
        await this.ctx.storage.put('n', v);
        return v;
      }
      async getHere() {
        return (await this.ctx.storage.get('n')) ?? 0;
      }
      async callPeer(name) {
        // Cross-DO call to the same class via env-RPC. Lands on a separate
        // singleton instance ("peer") owned by main's namespace.
        const id = this.env.SELF_REF.idFromName(name);
        const stub = this.env.SELF_REF.get(id);
        const who = await stub.whoAmI();
        const n = await stub.incHere();
        return { who, n };
      }
      async callOther(name) {
        // Cross-class DO call via env-RPC.
        const id = this.env.OTHER_DO.idFromName(name);
        return this.env.OTHER_DO.get(id).noop();
      }
      async fetchPeer(name, path) {
        // Cross-DO fetch via env-RPC.
        const stub = this.env.SELF_REF.get(this.env.SELF_REF.idFromName(name));
        const resp = await stub.fetch('http://peer' + path);
        return { status: resp.status, body: await resp.text() };
      }
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/who') {
          return new Response(this.ctx.id.name ?? '<no-name>');
        }
        return new Response('not found', { status: 404 });
      }
    }

    export class OtherDO extends DurableObject {
      async noop() { return 'noop'; }
      async whoAmI() { return this.ctx.id.name ?? '<no-name>'; }
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

describe('Isolated DO — cross-DO routing via env-RPC', () => {
	/**
	 * Main owns the namespace; both DO bindings on the worker side are env-RPC
	 * proxies. To exercise the full cross-DO flow we share the same namespaces
	 * with main's executor factory so DO A's worker can route a call back into
	 * main, which dispatches to DO B's separate executor.
	 */
	function buildEnv(): { selfNs: DurableObjectNamespaceImpl; otherNs: DurableObjectNamespaceImpl; env: Record<string, unknown> } {
		const selfNs = new DurableObjectNamespaceImpl(db, 'SelfRefDO', dataDir, { evictionTimeoutMs: 0 }, factory)
		const otherNs = new DurableObjectNamespaceImpl(db, 'OtherDO', dataDir, { evictionTimeoutMs: 0 }, factory)
		const env = { SELF_REF: selfNs, OTHER_DO: otherNs }
		selfNs._setClass(class {} as any, env)
		otherNs._setClass(class {} as any, env)
		return { selfNs, otherNs, env }
	}

	test('self-DO call lands on a separate executor for the peer id', async () => {
		const { selfNs } = buildEnv()
		const callerId = selfNs.idFromName('caller')
		const caller = selfNs.get(callerId) as any

		const result = await caller.callPeer('peer')
		expect(result).toEqual({ who: 'peer', n: 1 })

		// The peer increment landed on a separate executor (different id),
		// not on the caller's storage.
		const peerId = selfNs.idFromName('peer')
		const peer = selfNs.get(peerId) as any
		expect(await peer.getHere()).toBe(1)
		expect(await caller.getHere()).toBe(0)

		// And the two executors really are distinct singletons.
		const callerExec = selfNs._getExecutor(callerId.toString())
		const peerExec = selfNs._getExecutor(peerId.toString())
		expect(callerExec).not.toBe(null)
		expect(peerExec).not.toBe(null)
		expect(callerExec).not.toBe(peerExec)

		if (callerExec) await callerExec.dispose()
		if (peerExec) await peerExec.dispose()
	})

	test('cross-class DO call routes through main to the other namespace', async () => {
		const { selfNs, otherNs } = buildEnv()
		const callerId = selfNs.idFromName('cross-caller')
		const caller = selfNs.get(callerId) as any

		const result = await caller.callOther('cross-target')
		expect(result).toBe('noop')

		// The target executor lives on the other namespace, not on SELF_REF.
		const targetId = otherNs.idFromName('cross-target')
		expect(otherNs._getExecutor(targetId.toString())).not.toBe(null)
		expect(selfNs._getExecutor(targetId.toString())).toBe(null)

		const callerExec = selfNs._getExecutor(callerId.toString())
		const targetExec = otherNs._getExecutor(targetId.toString())
		if (callerExec) await callerExec.dispose()
		if (targetExec) await targetExec.dispose()
	})

	test('cross-DO fetch through env-RPC reaches the peer instance', async () => {
		const { selfNs } = buildEnv()
		const callerId = selfNs.idFromName('fetch-caller')
		const caller = selfNs.get(callerId) as any

		const result = await caller.fetchPeer('fetch-peer', '/who')
		expect(result).toEqual({ status: 200, body: 'fetch-peer' })

		const callerExec = selfNs._getExecutor(callerId.toString())
		const peerExec = selfNs._getExecutor(selfNs.idFromName('fetch-peer').toString())
		if (callerExec) await callerExec.dispose()
		if (peerExec) await peerExec.dispose()
	})

	test('instanceName flows through env-RPC — ctx.id.name preserved on the target', async () => {
		// `whoAmI()` reads `this.ctx.id.name` on the peer. That value only
		// matches the caller-supplied name when `instanceName` is carried in
		// the `BindingTarget` and main reconstructs `DurableObjectIdImpl(idStr,
		// instanceName)` before resolving the executor.
		const { selfNs } = buildEnv()
		const callerId = selfNs.idFromName('name-caller')
		const caller = selfNs.get(callerId) as any

		const result = await caller.callPeer('name-target')
		expect(result.who).toBe('name-target')

		const callerExec = selfNs._getExecutor(callerId.toString())
		const peerExec = selfNs._getExecutor(selfNs.idFromName('name-target').toString())
		if (callerExec) await callerExec.dispose()
		if (peerExec) await peerExec.dispose()
	})

	test('self-DO call to the host id reaches the same executor (no deadlock, no fork)', async () => {
		// `env.SELF_REF.get(idFromName('A'))` from inside A resolves the same
		// singleton executor on main. The DO worker handles the re-entered
		// command in parallel (concurrent handler invocations, not a separate
		// fork): both calls see the same storage. Before the fix, this would
		// either throw (loud-throw stub) or silently fork into a duplicate
		// in-worker namespace.
		const { selfNs } = buildEnv()
		const id = selfNs.idFromName('reentry')
		const stub = selfNs.get(id) as any

		// Bump storage from inside, then verify the re-entrant peer call sees
		// the same storage (it ran on the same executor — no fork).
		await stub.incHere()
		const result = await stub.callPeer('reentry')
		expect(result.who).toBe('reentry')
		// `callPeer` calls `incHere()` on the peer (= same instance), so the
		// counter goes from 1 → 2 on the same storage row.
		expect(result.n).toBe(2)
		expect(await stub.getHere()).toBe(2)

		const executor = selfNs._getExecutor(id.toString())
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

	test('client disconnect decrements the count even when webSocketClose omits ws.close() (CORR-WS-1)', async () => {
		const ns = new DurableObjectNamespaceImpl(db, 'HibernationDO', dataDir, { evictionTimeoutMs: 0 }, factory)
		ns._setClass(class {} as any, {})

		const id = ns.idFromName('hib-client-disconnect')
		const stub = ns.get(id) as any
		const resp = await stub.fetch(new Request('http://do/', { headers: { Upgrade: 'websocket' } }))
		expect(resp.status).toBe(101)
		await new Promise(r => setTimeout(r, 50))

		const executor = ns._getExecutor(id.toString())!
		expect(executor.activeWebSocketCount()).toBe(1)

		// Simulate the real client disconnecting — in production cli/dev.ts
		// dispatches the close on the host socket's bridge peer. HibernationDO has
		// NO webSocketClose handler that calls ws.close(), so the server peer never
		// closes back; without the fix `_wsCount` would stay 1 forever and pin the
		// worker alive past the eviction timer.
		const hostWs = (resp as Response & { webSocket: CFWebSocket }).webSocket
		hostWs._peer?.dispatchOrQueue({ type: 'close', code: 1000, reason: '', wasClean: true })

		await new Promise(r => setTimeout(r, 50))
		expect(executor.activeWebSocketCount()).toBe(0)
		expect(ns.hasActiveWebSockets()).toBe(false)

		await executor.dispose()
	})
})
