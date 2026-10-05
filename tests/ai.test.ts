import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { AiBinding } from '../src/bindings/ai'
import { runMigrations } from '../src/db'

let db: Database
let ai: AiBinding
const originalFetch = globalThis.fetch

interface AiRequestLog {
	model: string
	status: string
	error: string | null
	is_streaming: number
	duration_ms: number
	created_at: number
	input_summary: string
	output_summary: string
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	const implementation = Object.assign(
		async (...[input, init]: Parameters<typeof globalThis.fetch>) => handler(input instanceof Request ? input.url : String(input), init),
		{ preconnect: originalFetch.preconnect },
	)
	spyOn(globalThis, 'fetch').mockImplementation(implementation)
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
	describe('native transport', () => {
		test.each([true, false, undefined])('serializes rejectIfBusy=%p without losing model inputs', async rejectIfBusy => {
			const inputs = { prompt: 'hi', seed: 42, options: { unrelated: 'keep' } }
			mockFetch((_url, init) => {
				expect(init?.body).toBe(JSON.stringify({
					...inputs,
					options: rejectIfBusy === undefined ? inputs.options : { ...inputs.options, rejectIfBusy },
				}))
				return Response.json({ result: 'ok' })
			})
			await ai.run('@cf/test/model', inputs, { rejectIfBusy })
			expect(inputs).toEqual({ prompt: 'hi', seed: 42, options: { unrelated: 'keep' } })
		})

		test('absent busy option adds no options and top-level model fields remain intact', async () => {
			mockFetch((_url, init) => {
				expect(init?.body).toBe('{"prompt":"hi","rejectIfBusy":"model-field"}')
				return Response.json({ result: 'ok' })
			})
			await ai.run('@cf/test/model', { prompt: 'hi', rejectIfBusy: 'model-field' })
		})

		test('rejects ambiguous busy options rather than overwriting input values', async () => {
			const fetch = spyOn(globalThis, 'fetch')
			await expect(ai.run('@cf/test/model', { options: 'keep' }, { rejectIfBusy: true })).rejects.toThrow('must be an object')
			await expect(ai.run('@cf/test/model', { options: { rejectIfBusy: false } }, { rejectIfBusy: true })).rejects.toThrow('Conflicting')
			await expect(ai.run('openai/model', {}, { rejectIfBusy: false })).rejects.toThrow('native Workers AI')
			expect(fetch).not.toHaveBeenCalled()
		})

		test('forwards delayed binary multipart unchanged without buffering or logging its bytes', async () => {
			const contentType = 'multipart/form-data; boundary="ai-binary-boundary"'
			const first = new TextEncoder().encode(
				'--ai-binary-boundary\r\nContent-Disposition: form-data; name="input_image_0"; filename="image.bin"\r\n\r\n',
			)
			const last = new Uint8Array([0, 255, 128, ...new TextEncoder().encode('secret-image\r\n--ai-binary-boundary--\r\n')])
			const release = Promise.withResolvers<void>()
			let completed = false
			let chunk = 0
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					if (chunk++ === 0) controller.enqueue(first)
					else {
						await release.promise
						controller.enqueue(last)
						controller.close()
						completed = true
					}
				},
			})
			mockFetch(async (url, init) => {
				expect(url).toEndWith('/ai/run/@cf/black-forest-labs/flux-2-dev')
				expect(new Headers(init?.headers).get('Content-Type')).toBe(contentType)
				if (!(init?.body instanceof ReadableStream)) throw new Error('Expected upload stream')
				const reader = init.body.getReader()
				expect((await reader.read()).value).toEqual(first)
				expect(completed).toBe(false)
				release.resolve()
				expect((await reader.read()).value).toEqual(last)
				expect((await reader.read()).done).toBe(true)
				return Response.json({ result: 'ok' })
			})
			await ai.run('@cf/black-forest-labs/flux-2-dev', { multipart: { body, contentType } })
			const log = db.query<AiRequestLog, []>('SELECT * FROM ai_requests').get()
			expect(JSON.parse(log?.input_summary ?? '')).toEqual({ multipart: { contentType, body: '<stream>' } })
			expect(JSON.stringify(log)).not.toContain('secret-image')
			expect(JSON.stringify(log)).not.toContain('test-api-token')
		})

		test('multipart upload cancellation and AbortSignal reach the transport', async () => {
			const cancelled = Promise.withResolvers<unknown>()
			const body = new ReadableStream({ cancel: cancelled.resolve })
			const controller = new AbortController()
			mockFetch(async (_url, init) => {
				expect(init?.signal).toBe(controller.signal)
				if (!(init?.body instanceof ReadableStream)) throw new Error('Expected upload stream')
				await init.body.cancel('transport stopped')
				controller.abort()
				throw controller.signal.reason
			})
			await expect(ai.run('@cf/test/model', { multipart: { body, contentType: 'multipart/form-data; boundary=x' } }, { signal: controller.signal }))
				.rejects.toThrow('aborted')
			expect(await cancelled.promise).toBe('transport stopped')
			expect(db.query<AiRequestLog, []>('SELECT * FROM ai_requests').get()?.status).toBe('error')
		})

		test('rejects unsupported stream combinations before reading or sending', async () => {
			const fetch = spyOn(globalThis, 'fetch')
			let pulls = 0
			const body = new ReadableStream({
				pull() {
					pulls++
				},
			}, { highWaterMark: 0 })
			const multipart = { body, contentType: 'multipart/form-data; boundary=x' }
			await expect(ai.run('@cf/test/model', { multipart }, { gateway: { id: 'default' } })).rejects.toThrow('Gateway')
			await expect(ai.run('openai/model', { multipart })).rejects.toThrow('native Workers AI')
			for (const rejectIfBusy of [true, false]) {
				await expect(ai.run('@cf/test/model', { multipart }, { rejectIfBusy })).rejects.toThrow('rejectIfBusy')
			}
			await expect(ai.run('@cf/test/model', { multipart, prompt: 'would be lost' })).rejects.toThrow('standalone multipart')
			await expect(ai.run('@cf/test/model', { multipart, another: multipart })).rejects.toThrow('Multiple ReadableStreams')
			await expect(ai.run('@cf/test/model', { audio: multipart })).rejects.toThrow('standalone multipart')
			await expect(ai.run('@cf/test/model', { multipart: body })).rejects.toThrow('multipart.body must be a ReadableStream')
			await expect(ai.run('@cf/test/model', { multipart: false, audio: multipart })).rejects.toThrow('standalone multipart')
			await expect(ai.run('@cf/test/model', { multipart: { body } })).rejects.toThrow('contentType')
			await expect(ai.run('@cf/test/model', { multipart: { body, contentType: '' } })).rejects.toThrow('Content-Type')
			await expect(ai.run('@cf/test/model', { multipart: { body: new FormData(), contentType: multipart.contentType } })).rejects.toThrow(
				'ReadableStream',
			)
			await expect(ai.run('@cf/test/model', { multipart: { ...multipart, ignored: true } })).rejects.toThrow('Unsupported multipart')
			expect(fetch).not.toHaveBeenCalled()
			expect(pulls).toBe(0)
		})

		test('returns the first response chunk before completion and propagates cancellation without log draining', async () => {
			const cancelled = Promise.withResolvers<unknown>()
			let pulls = 0
			const response = new Response(
				new ReadableStream({
					pull(controller) {
						pulls++
						controller.enqueue(new Uint8Array([1, 2, 255]))
					},
					cancel: cancelled.resolve,
				}, { highWaterMark: 0 }),
				{ headers: { 'Content-Type': 'image/png', 'cf-aig-log-id': 'image-log' } },
			)
			mockFetch(() => response)
			const result = await ai.run('@cf/test/model', { multipart: { body: new ReadableStream(), contentType: 'multipart/form-data; boundary=x' } })
			expect(response.bodyUsed).toBe(false)
			expect(pulls).toBe(0)
			if (!(result instanceof ReadableStream)) throw new Error('Expected stream')
			const reader = result.getReader()
			expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 255]))
			await reader.cancel('consumer stopped')
			expect(await cancelled.promise).toBe('consumer stopped')
			expect(ai.aiGatewayLogId).toBe('image-log')
		})

		test('capacity failures preserve HTTP 429 and internal code 3040 in errors and logs', async () => {
			mockFetch(() =>
				Response.json({ errors: [{ code: 3040, message: 'Capacity temporarily exceeded, please try again.' }] }, {
					status: 429,
					headers: { 'cf-aig-log-id': 'busy-log' },
				})
			)
			await expect(ai.run('@cf/test/model', {}, { rejectIfBusy: true })).rejects.toThrow('HTTP 429: {"errors":[{"code":3040')
			const log = db.query<AiRequestLog, []>('SELECT * FROM ai_requests').get()
			expect(log?.error).toContain('3040')
			expect(log?.status).toBe('error')
			expect(ai.aiGatewayLogId).toBe('busy-log')
		})

		test('raw capacity responses remain unread', async () => {
			const response = Response.json({ errors: [{ code: 3040 }] }, { status: 429, headers: { 'Retry-After': '2' } })
			mockFetch(() => response)
			const result = await ai.run('@cf/test/model', {}, { rejectIfBusy: true, returnRawResponse: true })
			expect(result).toBe(response)
			expect(response.bodyUsed).toBe(false)
			expect(response.headers.get('Retry-After')).toBe('2')
			expect(await response.json()).toEqual({ errors: [{ code: 3040 }] })
		})
	})

	describe('run()', () => {
		test('sends correct URL and Authorization header', async () => {
			let capturedUrl = ''
			let capturedHeaders = new Headers()

			mockFetch((url, init) => {
				capturedUrl = url
				capturedHeaders = new Headers(init?.headers)
				return new Response(JSON.stringify({ result: { text: 'hello' } }), {
					headers: { 'Content-Type': 'application/json' },
				})
			})

			await ai.run('@cf/meta/llama-2-7b-chat-int8', { prompt: 'hi' })

			expect(capturedUrl).toBe(
				'https://api.cloudflare.com/client/v4/accounts/test-account-id/ai/run/@cf/meta/llama-2-7b-chat-int8',
			)
			expect(capturedHeaders.get('Authorization')).toBe('Bearer test-api-token')
			expect(capturedHeaders.get('Content-Type')).toBe('application/json')
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

			const rows = db.query<AiRequestLog, []>('SELECT * FROM ai_requests').all()
			expect(rows).toHaveLength(1)
			expect(rows[0]?.model).toBe('@cf/meta/llama-2-7b-chat-int8')
			expect(rows[0]?.status).toBe('ok')
			expect(rows[0]?.is_streaming).toBe(0)
			expect(rows[0]?.duration_ms).toBeGreaterThanOrEqual(0)
			expect(rows[0]?.created_at).toBeGreaterThan(0)
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

			const rows = db.query<AiRequestLog, []>('SELECT * FROM ai_requests').all()
			expect(rows).toHaveLength(1)
			expect(rows[0]?.is_streaming).toBe(1)
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

			const rows = db.query<AiRequestLog, []>('SELECT * FROM ai_requests').all()
			expect(rows).toHaveLength(1)
			expect(rows[0]?.status).toBe('error')
			expect(rows[0]?.error).toContain('401')
		})

		test('large input/output is truncated in log', async () => {
			const largeInput = 'x'.repeat(2000)
			mockFetch(() =>
				new Response(JSON.stringify({ result: 'y'.repeat(2000) }), {
					headers: { 'Content-Type': 'application/json' },
				})
			)

			await ai.run('@cf/test/model', { prompt: largeInput })

			const rows = db.query<AiRequestLog, []>('SELECT * FROM ai_requests').all()
			expect(rows[0]?.input_summary.length).toBeLessThanOrEqual(1025) // 1024 + "…"
			expect(rows[0]?.output_summary.length).toBeLessThanOrEqual(1025)
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
		test('autorag() throws', () => {
			expect(() => ai.autorag('ar-1')).toThrow('not supported in local dev')
		})

		test('toMarkdown() throws', () => {
			expect(() => ai.toMarkdown()).toThrow('not supported in local dev')
		})
	})
})
