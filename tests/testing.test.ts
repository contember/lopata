import { afterEach, describe, expect, test } from 'bun:test'
import { DurableObject, WorkflowEntrypoint } from 'cloudflare:workers'
import type { TestEnv } from '../src/testing'
import { createTestEnv } from '../src/testing'

let t: TestEnv | null = null

afterEach(() => {
	t?.dispose()
	t = null
})

describe('createTestEnv', () => {
	test('basic fetch handler', async () => {
		t = await createTestEnv({
			worker: {
				fetch() {
					return new Response('hello from test worker')
				},
			},
		})

		const res = await t.fetch('/test')
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('hello from test worker')
	})

	test('fetch normalizes relative URLs', async () => {
		t = await createTestEnv({
			worker: {
				fetch(req) {
					return new Response(new URL(req.url).pathname)
				},
			},
		})

		const res = await t.fetch('/api/hello')
		expect(await res.text()).toBe('/api/hello')
	})

	test('fetch passes full URL', async () => {
		t = await createTestEnv({
			worker: {
				fetch(req) {
					return new Response(req.url)
				},
			},
		})

		const res = await t.fetch('http://example.com/api')
		expect(await res.text()).toBe('http://example.com/api')
	})

	test('fetch with Request object', async () => {
		t = await createTestEnv({
			worker: {
				async fetch(req) {
					const body = await req.text()
					return new Response(`method=${req.method} body=${body}`)
				},
			},
		})

		const res = await t.fetch(new Request('http://localhost/test', { method: 'POST', body: 'data' }))
		expect(await res.text()).toBe('method=POST body=data')
	})

	test('fetch with KV binding', async () => {
		t = await createTestEnv({
			worker: {
				async fetch(req, env: any) {
					const url = new URL(req.url)
					if (req.method === 'GET') {
						const value = await env.KV.get(url.pathname)
						return new Response(value ?? 'not found', { status: value ? 200 : 404 })
					}
					return new Response('bad method', { status: 405 })
				},
			},
			bindings: { KV: 'kv' },
		})

		// Put via binding, read via handler
		await (t.env.KV as any).put('/hello', 'world')
		const res = await t.fetch('/hello')
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('world')

		const res2 = await t.fetch('/missing')
		expect(res2.status).toBe(404)
	})

	test('vars are available in env', async () => {
		t = await createTestEnv({
			worker: {
				fetch(_req, env: any) {
					return new Response(`secret=${env.API_KEY}`)
				},
			},
			vars: { API_KEY: 'test-key-123' },
		})

		const res = await t.fetch('/')
		expect(await res.text()).toBe('secret=test-key-123')
	})

	test('queue handler dispatch', async () => {
		const received: unknown[] = []
		t = await createTestEnv({
			worker: {
				async queue(batch: any) {
					for (const msg of batch.messages) {
						received.push(msg.body)
					}
				},
			},
		})

		await t.queue('my-queue', [
			{ body: { action: 'send-email' } },
			{ body: { action: 'process' } },
		])

		expect(received).toEqual([
			{ action: 'send-email' },
			{ action: 'process' },
		])
	})

	test('queue handler receives queue name', async () => {
		let queueName = ''
		t = await createTestEnv({
			worker: {
				async queue(batch: any) {
					queueName = batch.queue
				},
			},
		})

		await t.queue('notifications', [{ body: 'test' }])
		expect(queueName).toBe('notifications')
	})

	test('scheduled handler dispatch', async () => {
		let lastCron = ''
		let lastTime = 0
		t = await createTestEnv({
			worker: {
				async scheduled(controller: any) {
					lastCron = controller.cron
					lastTime = controller.scheduledTime
				},
			},
		})

		const now = Date.now()
		await t.scheduled({ cron: '0 * * * *', scheduledTime: now })
		expect(lastCron).toBe('0 * * * *')
		expect(lastTime).toBe(now)
	})

	test('scheduled handler with defaults', async () => {
		let called = false
		t = await createTestEnv({
			worker: {
				async scheduled() {
					called = true
				},
			},
		})

		await t.scheduled()
		expect(called).toBe(true)
	})

	test('email handler dispatch', async () => {
		let emailFrom = ''
		let emailTo = ''
		t = await createTestEnv({
			worker: {
				async email(message: any) {
					emailFrom = message.from
					emailTo = message.to
				},
			},
		})

		await t.email({
			from: 'sender@example.com',
			to: 'receiver@example.com',
			raw: 'From: sender@example.com\r\nTo: receiver@example.com\r\nSubject: Test\r\n\r\nHello',
		})

		expect(emailFrom).toBe('sender@example.com')
		expect(emailTo).toBe('receiver@example.com')
	})

	test('durable object via createTestEnv', async () => {
		class Counter extends DurableObject {
			async increment(): Promise<number> {
				const count = ((await this.ctx.storage.get('count')) ?? 0) + 1
				await this.ctx.storage.put('count', count)
				return count
			}
		}

		t = await createTestEnv({
			worker: {
				async fetch(req: Request, env: any) {
					const id = env.COUNTER.idFromName('default')
					const stub = env.COUNTER.get(id) as any
					const count = await stub.increment()
					return new Response(`count=${count}`)
				},
				Counter,
			} as any,
			bindings: {
				COUNTER: { type: 'durable-object', className: 'Counter' },
			},
		})

		// Attach the class export to the worker module
		// The worker module needs to export Counter for wiring
		const res1 = await t.fetch('/')
		expect(await res1.text()).toBe('count=1')

		const res2 = await t.fetch('/')
		expect(await res2.text()).toBe('count=2')
	})

	test('D1 binding', async () => {
		t = await createTestEnv({
			worker: {
				async fetch(req, env: any) {
					const db = env.DB
					await db.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)')
					await db.prepare('INSERT INTO users (name) VALUES (?)').bind('Alice').run()
					const result = await db.prepare('SELECT name FROM users').first()
					return new Response(result.name)
				},
			},
			bindings: { DB: 'd1' },
		})

		const res = await t.fetch('/')
		expect(await res.text()).toBe('Alice')
	})

	test('queue producer binding', async () => {
		t = await createTestEnv({
			bindings: { QUEUE: 'queue' },
		})

		const queue = t.env.QUEUE as any
		await queue.send({ action: 'test' })

		// Verify message was persisted to DB
		const row = t.db.query("SELECT * FROM queue_messages WHERE queue = 'QUEUE'").get() as any
		expect(row).not.toBeNull()
	})

	test('R2 binding', async () => {
		t = await createTestEnv({
			bindings: { BUCKET: 'r2' },
		})

		const bucket = t.env.BUCKET as any
		await bucket.put('test.txt', 'file contents')
		const obj = await bucket.get('test.txt')
		expect(await obj.text()).toBe('file contents')
	})

	test('dispose cleans up resources', async () => {
		t = await createTestEnv({
			bindings: { KV: 'kv' },
		})

		await (t.env.KV as any).put('key', 'value')
		t.dispose()

		// DB should be closed — any query should throw
		expect(() => t!.db.query('SELECT 1').get()).toThrow()
		t = null // prevent double-dispose in afterEach
	})

	test('throws when handler is missing', async () => {
		t = await createTestEnv({
			worker: {
				fetch() {
					return new Response('ok')
				},
			},
		})

		expect(t.queue('q', [{ body: 'x' }])).rejects.toThrow('No queue handler found')
		expect(t.scheduled()).rejects.toThrow('No scheduled handler found')
		expect(t.email({ from: 'a@b.c', to: 'd@e.f', raw: 'test' })).rejects.toThrow('No email handler found')
	})

	test('no .lopata directory created', async () => {
		const fs = await import('node:fs')
		const path = await import('node:path')
		const lopataDir = path.join(process.cwd(), '.lopata')

		// Record if it exists before test
		const existedBefore = fs.existsSync(lopataDir)

		t = await createTestEnv({
			worker: {
				fetch() {
					return new Response('ok')
				},
			},
			bindings: { KV: 'kv' },
		})

		await t.fetch('/')

		if (!existedBefore) {
			expect(fs.existsSync(lopataDir)).toBe(false)
		}
	})

	test('workflow end-to-end', async () => {
		class MyWorkflow extends WorkflowEntrypoint {
			override async run(
				event: { payload: { input: string } },
				step: { do: <T>(name: string, cb: () => Promise<T>) => Promise<T> },
			): Promise<unknown> {
				const result = await step.do('process', async () => {
					return { doubled: event.payload.input + event.payload.input }
				})
				return result
			}
		}

		t = await createTestEnv({
			worker: {
				async fetch(req: Request, env: any) {
					const instance = await env.MY_WORKFLOW.create({ params: { input: 'abc' } })
					// Poll for completion
					for (let i = 0; i < 20; i++) {
						const s = await instance.status()
						if (s.status === 'complete') {
							return new Response(JSON.stringify(s.output))
						}
						if (s.status === 'errored') {
							return new Response(s.error, { status: 500 })
						}
						await new Promise(r => setTimeout(r, 50))
					}
					return new Response('timeout', { status: 408 })
				},
				MyWorkflow,
			} as any,
			bindings: {
				MY_WORKFLOW: { type: 'workflow', className: 'MyWorkflow' },
			},
		})

		const res = await t.fetch('/')
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ doubled: 'abcabc' })
	})

	test('service binding — self-referencing fetch', async () => {
		t = await createTestEnv({
			worker: {
				async fetch(req: Request, env: any) {
					const url = new URL(req.url)
					if (url.pathname === '/internal') {
						return new Response('internal response')
					}
					// Call self via service binding
					const res = await env.SELF.fetch(new Request('http://fake/internal'))
					const text = await res.text()
					return new Response(`proxied: ${text}`)
				},
			},
			bindings: {
				SELF: { type: 'service', service: 'self' },
			},
		})

		const res = await t.fetch('/proxy')
		expect(await res.text()).toBe('proxied: internal response')
	})

	test('class-based worker (WorkerModule)', async () => {
		class MyWorker {
			private env: any
			constructor(_ctx: unknown, env: unknown) {
				this.env = env
			}
			async fetch(request: Request): Promise<Response> {
				return new Response(`class-based: key=${this.env.MY_KEY}`)
			}
		}
		// Prototype.fetch exists → detected as class-based
		t = await createTestEnv({
			worker: { default: MyWorker } as any,
			vars: { MY_KEY: 'hello' },
		})

		const res = await t.fetch('/')
		expect(await res.text()).toBe('class-based: key=hello')
	})

	test('class-based worker with DO binding (WorkerModule)', async () => {
		class Counter extends DurableObject {
			async increment(): Promise<number> {
				const count = ((await this.ctx.storage.get('count')) ?? 0) + 1
				await this.ctx.storage.put('count', count)
				return count
			}
		}

		class MyWorker {
			private env: any
			constructor(_ctx: unknown, env: unknown) {
				this.env = env
			}
			async fetch(request: Request): Promise<Response> {
				const id = this.env.COUNTER.idFromName('default')
				const stub = this.env.COUNTER.get(id) as any
				const count = await stub.increment()
				return new Response(`count=${count}`)
			}
		}

		t = await createTestEnv({
			worker: { default: MyWorker, Counter } as any,
			bindings: {
				COUNTER: { type: 'durable-object', className: 'Counter' },
			},
		})

		const res = await t.fetch('/')
		expect(await res.text()).toBe('count=1')
	})

	test('wrangler config loading', async () => {
		const fs = await import('node:fs')
		const path = await import('node:path')
		const os = await import('node:os')

		// Create a temp wrangler.toml
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lopata-wrangler-test-'))
		const wranglerPath = path.join(tmpDir, 'wrangler.toml')
		fs.writeFileSync(
			wranglerPath,
			`
name = "test-worker"
main = "src/index.ts"

[vars]
API_KEY = "from-wrangler"

[[kv_namespaces]]
binding = "KV"
id = "abc123"
`,
		)

		try {
			t = await createTestEnv({
				worker: {
					async fetch(req: Request, env: any) {
						await env.KV.put('test', 'value')
						const val = await env.KV.get('test')
						return new Response(`key=${env.API_KEY} kv=${val}`)
					},
				},
				wrangler: wranglerPath,
			})

			const res = await t.fetch('/')
			expect(await res.text()).toBe('key=from-wrangler kv=value')
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true })
		}
	})

	test('durable object with SQL storage via createTestEnv', async () => {
		class SqlDO extends DurableObject {
			async createTable() {
				this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS items (key TEXT PRIMARY KEY, val INTEGER)')
			}
			async setItem(key: string, val: number) {
				this.ctx.storage.sql.exec('INSERT OR REPLACE INTO items VALUES (?, ?)', key, val)
			}
			async getItem(key: string): Promise<number | null> {
				const rows = this.ctx.storage.sql.exec('SELECT val FROM items WHERE key = ?', key).toArray()
				return rows.length > 0 ? (rows[0]!.val as number) : null
			}
		}

		t = await createTestEnv({
			worker: {
				async fetch(req: Request, env: any) {
					const id = env.DO.idFromName('default')
					const stub = env.DO.get(id) as any
					await stub.createTable()
					await stub.setItem('score', 99)
					const val = await stub.getItem('score')
					return new Response(`val=${val}`)
				},
				SqlDO,
			} as any,
			bindings: {
				DO: { type: 'durable-object', className: 'SqlDO' },
			},
		})

		const res = await t.fetch('/')
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('val=99')
	})

	test('import { env } from cloudflare:workers reflects test env', async () => {
		t = await createTestEnv({
			vars: { MY_VAR: 'test-value' },
		})

		const { env } = await import('cloudflare:workers')
		expect(env.MY_VAR).toBe('test-value')
	})

	test('env is cleared after dispose', async () => {
		t = await createTestEnv({
			vars: { TEMP_KEY: 'exists' },
		})

		const { env } = await import('cloudflare:workers')
		expect(env.TEMP_KEY).toBe('exists')

		t.dispose()
		t = null

		expect(env.TEMP_KEY).toBeUndefined()
	})

	test('caches uses in-memory storage', async () => {
		t = await createTestEnv()

		const cache = caches.default
		const req = new Request('http://example.com/test')
		const res = new Response('cached body', {
			headers: { 'Cache-Control': 'max-age=3600' },
		})

		await cache.put(req, res)
		const hit = await cache.match(req)
		expect(hit).not.toBeNull()
		expect(await hit!.text()).toBe('cached body')
	})

	test('caches throws before createTestEnv', async () => {
		// After dispose, caches ref is null → should throw
		const prev = t
		t = await createTestEnv()
		t.dispose()
		t = null

		expect(() => caches).toThrow('caches is not available')
	})

	test('workflow().run() with auto-sleep-skip', async () => {
		class SleepyWorkflow extends WorkflowEntrypoint {
			override async run(event: { payload: { input: string } }, step: any) {
				const result = await step.do('process', async () => {
					return event.payload.input.toUpperCase()
				})
				await step.sleep('pause', '10 minutes')
				await step.do('finalize', async () => {
					return { done: true, value: result }
				})
				return { output: result }
			}
		}

		t = await createTestEnv({
			worker: { SleepyWorkflow } as any,
			bindings: { WF: { type: 'workflow', className: 'SleepyWorkflow' } },
		})

		const wf = t.workflow('WF')
		const run = await wf.run({ params: { input: 'hello' } })
		const final = await run.result
		expect(final.status).toBe('complete')
		expect(final.output).toEqual({ output: 'HELLO' })
	})

	test('workflow().create() + waitForStatus()', async () => {
		class SimpleWorkflow extends WorkflowEntrypoint {
			override async run(event: { payload: { input: string } }, step: any) {
				await step.do('work', async () => event.payload.input)
				return 'done'
			}
		}

		t = await createTestEnv({
			worker: { SimpleWorkflow } as any,
			bindings: { WF: { type: 'workflow', className: 'SimpleWorkflow' } },
		})

		const wf = t.workflow('WF')
		const instance = await wf.create({ params: { input: 'test' } })
		const result = await instance.waitForStatus('complete')
		expect(result.status).toBe('complete')
		expect(result.output).toBe('done')
	})

	test('workflow().create() + waitForStep()', async () => {
		class StepWorkflow extends WorkflowEntrypoint {
			override async run(event: { payload: { input: string } }, step: any) {
				const r1 = await step.do('first', async () => ({ a: 1 }))
				await step.sleep('delay', '1 hour')
				await step.do('second', async () => ({ b: 2 }))
				return r1
			}
		}

		t = await createTestEnv({
			worker: { StepWorkflow } as any,
			bindings: { WF: { type: 'workflow', className: 'StepWorkflow' } },
		})

		const wf = t.workflow('WF')
		const instance = await wf.create({ params: { input: 'x' } })
		const output = await instance.waitForStep('first')
		expect(output).toEqual({ a: 1 })

		// Skip sleep so workflow can continue
		await instance.skipSleep()
		const output2 = await instance.waitForStep('second')
		expect(output2).toEqual({ b: 2 })
	})

	test('workflow().create() + skipSleep() + waitForEvent() + sendEvent()', async () => {
		class EventWorkflow extends WorkflowEntrypoint {
			override async run(event: { payload: { input: string } }, step: any) {
				await step.do('init', async () => 'initialized')
				await step.sleep('wait-a-bit', '5 minutes')
				const approval = await step.waitForEvent('get-approval', {
					type: 'approve',
					timeout: '1 hour',
				})
				return { approved: approval.payload.ok }
			}
		}

		t = await createTestEnv({
			worker: { EventWorkflow } as any,
			bindings: { WF: { type: 'workflow', className: 'EventWorkflow' } },
		})

		const wf = t.workflow('WF')
		const instance = await wf.create({ params: { input: 'test' } })

		await instance.waitForStep('init')
		await instance.skipSleep()
		await instance.waitForEvent('approve')
		await instance.sendEvent({ type: 'approve', payload: { ok: true } })

		const result = await instance.waitForStatus('complete')
		expect(result.output).toEqual({ approved: true })
	})

	test('workflow().create() + steps() / stepResult()', async () => {
		class MultiStepWorkflow extends WorkflowEntrypoint {
			override async run(event: { payload: { input: string } }, step: any) {
				await step.do('step-a', async () => 'alpha')
				await step.do('step-b', async () => 'beta')
				return 'done'
			}
		}

		t = await createTestEnv({
			worker: { MultiStepWorkflow } as any,
			bindings: { WF: { type: 'workflow', className: 'MultiStepWorkflow' } },
		})

		const wf = t.workflow('WF')
		const instance = await wf.create({ params: { input: 'x' } })
		await instance.waitForStatus('complete')

		const allSteps = await instance.steps()
		expect(allSteps.get('step-a')).toBe('alpha')
		expect(allSteps.get('step-b')).toBe('beta')

		const single = await instance.stepResult('step-a')
		expect(single).toBe('alpha')
	})

	test('durableObject().get() + stub + storage.get()', async () => {
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

		const counter = t.durableObject('COUNTER').get('test')
		await counter.stub.increment()
		await counter.stub.increment()

		const count = await counter.storage.get<number>('count')
		expect(count).toBe(2)
	})

	test('durableObject().get() + storage.list()', async () => {
		class Store extends DurableObject {
			async setItems(): Promise<void> {
				await this.ctx.storage.put({ 'user:1': 'alice', 'user:2': 'bob', 'other': 'value' })
			}
		}

		t = await createTestEnv({
			worker: { Store } as any,
			bindings: { STORE: { type: 'durable-object', className: 'Store' } },
		})

		const handle = t.durableObject('STORE').get('test')
		await handle.stub.setItems()

		const all = await handle.storage.list({ prefix: 'user:' })
		expect(all.size).toBe(2)
		expect(all.get('user:1')).toBe('alice')
		expect(all.get('user:2')).toBe('bob')
	})

	test('durableObject().get() + sql.exec()', async () => {
		class SqlDO extends DurableObject {
			async setup(): Promise<void> {
				this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS items (key TEXT PRIMARY KEY, val INTEGER)')
				this.ctx.storage.sql.exec('INSERT INTO items VALUES (?, ?)', 'score', 42)
			}
		}

		t = await createTestEnv({
			worker: { SqlDO } as any,
			bindings: { DO: { type: 'durable-object', className: 'SqlDO' } },
		})

		const handle = t.durableObject('DO').get('test')
		await handle.stub.setup()

		const rows = handle.sql.exec('SELECT * FROM items').toArray()
		expect(rows).toEqual([{ key: 'score', val: 42 }])
	})

	test('durableObject().get() + alarm methods', async () => {
		class AlarmDO extends DurableObject {
			async setCountdown(): Promise<void> {
				await this.ctx.storage.setAlarm(Date.now() + 60_000)
			}
			async alarm(): Promise<void> {
				const count = ((await this.ctx.storage.get('alarms') as number) ?? 0) + 1
				await this.ctx.storage.put('alarms', count)
			}
		}

		t = await createTestEnv({
			worker: { AlarmDO } as any,
			bindings: { DO: { type: 'durable-object', className: 'AlarmDO' } },
		})

		const handle = t.durableObject('DO').get('test')
		await handle.stub.setCountdown()

		const alarm = await handle.getAlarm()
		expect(alarm).toBeGreaterThan(0)

		await handle.triggerAlarm()
		const alarms = await handle.storage.get<number>('alarms')
		expect(alarms).toBe(1)

		// Set alarm again, then cancel
		await handle.stub.setCountdown()
		await handle.cancelAlarm()
		const cancelled = await handle.getAlarm()
		expect(cancelled).toBeNull()
	})

	test('durableObject().listIds()', async () => {
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

		const ns = t.durableObject('COUNTER')
		expect(ns.listIds()).toEqual([])

		// Creating stubs triggers instance registration
		await ns.get('alice').stub.increment()
		await ns.get('bob').stub.increment()

		const ids = ns.listIds()
		expect(ids).toHaveLength(2)
	})

	test('durableObject().get() + delete()', async () => {
		class Simple extends DurableObject {
			async setValue(v: string): Promise<void> {
				await this.ctx.storage.put('val', v)
			}
		}

		t = await createTestEnv({
			worker: { Simple } as any,
			bindings: { DO: { type: 'durable-object', className: 'Simple' } },
		})

		const handle = t.durableObject('DO').get('test')
		await handle.stub.setValue('hello')
		expect(await handle.storage.get<string>('val')).toBe('hello')

		await handle.delete()

		// After delete, getting a new handle should start fresh
		const handle2 = t.durableObject('DO').get('test')
		await handle2.stub.setValue('world')
		expect(await handle2.storage.get<string>('val')).toBe('world')
	})

	test('workflow prepare() + mockStep() + start()', async () => {
		class MockableWorkflow extends WorkflowEntrypoint {
			override async run(event: { payload: { input: string } }, step: any) {
				const apiResult = await step.do('call-api', async () => {
					// This would normally make a real API call
					return { data: 'real-data' }
				})
				const processed = await step.do('process', async () => {
					return { result: apiResult.data + '-processed' }
				})
				return processed
			}
		}

		t = await createTestEnv({
			worker: { MockableWorkflow } as any,
			bindings: { WF: { type: 'workflow', className: 'MockableWorkflow' } },
		})

		const wf = t.workflow('WF')
		const instance = await wf.prepare({ params: { input: 'test' } })
		instance.mockStep('call-api', { data: 'fake-data' })
		await instance.start()

		const result = await instance.waitForStatus('complete')
		expect(result.status).toBe('complete')
		expect(result.output).toEqual({ result: 'fake-data-processed' })
	})

	test('workflow prepare() + mockStepError()', async () => {
		class ErrorWorkflow extends WorkflowEntrypoint {
			override async run(event: { payload: {} }, step: any) {
				try {
					await step.do('risky-step', { retries: { limit: 0 } }, async () => {
						return 'should not reach'
					})
				} catch (err: any) {
					return { error: err.message }
				}
			}
		}

		t = await createTestEnv({
			worker: { ErrorWorkflow } as any,
			bindings: { WF: { type: 'workflow', className: 'ErrorWorkflow' } },
		})

		const wf = t.workflow('WF')
		const instance = await wf.prepare({ params: {} })
		instance.mockStepError('risky-step', new Error('connection refused'))
		await instance.start()

		const result = await instance.waitForStatus('complete')
		expect(result.status).toBe('complete')
		expect(result.output).toEqual({ error: 'connection refused' })
	})

	test('workflow prepare() + disableSleeps()', async () => {
		class SleepWorkflow extends WorkflowEntrypoint {
			override async run(event: { payload: {} }, step: any) {
				await step.do('before', async () => 'a')
				await step.sleep('long-pause', '24 hours')
				await step.do('after', async () => 'b')
				return 'done'
			}
		}

		t = await createTestEnv({
			worker: { SleepWorkflow } as any,
			bindings: { WF: { type: 'workflow', className: 'SleepWorkflow' } },
		})

		const wf = t.workflow('WF')
		const instance = await wf.prepare({ params: {} })
		instance.disableSleeps()
		await instance.start()

		const result = await instance.waitForStatus('complete')
		expect(result.status).toBe('complete')
		expect(result.output).toBe('done')
	})

	test('workflow prepare() + mockEvent()', async () => {
		class EventWorkflow extends WorkflowEntrypoint {
			override async run(event: { payload: {} }, step: any) {
				const approval = await step.waitForEvent('get-approval', {
					type: 'approval',
					timeout: '1 hour',
				})
				return { approved: approval.payload.ok }
			}
		}

		t = await createTestEnv({
			worker: { EventWorkflow } as any,
			bindings: { WF: { type: 'workflow', className: 'EventWorkflow' } },
		})

		const wf = t.workflow('WF')
		const instance = await wf.prepare({ params: {} })
		instance.mockEvent({ type: 'approval', payload: { ok: true } })
		await instance.start()

		const result = await instance.waitForStatus('complete')
		expect(result.status).toBe('complete')
		expect(result.output).toEqual({ approved: true })
	})

	test('workflow prepare() + mockEventTimeout()', async () => {
		class TimeoutEventWorkflow extends WorkflowEntrypoint {
			override async run(event: { payload: {} }, step: any) {
				try {
					await step.waitForEvent('wait-for-data', {
						type: 'data',
						timeout: '1 hour',
					})
					return { received: true }
				} catch (err: any) {
					return { timedOut: true, message: err.message }
				}
			}
		}

		t = await createTestEnv({
			worker: { TimeoutEventWorkflow } as any,
			bindings: { WF: { type: 'workflow', className: 'TimeoutEventWorkflow' } },
		})

		const wf = t.workflow('WF')
		const instance = await wf.prepare({ params: {} })
		instance.mockEventTimeout('data')
		await instance.start()

		const result = await instance.waitForStatus('complete')
		expect(result.status).toBe('complete')
		expect(result.output).toEqual({ timedOut: true, message: 'waitForEvent timed out (mocked)' })
	})

	test('workflow run() with mocks callback', async () => {
		class FullWorkflow extends WorkflowEntrypoint {
			override async run(event: { payload: { input: string } }, step: any) {
				const apiResult = await step.do('call-api', async () => {
					return { data: 'real' }
				})
				await step.sleep('cooldown', '10 minutes')
				const approval = await step.waitForEvent('get-approval', {
					type: 'approval',
					timeout: '1 hour',
				})
				return { api: apiResult.data, approved: approval.payload.ok }
			}
		}

		t = await createTestEnv({
			worker: { FullWorkflow } as any,
			bindings: { WF: { type: 'workflow', className: 'FullWorkflow' } },
		})

		const wf = t.workflow('WF')
		const run = await wf.run({
			params: { input: 'test' },
			mocks: (m) => {
				m.mockStep('call-api', { data: 'mocked' })
				m.mockEvent({ type: 'approval', payload: { ok: true } })
			},
		})

		const result = await run.result
		expect(result.status).toBe('complete')
		expect(result.output).toEqual({ api: 'mocked', approved: true })
	})

	test('workflow prepare() + mockStepTimeout()', async () => {
		class TimeoutStepWorkflow extends WorkflowEntrypoint {
			override async run(event: { payload: {} }, step: any) {
				try {
					await step.do('slow-step', { retries: { limit: 0 } }, async () => {
						return 'should not reach'
					})
				} catch (err: any) {
					return { timedOut: true, message: err.message }
				}
			}
		}

		t = await createTestEnv({
			worker: { TimeoutStepWorkflow } as any,
			bindings: { WF: { type: 'workflow', className: 'TimeoutStepWorkflow' } },
		})

		const wf = t.workflow('WF')
		const instance = await wf.prepare({ params: {} })
		instance.mockStepTimeout('slow-step')
		await instance.start()

		const result = await instance.waitForStatus('complete')
		expect(result.status).toBe('complete')
		expect(result.output).toEqual({ timedOut: true, message: 'Step "slow-step" timed out (mocked)' })
	})

	test('wrangler config — explicit bindings/vars override', async () => {
		const fs = await import('node:fs')
		const path = await import('node:path')
		const os = await import('node:os')

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lopata-wrangler-test-'))
		const wranglerPath = path.join(tmpDir, 'wrangler.toml')
		fs.writeFileSync(
			wranglerPath,
			`
name = "test-worker"
main = "src/index.ts"

[vars]
API_KEY = "from-wrangler"
OTHER = "from-wrangler"
`,
		)

		try {
			t = await createTestEnv({
				worker: {
					fetch(_req: Request, env: any) {
						return new Response(`key=${env.API_KEY} other=${env.OTHER}`)
					},
				},
				wrangler: wranglerPath,
				vars: { API_KEY: 'overridden' },
			})

			const res = await t.fetch('/')
			expect(await res.text()).toBe('key=overridden other=from-wrangler')
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true })
		}
	})
})
