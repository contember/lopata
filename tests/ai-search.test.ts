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
		const result = await binding.delete('inst-1')
		expect(result).toBe(true)
		expect(calls[0]!.method).toBe('DELETE')
		expect(calls[0]!.url).toContain('/ai-search/instances/inst-1')
	})

	test('namespace search hits namespace-level endpoint', async () => {
		const binding = new AiSearchNamespaceBinding(db, 'my-ns', 'acc', 'tok')
		await binding.search({ messages: [{ role: 'user', content: 'hi' }] })
		expect(calls[0]!.url).toContain('/ai-search/namespaces/my-ns/search')
		expect(calls[0]!.method).toBe('POST')
	})

	test('instance.search hits instance-level endpoint', async () => {
		const binding = new AiSearchNamespaceBinding(db, 'my-ns', 'acc', 'tok')
		const inst = await binding.get('inst-1')
		calls.length = 0
		await inst.search({ messages: [{ role: 'user', content: 'hi' }] })
		expect(calls[0]!.url).toContain('/ai-search/instances/inst-1/search')
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
