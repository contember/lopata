import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { AiSearchInstance, AiSearchNamespaceBinding } from '../src/bindings/ai-search'
import { runMigrations } from '../src/db'

let db: Database
let originalFetch: typeof fetch
let calls: { url: string; method: string; body: string | null }[]

beforeEach(() => {
	db = new Database(':memory:')
	runMigrations(db)
	calls = []
	originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString()
		const method = init?.method ?? 'GET'
		const body = typeof init?.body === 'string' ? init.body : null
		calls.push({ url, method, body })
		return new Response(JSON.stringify({ success: true, result: { id: 'inst-1', echo: body } }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	}) as unknown as typeof fetch
})

afterEach(() => {
	globalThis.fetch = originalFetch
	db.close()
})

describe('AiSearchNamespaceBinding', () => {
	test('missing credentials throws', async () => {
		const binding = new AiSearchNamespaceBinding(db, 'my-ns')
		await expect(binding.list()).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID/)
	})

	test('create returns an AiSearchInstance handle', async () => {
		const binding = new AiSearchNamespaceBinding(db, 'my-ns', 'acc', 'tok')
		const inst = await binding.create({ id: 'inst-1' })
		expect(inst).toBeInstanceOf(AiSearchInstance)
		expect(inst.id).toBe('inst-1')
		expect(calls).toHaveLength(1)
		expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc/ai-search/instances')
		expect(calls[0]!.method).toBe('POST')
		expect(calls[0]!.body).toBe('{"id":"inst-1"}')
	})

	test('delete calls DELETE on the correct URL', async () => {
		const binding = new AiSearchNamespaceBinding(db, 'my-ns', 'acc', 'tok')
		await binding.delete('inst-1')
		expect(calls[0]!.method).toBe('DELETE')
		expect(calls[0]!.url).toContain('/ai-search/instances/inst-1')
	})

	test('namespace search hits namespace-level endpoint', async () => {
		const binding = new AiSearchNamespaceBinding(db, 'my-ns', 'acc', 'tok')
		await binding.search({ messages: [{ role: 'user', content: 'hi' }] })
		expect(calls[0]!.url).toContain('/ai-search/namespaces/my-ns/search')
		expect(calls[0]!.method).toBe('POST')
	})

	test('get is synchronous and makes no request', () => {
		const binding = new AiSearchNamespaceBinding(db, 'my-ns', 'acc', 'tok')
		const inst = binding.get('inst-1')
		expect(inst).toBeInstanceOf(AiSearchInstance)
		expect(inst.id).toBe('inst-1')
		expect(calls).toHaveLength(0)
	})

	test('instance.search hits instance-level endpoint', async () => {
		const binding = new AiSearchNamespaceBinding(db, 'my-ns', 'acc', 'tok')
		await binding.get('inst-1').search({ messages: [{ role: 'user', content: 'hi' }] })
		expect(calls).toHaveLength(1)
		expect(calls[0]!.url).toContain('/ai-search/instances/inst-1/search')
	})

	test('search results are unwrapped from the REST envelope', async () => {
		const payload = { search_query: 'hi', chunks: [{ id: 'c1', text: 'hello' }] }
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ success: true, errors: [], messages: [], result: payload }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})) as unknown as typeof fetch
		const binding = new AiSearchNamespaceBinding(db, 'my-ns', 'acc', 'tok')
		expect(await binding.get('inst-1').search({ messages: [{ role: 'user', content: 'hi' }] })).toEqual(payload)
		expect(await binding.get('inst-1').chatCompletions({ messages: [{ role: 'user', content: 'hi' }] })).toEqual(payload)
		expect(await binding.search({ messages: [{ role: 'user', content: 'hi' }] })).toEqual(payload)
		expect(await binding.chatCompletions({ messages: [{ role: 'user', content: 'hi' }] })).toEqual(payload)
	})

	test('a 200 envelope with success: false rejects', async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ success: false, errors: [{ code: 7001, message: 'bad query' }], result: null }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})) as unknown as typeof fetch
		const binding = new AiSearchNamespaceBinding(db, 'my-ns', 'acc', 'tok')
		await expect(binding.get('inst-1').search({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/bad query/)
		const row = db.query('SELECT status FROM ai_search_requests').get() as { status: string }
		expect(row.status).toBe('error')
	})

	test('list keeps the pagination info', async () => {
		const resultInfo = { count: 1, page: 1, per_page: 20, total_count: 1 }
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ success: true, errors: [], result: [{ id: 'inst-1' }], result_info: resultInfo }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})) as unknown as typeof fetch
		const binding = new AiSearchNamespaceBinding(db, 'my-ns', 'acc', 'tok')
		expect(await binding.list()).toEqual({ result: [{ id: 'inst-1' }], result_info: resultInfo })
	})

	test('instance.info fetches the instance lazily', async () => {
		const binding = new AiSearchNamespaceBinding(db, 'my-ns', 'acc', 'tok')
		const info = await binding.get('inst-1').info()
		expect(info).toEqual({ id: 'inst-1', echo: null })
		expect(calls[0]!.method).toBe('GET')
		expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc/ai-search/instances/inst-1')
	})

	test('requests are logged to ai_search_requests table', async () => {
		const binding = new AiSearchNamespaceBinding(db, 'my-ns', 'acc', 'tok')
		await binding.list()
		const rows = db.query('SELECT * FROM ai_search_requests').all() as { operation: string; namespace: string; status: string }[]
		expect(rows).toHaveLength(1)
		expect(rows[0]!.operation).toBe('list')
		expect(rows[0]!.namespace).toBe('my-ns')
		expect(rows[0]!.status).toBe('ok')
	})

	test('HTTP errors are logged with status=error', async () => {
		globalThis.fetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
		const binding = new AiSearchNamespaceBinding(db, 'my-ns', 'acc', 'tok')
		await expect(binding.list()).rejects.toThrow()
		const row = db.query('SELECT status, error FROM ai_search_requests').get() as { status: string; error: string }
		expect(row.status).toBe('error')
		expect(row.error).toContain('HTTP 500')
	})
})
