import { afterEach, describe, expect, test } from 'bun:test'
import { DurableObject, WorkflowEntrypoint } from 'cloudflare:workers'
import type { TestEnv } from '../src/testing'
import { createTestEnv } from '../src/testing'

let t: TestEnv | null = null

afterEach(() => {
	t?.dispose()
	t = null
})

describe('test isolation — global env', () => {
	test('env from cloudflare:workers reflects current test env', async () => {
		t = await createTestEnv({
			vars: { KEY: 'first' },
		})

		const { env } = await import('cloudflare:workers')
		expect(env.KEY).toBe('first')
	})

	test('env from cloudflare:workers reflects second test env (not leaked from first)', async () => {
		t = await createTestEnv({
			vars: { KEY: 'second' },
		})

		const { env } = await import('cloudflare:workers')
		expect(env.KEY).toBe('second')
		// First test's KEY should not be present
		expect(env.OTHER).toBeUndefined()
	})

	test('env is empty between tests (after dispose)', async () => {
		t = await createTestEnv({
			vars: { TEMP: 'alive' },
		})

		const { env } = await import('cloudflare:workers')
		expect(env.TEMP).toBe('alive')

		t.dispose()
		t = null

		// After dispose, env should be cleared
		expect(env.TEMP).toBeUndefined()
		expect(Object.keys(env)).toHaveLength(0)
	})

	test('vars from previous test are gone', async () => {
		t = await createTestEnv({
			vars: { FRESH: 'yes' },
		})

		const { env } = await import('cloudflare:workers')
		expect(env.FRESH).toBe('yes')
		// TEMP from previous test should not exist
		expect(env.TEMP).toBeUndefined()
	})
})

describe('test isolation — bindings do not leak', () => {
	test('KV data is isolated — test A writes', async () => {
		t = await createTestEnv({
			bindings: { KV: 'kv' },
		})

		await (t.env.KV as any).put('shared-key', 'from-test-A')
		expect(await (t.env.KV as any).get('shared-key')).toBe('from-test-A')
	})

	test('KV data is isolated — test B does not see test A data', async () => {
		t = await createTestEnv({
			bindings: { KV: 'kv' },
		})

		// Should not see data from previous test
		expect(await (t.env.KV as any).get('shared-key')).toBeNull()
	})

	test('D1 data is isolated — test A creates table', async () => {
		t = await createTestEnv({
			bindings: { DB: 'd1' },
		})

		const db = t.env.DB as any
		await db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)')
		await db.prepare('INSERT INTO items (name) VALUES (?)').bind('from-A').run()
		const row = await db.prepare('SELECT name FROM items').first()
		expect(row.name).toBe('from-A')
	})

	test('D1 data is isolated — test B has clean DB', async () => {
		t = await createTestEnv({
			bindings: { DB: 'd1' },
		})

		const db = t.env.DB as any
		// Table from previous test should not exist
		const result = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='items'").first()
		expect(result).toBeNull()
	})

	test('queue data is isolated', async () => {
		t = await createTestEnv({
			bindings: { Q: 'queue' },
		})

		await (t.env.Q as any).send({ msg: 'test-A' })
		const rows = t.db.query("SELECT * FROM queue_messages WHERE queue = 'Q'").all()
		expect(rows).toHaveLength(1)
	})

	test('queue data from previous test is gone', async () => {
		t = await createTestEnv({
			bindings: { Q: 'queue' },
		})

		const rows = t.db.query("SELECT * FROM queue_messages WHERE queue = 'Q'").all()
		expect(rows).toHaveLength(0)
	})
})

describe('test isolation — durable objects', () => {
	test('DO state is isolated — test A increments', async () => {
		class Counter extends DurableObject {
			async increment(): Promise<number> {
				const count = ((await this.ctx.storage.get('count') as number) ?? 0) + 1
				await this.ctx.storage.put('count', count)
				return count
			}
		}

		t = await createTestEnv({
			worker: { Counter } as any,
			bindings: { COUNTER: { type: 'durable-object', className: 'Counter' } },
		})

		const counter = t.durableObject('COUNTER').get('shared-name')
		expect(await counter.stub.increment()).toBe(1)
		expect(await counter.stub.increment()).toBe(2)
	})

	test('DO state is isolated — test B starts from zero', async () => {
		class Counter extends DurableObject {
			async increment(): Promise<number> {
				const count = ((await this.ctx.storage.get('count') as number) ?? 0) + 1
				await this.ctx.storage.put('count', count)
				return count
			}
		}

		t = await createTestEnv({
			worker: { Counter } as any,
			bindings: { COUNTER: { type: 'durable-object', className: 'Counter' } },
		})

		// Same name as test A, but should start fresh
		const counter = t.durableObject('COUNTER').get('shared-name')
		expect(await counter.stub.increment()).toBe(1)
	})

	test('DO listIds is isolated', async () => {
		class Simple extends DurableObject {
			async ping(): Promise<string> {
				return 'pong'
			}
		}

		t = await createTestEnv({
			worker: { Simple } as any,
			bindings: { DO: { type: 'durable-object', className: 'Simple' } },
		})

		const ns = t.durableObject('DO')
		expect(ns.listIds()).toEqual([])

		await ns.get('instance-1').stub.ping()
		expect(ns.listIds()).toHaveLength(1)
	})

	test('DO listIds does not see previous test instances', async () => {
		class Simple extends DurableObject {
			async ping(): Promise<string> {
				return 'pong'
			}
		}

		t = await createTestEnv({
			worker: { Simple } as any,
			bindings: { DO: { type: 'durable-object', className: 'Simple' } },
		})

		const ns = t.durableObject('DO')
		// Should not see 'instance-1' from previous test
		expect(ns.listIds()).toEqual([])
	})
})

describe('test isolation — workflows', () => {
	test('workflow data is isolated — test A runs workflow', async () => {
		class WF extends WorkflowEntrypoint {
			override async run(event: { payload: { value: string } }, step: any) {
				await step.do('work', async () => event.payload.value)
				return 'done-A'
			}
		}

		t = await createTestEnv({
			worker: { WF } as any,
			bindings: { MY_WF: { type: 'workflow', className: 'WF' } },
		})

		const wf = t.workflow('MY_WF')
		const run = await wf.run({ params: { value: 'A' } })
		const result = await run.result
		expect(result.output).toBe('done-A')
	})

	test('workflow data is isolated — test B has no instances from A', async () => {
		class WF extends WorkflowEntrypoint {
			override async run(event: { payload: { value: string } }, step: any) {
				await step.do('work', async () => event.payload.value)
				return 'done-B'
			}
		}

		t = await createTestEnv({
			worker: { WF } as any,
			bindings: { MY_WF: { type: 'workflow', className: 'WF' } },
		})

		// No workflow instances should exist from previous test
		const rows = t.db.query('SELECT * FROM workflow_instances').all()
		expect(rows).toHaveLength(0)

		const wf = t.workflow('MY_WF')
		const run = await wf.run({ params: { value: 'B' } })
		const result = await run.result
		expect(result.output).toBe('done-B')
	})
})

describe('test isolation — caches', () => {
	test('cache data is isolated — test A puts entry', async () => {
		t = await createTestEnv()

		const cache = caches.default
		const req = new Request('http://example.com/cached')
		const res = new Response('cached-A', {
			headers: { 'Cache-Control': 'max-age=3600' },
		})
		await cache.put(req, res)

		const hit = await cache.match(req)
		expect(hit).not.toBeNull()
		expect(await hit!.text()).toBe('cached-A')
	})

	test('cache data is isolated — test B does not see test A entry', async () => {
		t = await createTestEnv()

		const cache = caches.default
		const req = new Request('http://example.com/cached')
		const hit = await cache.match(req)
		// Should not see cached entry from previous test
		expect(hit).toBeUndefined()
	})

	test('caches throws after dispose', async () => {
		t = await createTestEnv()
		t.dispose()
		t = null

		expect(() => caches).toThrow('caches is not available')
	})
})

describe('test isolation — env object identity', () => {
	test('import { env } returns same object reference across imports', async () => {
		t = await createTestEnv({
			vars: { X: '1' },
		})

		const mod1 = await import('cloudflare:workers')
		const mod2 = await import('cloudflare:workers')

		// Same reference — mutations are visible everywhere
		expect(mod1.env).toBe(mod2.env)
		expect(mod1.env.X).toBe('1')
	})

	test('env object is mutated in-place (not replaced)', async () => {
		const { env: envRef } = await import('cloudflare:workers')

		t = await createTestEnv({
			vars: { BEFORE: 'yes' },
		})

		expect(envRef.BEFORE).toBe('yes')

		t.dispose()
		t = null

		// Same object reference, but keys cleared
		expect(envRef.BEFORE).toBeUndefined()

		t = await createTestEnv({
			vars: { AFTER: 'yes' },
		})

		// Same object now has new keys
		expect(envRef.AFTER).toBe('yes')
		expect(envRef.BEFORE).toBeUndefined()
	})
})

describe('test isolation — concurrent env access from worker handler', () => {
	test('handler sees correct env', async () => {
		t = await createTestEnv({
			worker: {
				async fetch(_req: Request, env: any) {
					// Also verify via cloudflare:workers import
					const { env: importedEnv } = await import('cloudflare:workers')
					return new Response(JSON.stringify({
						handlerEnv: env.SECRET,
						importedEnv: importedEnv.SECRET,
					}))
				},
			},
			vars: { SECRET: 'correct-value' },
		})

		const res = await t.fetch('/')
		const data = await res.json() as any
		expect(data.handlerEnv).toBe('correct-value')
		expect(data.importedEnv).toBe('correct-value')
	})

	test('handler with different env sees its own value', async () => {
		t = await createTestEnv({
			worker: {
				async fetch(_req: Request, env: any) {
					const { env: importedEnv } = await import('cloudflare:workers')
					return new Response(JSON.stringify({
						handlerEnv: env.SECRET,
						importedEnv: importedEnv.SECRET,
					}))
				},
			},
			vars: { SECRET: 'different-value' },
		})

		const res = await t.fetch('/')
		const data = await res.json() as any
		expect(data.handlerEnv).toBe('different-value')
		expect(data.importedEnv).toBe('different-value')
	})
})
