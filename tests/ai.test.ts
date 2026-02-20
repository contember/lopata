import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { AiBinding } from '../src/bindings/ai'
import { runMigrations } from '../src/db'

let db: Database
let ai: AiBinding
const originalFetch = globalThis.fetch

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	globalThis.fetch = mock(handler as any) as any
}

beforeEach(() => {
	db = new Database(':memory:')
	runMigrations(db)
	ai = new AiBinding(db, 'test-account-id', 'test-api-token')
})

afterEach(() => {
	globalThis.fetch = originalFetch
	db.close()
})

describe('AiBinding', () => {
	describe('run()', () => {
		test('sends correct URL and Authorization header', async () => {
			let capturedUrl = ''
			let capturedHeaders: Record<string, string> = {}

			mockFetch((url, init) => {
				capturedUrl = url
				capturedHeaders = Object.fromEntries(
					Object.entries(init?.headers ?? {}).map(([k, v]) => [k, v]),
				)
				return new Response(JSON.stringify({ result: { text: 'hello' } }), {
					headers: { 'Content-Type': 'application/json' },
				})
			})

			await ai.run('@cf/meta/llama-2-7b-chat-int8', { prompt: 'hi' })

			expect(capturedUrl).toBe(
				'https://api.cloudflare.com/client/v4/accounts/test-account-id/ai/run/@cf/meta/llama-2-7b-chat-int8',
			)
			expect(capturedHeaders.Authorization).toBe('Bearer test-api-token')
			expect(capturedHeaders['Content-Type']).toBe('application/json')
		})

		test('returns result field from JSON response', async () => {
			mockFetch(() =>
				new Response(JSON.stringify({ result: { response: 'world' } }), {
					headers: { 'Content-Type': 'application/json' },
				})
			)

			const result = await ai.run('@cf/meta/llama-2-7b-chat-int8', { prompt: 'hi' })
			expect(result).toEqual({ response: 'world' })
		})

		test('logs request to SQLite', async () => {
			mockFetch(() =>
				new Response(JSON.stringify({ result: { text: 'ok' } }), {
					headers: { 'Content-Type': 'application/json' },
				})
			)

			await ai.run('@cf/meta/llama-2-7b-chat-int8', { prompt: 'test' })

			const rows = db.query<any, []>('SELECT * FROM ai_requests').all()
			expect(rows).toHaveLength(1)
			expect(rows[0].model).toBe('@cf/meta/llama-2-7b-chat-int8')
			expect(rows[0].status).toBe('ok')
			expect(rows[0].is_streaming).toBe(0)
			expect(rows[0].duration_ms).toBeGreaterThanOrEqual(0)
			expect(rows[0].created_at).toBeGreaterThan(0)
		})

		test('streaming returns ReadableStream and logs is_streaming=1', async () => {
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('data: hello\n\n'))
					controller.close()
				},
			})

			mockFetch(() => new Response(stream))

			const result = await ai.run('@cf/meta/llama-2-7b-chat-int8', {
				prompt: 'hi',
				stream: true,
			})

			expect(result).toBeInstanceOf(ReadableStream)

			const rows = db.query<any, []>('SELECT * FROM ai_requests').all()
			expect(rows).toHaveLength(1)
			expect(rows[0].is_streaming).toBe(1)
		})

		test('returnRawResponse returns Response object', async () => {
			mockFetch(() =>
				new Response(JSON.stringify({ result: 'data' }), {
					headers: { 'Content-Type': 'application/json' },
				})
			)

			const result = await ai.run(
				'@cf/meta/llama-2-7b-chat-int8',
				{ prompt: 'hi' },
				{ returnRawResponse: true },
			)

			expect(result).toBeInstanceOf(Response)
		})

		test('API error throws and logs error status', async () => {
			mockFetch(() => new Response('Unauthorized', { status: 401 }))

			await expect(
				ai.run('@cf/meta/llama-2-7b-chat-int8', { prompt: 'hi' }),
			).rejects.toThrow('HTTP 401')

			const rows = db.query<any, []>('SELECT * FROM ai_requests').all()
			expect(rows).toHaveLength(1)
			expect(rows[0].status).toBe('error')
			expect(rows[0].error).toContain('401')
		})

		test('large input/output is truncated in log', async () => {
			const largeInput = 'x'.repeat(2000)
			mockFetch(() =>
				new Response(JSON.stringify({ result: 'y'.repeat(2000) }), {
					headers: { 'Content-Type': 'application/json' },
				})
			)

			await ai.run('@cf/test/model', { prompt: largeInput })

			const rows = db.query<any, []>('SELECT * FROM ai_requests').all()
			expect(rows[0].input_summary.length).toBeLessThanOrEqual(1025) // 1024 + "…"
			expect(rows[0].output_summary.length).toBeLessThanOrEqual(1025)
		})
	})

	describe('models()', () => {
		test('constructs URL with search params', async () => {
			let capturedUrl = ''

			mockFetch((url) => {
				capturedUrl = url
				return new Response(JSON.stringify({ result: [] }), {
					headers: { 'Content-Type': 'application/json' },
				})
			})

			await ai.models({ search: 'llama', task: 'text-generation' })

			const url = new URL(capturedUrl)
			expect(url.pathname).toContain('/ai/models/search')
			expect(url.searchParams.get('search')).toBe('llama')
			expect(url.searchParams.get('task')).toBe('text-generation')
		})

		test('returns result array', async () => {
			const models = [{ name: 'model1' }, { name: 'model2' }]
			mockFetch(() =>
				new Response(JSON.stringify({ result: models }), {
					headers: { 'Content-Type': 'application/json' },
				})
			)

			const result = await ai.models()
			expect(result).toEqual(models)
		})
	})

	describe('credentials', () => {
		test('missing credentials throws clear error', async () => {
			const noCredAi = new AiBinding(db)
			await expect(
				noCredAi.run('@cf/test/model', { prompt: 'hi' }),
			).rejects.toThrow('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN')
		})

		test('missing account ID only throws', async () => {
			const partialAi = new AiBinding(db, undefined, 'token')
			await expect(
				partialAi.run('@cf/test/model', { prompt: 'hi' }),
			).rejects.toThrow('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN')
		})
	})

	describe('unsupported methods', () => {
		test('gateway() throws', () => {
			expect(() => ai.gateway('gw-1')).toThrow('not supported in local dev')
		})

		test('autorag() throws', () => {
			expect(() => ai.autorag('ar-1')).toThrow('not supported in local dev')
		})

		test('toMarkdown() throws', () => {
			expect(() => ai.toMarkdown()).toThrow('not supported in local dev')
		})
	})
})
