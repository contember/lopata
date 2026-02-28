import { afterEach, describe, expect, test } from 'bun:test'
import type { TestEnv } from '../../../src/testing'
import { createTestEnv } from '../../../src/testing'

let t: TestEnv<Env> | null = null

afterEach(() => {
	t?.dispose()
	t = null
})

async function setup() {
	t = await createTestEnv<Env>({
		worker: './examples/playground/src/index.ts',
		wrangler: './examples/playground/wrangler.jsonc',
	})
	return t
}

// ── Direct binding tests ──────────────────────────────────────────────

describe('playground bindings — KV', () => {
	test('put, get, delete', async () => {
		const t = await setup()

		await t.env.KV.put('key1', 'value1')
		expect(await t.env.KV.get('key1')).toBe('value1')

		await t.env.KV.delete('key1')
		expect(await t.env.KV.get('key1')).toBeNull()
	})

	test('list keys', async () => {
		const t = await setup()

		await t.env.KV.put('a', '1')
		await t.env.KV.put('b', '2')
		await t.env.KV.put('c', '3')

		const list = await t.env.KV.list()
		const names = list.keys.map(k => k.name)
		expect(names).toContain('a')
		expect(names).toContain('b')
		expect(names).toContain('c')
	})

	test('put with metadata', async () => {
		const t = await setup()

		await t.env.KV.put('meta-key', 'val', { metadata: { tag: 'test' } })
		const { value, metadata } = await t.env.KV.getWithMetadata('meta-key')
		expect(value).toBe('val')
		expect(metadata).toEqual({ tag: 'test' })
	})
})

describe('playground bindings — R2', () => {
	test('put, get, delete', async () => {
		const t = await setup()

		await t.env.R2.put('doc.txt', 'hello R2')
		const obj = await t.env.R2.get('doc.txt')
		expect(await obj!.text()).toBe('hello R2')

		await t.env.R2.delete('doc.txt')
		expect(await t.env.R2.get('doc.txt')).toBeNull()
	})

	test('list objects', async () => {
		const t = await setup()

		await t.env.R2.put('f1.txt', 'a')
		await t.env.R2.put('f2.txt', 'b')

		const list = await t.env.R2.list()
		const keys = list.objects.map(o => o.key)
		expect(keys).toContain('f1.txt')
		expect(keys).toContain('f2.txt')
	})
})

describe('playground bindings — D1', () => {
	test('exec, prepare, first', async () => {
		const t = await setup()

		await t.env.DB.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)')
		await t.env.DB.prepare('INSERT INTO items (name) VALUES (?)').bind('Widget').run()

		const row = await t.env.DB.prepare('SELECT name FROM items WHERE id = 1').first()
		expect(row!.name).toBe('Widget')
	})

	test('batch queries', async () => {
		const t = await setup()

		await t.env.DB.exec('CREATE TABLE nums (n INTEGER)')
		const results = await t.env.DB.batch([
			t.env.DB.prepare('INSERT INTO nums (n) VALUES (?)').bind(1),
			t.env.DB.prepare('INSERT INTO nums (n) VALUES (?)').bind(2),
			t.env.DB.prepare('SELECT COUNT(*) as cnt FROM nums'),
		])
		expect((results[2].results[0] as any).cnt).toBe(2)
	})
})

describe('playground bindings — Counter DO (direct RPC)', () => {
	test('increment, getCount, reset via stub', async () => {
		const t = await setup()
		const counter = t.durableObject('COUNTER').get('direct-test')

		expect(await counter.stub.getCount()).toBe(0)
		expect(await counter.stub.increment()).toBe(1)
		expect(await counter.stub.increment()).toBe(2)
		expect(await counter.stub.decrement()).toBe(1)

		await counter.stub.reset()
		expect(await counter.stub.getCount()).toBe(0)
	})

	test('different names are isolated', async () => {
		const t = await setup()
		const ns = t.durableObject('COUNTER')

		const a = ns.get('x')
		const b = ns.get('y')

		await a.stub.increment()
		await a.stub.increment()
		await b.stub.increment()

		expect(await a.storage.get('count')).toBe(2)
		expect(await b.storage.get('count')).toBe(1)
	})
})

describe('playground bindings — SqlNotes DO (direct RPC)', () => {
	test('create, list, get, remove', async () => {
		const t = await setup()
		const handle = t.durableObject('SQL_NOTES').get('test-notebook')

		const note = await handle.stub.create('My Title', 'My Body')
		expect(note.title).toBe('My Title')
		expect(note.body).toBe('My Body')
		expect(note.id).toBeDefined()

		const notes = await handle.stub.list()
		expect(notes).toHaveLength(1)

		const fetched = await handle.stub.get(note.id)
		expect(fetched.title).toBe('My Title')

		await handle.stub.remove(note.id)
		const after = await handle.stub.list()
		expect(after).toHaveLength(0)
	})

	test('update note', async () => {
		const t = await setup()
		const handle = t.durableObject('SQL_NOTES').get('update-test')
		const note = await handle.stub.create('Original', 'old body')

		const updated = await handle.stub.update(note.id, 'Updated', 'new body')
		expect(updated.title).toBe('Updated')
		expect(updated.body).toBe('new body')
	})
})

describe('playground bindings — Queue', () => {
	test('send via binding, verify in DB', async () => {
		const t = await setup()

		await t.env.MY_QUEUE.send({ action: 'do-something' })

		const row = t.db.query("SELECT * FROM queue_messages WHERE queue = 'MY_QUEUE'").get() as any
		expect(row).not.toBeNull()
	})

	test('sendBatch', async () => {
		const t = await setup()

		await t.env.MY_QUEUE.sendBatch([
			{ body: { n: 1 } },
			{ body: { n: 2 } },
		])

		const rows = t.db.query("SELECT * FROM queue_messages WHERE queue = 'MY_QUEUE'").all()
		expect(rows).toHaveLength(2)
	})
})

describe('playground bindings — Workflow (direct)', () => {
	test('create, wait for event, approve, complete', async () => {
		const t = await setup()
		const wf = t.workflow('MY_WORKFLOW')

		const instance = await wf.create({ params: { input: 'direct-test' } })
		expect(instance.id).toBeDefined()

		await instance.waitForEvent('approval')
		await instance.sendEvent({ type: 'approval', payload: { approved: true } })

		const result = await instance.waitForStatus('complete')
		expect(result.status).toBe('complete')
	})
})

// ── Fetch handler tests ───────────────────────────────────────────────

describe('playground fetch — KV routes', () => {
	test('PUT and GET a key', async () => {
		const t = await setup()
		const put = await t.fetch(new Request('http://localhost/kv/hello', { method: 'PUT', body: 'world' }))
		expect(put.status).toBe(201)

		const get = await t.fetch('/kv/hello')
		expect(get.status).toBe(200)
		expect(await get.text()).toBe('world')
	})

	test('GET missing key returns 404', async () => {
		const t = await setup()
		const res = await t.fetch('/kv/nonexistent')
		expect(res.status).toBe(404)
	})

	test('DELETE a key', async () => {
		const t = await setup()
		await t.fetch(new Request('http://localhost/kv/to-delete', { method: 'PUT', body: 'tmp' }))
		const del = await t.fetch(new Request('http://localhost/kv/to-delete', { method: 'DELETE' }))
		expect(del.status).toBe(200)

		const get = await t.fetch('/kv/to-delete')
		expect(get.status).toBe(404)
	})

	test('list keys', async () => {
		const t = await setup()
		await t.fetch(new Request('http://localhost/kv/a', { method: 'PUT', body: '1' }))
		await t.fetch(new Request('http://localhost/kv/b', { method: 'PUT', body: '2' }))

		const res = await t.fetch('/kv')
		const data = await res.json() as any
		const keys = data.keys.map((k: any) => k.name)
		expect(keys).toContain('a')
		expect(keys).toContain('b')
	})
})

describe('playground fetch — R2 routes', () => {
	test('PUT and GET an object', async () => {
		const t = await setup()
		const put = await t.fetch(new Request('http://localhost/r2/file.txt', { method: 'PUT', body: 'R2 content' }))
		expect(put.status).toBe(201)

		const get = await t.fetch('/r2/file.txt')
		expect(get.status).toBe(200)
		expect(await get.text()).toBe('R2 content')
	})

	test('GET missing object returns 404', async () => {
		const t = await setup()
		const res = await t.fetch('/r2/missing')
		expect(res.status).toBe(404)
	})

	test('DELETE an object', async () => {
		const t = await setup()
		await t.fetch(new Request('http://localhost/r2/tmp.txt', { method: 'PUT', body: 'data' }))
		const del = await t.fetch(new Request('http://localhost/r2/tmp.txt', { method: 'DELETE' }))
		expect(del.status).toBe(200)

		const get = await t.fetch('/r2/tmp.txt')
		expect(get.status).toBe(404)
	})

	test('list objects', async () => {
		const t = await setup()
		await t.fetch(new Request('http://localhost/r2/x.txt', { method: 'PUT', body: 'x' }))
		await t.fetch(new Request('http://localhost/r2/y.txt', { method: 'PUT', body: 'y' }))

		const res = await t.fetch('/r2')
		const data = await res.json() as any
		const keys = data.objects.map((o: any) => o.key)
		expect(keys).toContain('x.txt')
		expect(keys).toContain('y.txt')
	})
})

describe('playground fetch — D1 routes', () => {
	test('exec and query', async () => {
		const t = await setup()

		const exec = await t.fetch(
			new Request('http://localhost/d1/exec', {
				method: 'POST',
				body: JSON.stringify({ sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)' }),
				headers: { 'Content-Type': 'application/json' },
			}),
		)
		expect(exec.status).toBe(200)

		await t.fetch(
			new Request('http://localhost/d1/query', {
				method: 'POST',
				body: JSON.stringify({ sql: 'INSERT INTO users (name) VALUES (?)', params: ['Alice'] }),
				headers: { 'Content-Type': 'application/json' },
			}),
		)

		const query = await t.fetch('/d1/query?sql=' + encodeURIComponent('SELECT name FROM users'))
		const data = await query.json() as any
		expect(data.results).toEqual([{ name: 'Alice' }])
	})

	test('seed sample data', async () => {
		const t = await setup()

		const seed = await t.fetch(new Request('http://localhost/d1/seed', { method: 'POST' }))
		expect(seed.status).toBe(200)

		const products = await t.fetch('/d1/query?sql=' + encodeURIComponent('SELECT COUNT(*) as cnt FROM products'))
		const data = await products.json() as any
		expect(data.results[0].cnt).toBeGreaterThan(0)
	})
})

describe('playground fetch — Counter DO', () => {
	test('increment and get', async () => {
		const t = await setup()

		const inc1 = await t.fetch(new Request('http://localhost/counter/test/increment', { method: 'POST' }))
		expect((await inc1.json() as any).count).toBe(1)

		const inc2 = await t.fetch(new Request('http://localhost/counter/test/increment', { method: 'POST' }))
		expect((await inc2.json() as any).count).toBe(2)

		const get = await t.fetch('/counter/test')
		const data = await get.json() as any
		expect(data).toEqual({ name: 'test', count: 2 })
	})

	test('reset', async () => {
		const t = await setup()
		await t.fetch(new Request('http://localhost/counter/r/increment', { method: 'POST' }))

		const reset = await t.fetch(new Request('http://localhost/counter/r/reset', { method: 'POST' }))
		expect((await reset.json() as any).count).toBe(0)
	})
})

describe('playground fetch — SqlNotes DO', () => {
	test('create, list, get, delete', async () => {
		const t = await setup()

		const create = await t.fetch(
			new Request('http://localhost/notes/nb', {
				method: 'POST',
				body: JSON.stringify({ title: 'Note 1', body: 'Body 1' }),
				headers: { 'Content-Type': 'application/json' },
			}),
		)
		expect(create.status).toBe(201)
		const note = await create.json() as any

		const list = await t.fetch('/notes/nb')
		expect((await list.json() as any).notes).toHaveLength(1)

		const get = await t.fetch(`/notes/nb/${note.id}`)
		expect((await get.json() as any).title).toBe('Note 1')

		const del = await t.fetch(new Request(`http://localhost/notes/nb/${note.id}`, { method: 'DELETE' }))
		expect((await del.json() as any).deleted).toBe(note.id)
	})
})

describe('playground fetch — Queue', () => {
	test('send and send-batch', async () => {
		const t = await setup()

		const send = await t.fetch(
			new Request('http://localhost/queue/send', {
				method: 'POST',
				body: JSON.stringify({ event: 'test' }),
				headers: { 'Content-Type': 'application/json' },
			}),
		)
		expect(send.status).toBe(201)

		const batch = await t.fetch(
			new Request('http://localhost/queue/send-batch', {
				method: 'POST',
				body: JSON.stringify([{ body: { n: 1 } }, { body: { n: 2 } }]),
				headers: { 'Content-Type': 'application/json' },
			}),
		)
		expect((await batch.json() as any).count).toBe(2)
	})
})

describe('playground fetch — Workflow', () => {
	test('create, approve, complete', async () => {
		const t = await setup()
		const wf = t.workflow('MY_WORKFLOW')

		const instance = await wf.create({ params: { input: 'hello' } })
		await instance.waitForEvent('approval')
		await instance.sendEvent({ type: 'approval', payload: { approved: true } })

		const result = await instance.waitForStatus('complete')
		expect(result.status).toBe('complete')
	})

	test('rejection path', async () => {
		const t = await setup()
		const wf = t.workflow('MY_WORKFLOW')

		const instance = await wf.create({ params: { input: 'reject-me' } })
		await instance.waitForEvent('approval')
		await instance.sendEvent({ type: 'approval', payload: { approved: false } })

		const result = await instance.waitForStatus('complete')
		expect(result.output).toEqual({ status: 'rejected', input: 'REJECT-ME' })
	})
})

describe('playground — handlers', () => {
	test('queue consumer handler', async () => {
		const t = await setup()
		await t.queue('my-queue', [
			{ body: { action: 'first' } },
			{ body: { action: 'second' } },
		])
	})

	test('scheduled handler', async () => {
		const t = await setup()
		await t.scheduled({ cron: '*/5 * * * *' })
	})
})

describe('playground — misc', () => {
	test('GET / returns HTML', async () => {
		const t = await setup()
		const res = await t.fetch('/')
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toContain('text/html')
		expect(await res.text()).toContain('Lopata Playground')
	})

	test('unknown route returns 404', async () => {
		const t = await setup()
		const res = await t.fetch('/unknown/route')
		expect(res.status).toBe(404)
	})
})
