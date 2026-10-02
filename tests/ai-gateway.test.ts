import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { AiBinding, AiGatewayInternalError, AiGatewayLogNotFound } from '../src/bindings/ai'
import { runMigrations } from '../src/db'

let db: Database
let ai: AiBinding
const originalFetch = globalThis.fetch

interface RequestLog {
	model: string
	input_summary: string
	output_summary: string
	status: string
	error: string | null
	is_streaming: number
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	const implementation = Object.assign(
		async (...[input, init]: Parameters<typeof globalThis.fetch>) => handler(input instanceof Request ? input.url : String(input), init),
		{ preconnect: originalFetch.preconnect },
	)
	return spyOn(globalThis, 'fetch').mockImplementation(implementation)
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
	return Response.json(value, init)
}

function logs(): RequestLog[] {
	return db.query<RequestLog, []>('SELECT model, input_summary, output_summary, status, error, is_streaming FROM ai_requests ORDER BY rowid').all()
}

beforeEach(() => {
	db = new Database(':memory:')
	runMigrations(db)
	ai = new AiBinding(db, 'test-account', 'test-token')
})

afterEach(() => {
	globalThis.fetch = originalFetch
	db.close()
})

describe('AI run gateway routing', () => {
	test('routes through default gateway using REST headers without changing the model inputs', async () => {
		const inputs = { messages: [{ role: 'user', content: 'Hello' }] }
		mockFetch((url, init) => {
			expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/test/model')
			expect(init?.method).toBe('POST')
			expect(init?.body).toBe(JSON.stringify(inputs))
			const headers = new Headers(init?.headers)
			expect(headers.get('Authorization')).toBe('Bearer test-token')
			expect(headers.get('Content-Type')).toBe('application/json')
			expect(headers.get('cf-aig-gateway-id')).toBe('default')
			expect(headers.get('cf-aig-cache-key')).toBe('conversation')
			expect(headers.get('cf-aig-cache-ttl')).toBe('0')
			expect(headers.get('cf-aig-skip-cache')).toBe('false')
			expect(headers.get('cf-aig-collect-log')).toBe('false')
			expect(headers.get('cf-aig-metadata')).toBe('{"user":"123","premium":true,"count":2,"optional":null}')
			expect(headers.get('cf-aig-event-id')).toBe('event-1')
			expect(headers.get('cf-aig-request-timeout')).toBe('2000')
			expect(headers.get('cf-aig-max-attempts')).toBe('3')
			expect(headers.get('cf-aig-retry-delay')).toBe('0')
			expect(headers.get('cf-aig-backoff')).toBe('exponential')
			return jsonResponse({ success: true, result: { response: 'Hi' } }, { headers: { 'cf-aig-log-id': 'log-1' } })
		})
		const result = await ai.run('@cf/test/model', inputs, {
			gateway: {
				id: 'default',
				cacheKey: 'conversation',
				cacheTtl: 0,
				skipCache: false,
				collectLog: false,
				metadata: { user: '123', premium: true, count: 2, optional: null },
				eventId: 'event-1',
				requestTimeoutMs: 2000,
				retries: { maxAttempts: 3, retryDelayMs: 0, backoff: 'exponential' },
			},
		})
		expect(result).toEqual({ response: 'Hi' })
		expect(ai.aiGatewayLogId).toBe('log-1')
		expect(logs()[0]?.status).toBe('ok')
	})

	test('direct Workers AI calls omit the gateway header and clear a previous log ID', async () => {
		mockFetch(() => jsonResponse({ result: 'first' }, { headers: { 'cf-aig-log-id': 'previous-log' } }))
		await ai.run('@cf/test/model', {}, { gateway: { id: 'named' } })
		mockFetch((_url, init) => {
			expect(new Headers(init?.headers).has('cf-aig-gateway-id')).toBe(false)
			return jsonResponse({ result: 'second' })
		})
		await ai.run('@cf/test/model', {})
		expect(ai.aiGatewayLogId).toBeNull()
	})

	test('third-party AI run uses the documented unified REST model/input envelope', async () => {
		mockFetch((url, init) => {
			expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/test-account/ai/run')
			expect(init?.body).toBe(JSON.stringify({ model: 'openai/gpt-4.1-mini', input: { messages: [{ role: 'user', content: 'Hi' }] } }))
			expect(new Headers(init?.headers).get('cf-aig-gateway-id')).toBe('default')
			return jsonResponse({ success: true, result: { choices: [] } })
		})
		expect(await ai.run('openai/gpt-4.1-mini', { messages: [{ role: 'user', content: 'Hi' }] }, { gateway: { id: 'default' } })).toEqual({
			choices: [],
		})
	})

	test('passes abort signals through to HTTP and logs transport failures without stale log IDs', async () => {
		ai.aiGatewayLogId = 'old-log'
		const controller = new AbortController()
		controller.abort()
		mockFetch((_url, init) => {
			expect(init?.signal).toBe(controller.signal)
			throw new DOMException('Aborted', 'AbortError')
		})
		await expect(ai.run('@cf/test/model', {}, { gateway: { id: 'default' }, signal: controller.signal })).rejects.toThrow('Aborted')
		expect(ai.aiGatewayLogId).toBeNull()
		expect(logs()[0]?.error).toContain('Aborted')
	})

	test('streaming returns the live unconsumed body and records the gateway log ID', async () => {
		const response = new Response('data: hello\n\n', { headers: { 'Content-Type': 'text/event-stream', 'cf-aig-log-id': 'stream-log' } })
		mockFetch(() => response)
		const result = await ai.run('@cf/test/model', { stream: true }, { gateway: { id: 'named' } })
		expect(result).toBe(response.body)
		expect(response.bodyUsed).toBe(false)
		if (!(result instanceof ReadableStream)) throw new Error('Expected stream')
		expect(await new Response(result).text()).toBe('data: hello\n\n')
		expect(ai.aiGatewayLogId).toBe('stream-log')
		expect(logs()[0]?.is_streaming).toBe(1)
	})

	test('raw response takes precedence over streaming and preserves status, headers, and body', async () => {
		const response = new Response('rate limited', { status: 429, headers: { 'cf-aig-log-id': 'failed-log', 'Retry-After': '3' } })
		mockFetch(() => response)
		const result = await ai.run('@cf/test/model', { stream: true }, { gateway: { id: 'named' }, returnRawResponse: true })
		expect(result).toBe(response)
		expect(response.bodyUsed).toBe(false)
		expect(response.headers.get('Retry-After')).toBe('3')
		expect(ai.aiGatewayLogId).toBe('failed-log')
		expect(logs()[0]?.status).toBe('error')
		expect(await response.text()).toBe('rate limited')
	})

	test('non-raw HTTP failures capture the upstream log ID and local error', async () => {
		mockFetch(() => jsonResponse({ errors: [{ message: 'Unauthorized' }] }, { status: 401, headers: { 'cf-aig-log-id': 'error-log' } }))
		await expect(ai.run('@cf/test/model', {}, { gateway: { id: 'named' } })).rejects.toThrow('HTTP 401')
		expect(ai.aiGatewayLogId).toBe('error-log')
		expect(logs()[0]?.status).toBe('error')
	})

	test('JSON failures reject even for a streaming input', async () => {
		mockFetch(() => jsonResponse({ success: false, result: null, errors: [{ code: 1000, message: 'Model failed' }] }))
		await expect(ai.run('@cf/test/model', { stream: true }, { gateway: { id: 'default' } })).rejects.toThrow('Model failed')
		expect(logs()[0]?.status).toBe('error')
	})

	test.each([
		{ envelope: { success: true } },
		{ envelope: { success: 'true', result: {} } },
		{ envelope: [] },
		{ envelope: null },
	])('rejects malformed inference envelopes: %p', async ({ envelope }) => {
		mockFetch(() => jsonResponse(envelope))
		await expect(ai.run('@cf/test/model', {}, { gateway: { id: 'default' } })).rejects.toThrow('Invalid Cloudflare AI response')
		expect(logs()[0]?.status).toBe('error')
	})

	test('validates gateway input options before HTTP', async () => {
		const fetch = mockFetch(() => jsonResponse({ result: {} }))
		await expect(ai.run('@cf/test/model', {}, { gateway: { id: '' } })).rejects.toThrow('gateway.id')
		await expect(ai.run('@cf/test/model', {}, { gateway: { id: 'named', cacheTtl: Number.NaN } })).rejects.toThrow('gateway.cacheTtl')
		expect(fetch).not.toHaveBeenCalled()
	})
})

describe('AI Gateway universal inference', () => {
	test('sends single provider requests as an array with normalized headers and gateway authentication', async () => {
		const query = { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'Hi' }] }
		const request = {
			provider: 'openai',
			endpoint: 'chat/completions',
			headers: { Authorization: 'Bearer provider-secret', 'cf-aig-cache-ttl': 30, 'cf-aig-skip-cache': true, 'cf-aig-metadata': { customer: '123' } },
			query,
		}
		const upstream = jsonResponse({ choices: [] }, { headers: { 'cf-aig-log-id': 'universal-log' } })
		mockFetch((url, init) => {
			expect(url).toBe('https://gateway.ai.cloudflare.com/v1/test-account/named')
			expect(init?.method).toBe('POST')
			expect(init?.body).toBe(JSON.stringify([{
				provider: 'openai',
				endpoint: 'chat/completions',
				headers: {
					Authorization: 'Bearer provider-secret',
					'cf-aig-cache-ttl': '30',
					'cf-aig-skip-cache': 'true',
					'cf-aig-metadata': '{"customer":"123"}',
				},
				query,
			}]))
			const headers = new Headers(init?.headers)
			expect(headers.get('cf-aig-authorization')).toBe('Bearer test-token')
			expect(headers.get('Authorization')).toBeNull()
			expect(headers.get('cf-aig-skip-cache')).toBe('false')
			expect(headers.get('cf-aig-cache-key')).toBe('override')
			expect(headers.get('Content-Type')).toBe('application/json')
			return upstream
		})
		const result = await ai.gateway('named').run(request, {
			gateway: { skipCache: false, cacheKey: 'initial' },
			extraHeaders: { 'cf-aig-cache-key': 'override' },
		})
		expect(result).toBe(upstream)
		expect(result.bodyUsed).toBe(false)
		expect(await result.json()).toEqual({ choices: [] })
		expect(request.headers['cf-aig-cache-ttl']).toBe(30)
		expect(logs()[0]?.model).toBe('openai/chat/completions')
		expect(logs()[0]?.input_summary).not.toContain('provider-secret')
	})

	test('preserves fallback order and distinct provider configs, returning a streaming Response without buffering', async () => {
		const requests: {
			provider: string
			endpoint: string
			headers: Record<string, string>
			query: Record<string, unknown>
			config: { requestTimeout: number; maxAttempts: number; retryDelay: number; backoff: 'constant' | 'linear' | 'exponential' }
		}[] = [
			{
				provider: 'workers-ai',
				endpoint: '@cf/test/model',
				headers: { authorization: 'Bearer workers-token' },
				query: { prompt: 'hi' },
				config: { requestTimeout: 1000, maxAttempts: 2, retryDelay: 0, backoff: 'constant' },
			},
			{
				provider: 'openai',
				endpoint: 'chat/completions',
				headers: {},
				query: { model: 'gpt-4.1-mini', stream: true },
				config: { requestTimeout: 3000, maxAttempts: 4, retryDelay: 60000, backoff: 'exponential' },
			},
		]
		const response = new Response('data: hello\n\n', { headers: { 'Content-Type': 'text/event-stream', 'cf-aig-step': '1' } })
		mockFetch((_url, init) => {
			expect(init?.body).toBe(JSON.stringify(requests))
			return response
		})
		const result = await ai.gateway('named').run(requests)
		expect(result).toBe(response)
		expect(result.bodyUsed).toBe(false)
		expect(result.headers.get('cf-aig-step')).toBe('1')
		expect(await result.text()).toBe('data: hello\n\n')
		expect(logs()[0]?.is_streaming).toBe(1)
	})

	test.each([
		{ config: { requestTimeout: Number.NaN }, field: 'config.requestTimeout' },
		{ config: { requestTimeout: -1 }, field: 'config.requestTimeout' },
		{ config: { maxAttempts: 6 }, field: 'config.maxAttempts' },
		{ config: { maxAttempts: 1.5 }, field: 'config.maxAttempts' },
		{ config: { retryDelay: 60001 }, field: 'config.retryDelay' },
	])('rejects invalid provider config before HTTP: %p', async ({ config, field }) => {
		const fetch = mockFetch(() => jsonResponse({}))
		await expect(ai.gateway('named').run({ provider: 'openai', endpoint: 'chat/completions', headers: {}, query: {}, config })).rejects.toThrow(field)
		expect(fetch).not.toHaveBeenCalled()
	})

	test('returns HTTP failures untouched, while logging the failure locally', async () => {
		const response = new Response('provider failed', { status: 502 })
		mockFetch(() => response)
		const result = await ai.gateway('named').run({ provider: 'openai', endpoint: 'chat/completions', headers: {}, query: {} })
		expect(result).toBe(response)
		expect(result.bodyUsed).toBe(false)
		expect(logs()[0]?.error).toBe('HTTP 502')
		expect(await result.text()).toBe('provider failed')
	})

	test('passes abort signals through and logs network failure', async () => {
		const controller = new AbortController()
		mockFetch((_url, init) => {
			expect(init?.signal).toBe(controller.signal)
			throw new Error('connection reset')
		})
		await expect(ai.gateway('named').run({ provider: 'openai', endpoint: 'chat/completions', headers: {}, query: {} }, { signal: controller.signal }))
			.rejects.toThrow('connection reset')
		expect(logs()[0]?.status).toBe('error')
	})

	test('requires configured credentials and validates request shape before HTTP', async () => {
		const fetch = mockFetch(() => jsonResponse({}))
		await expect(new AiBinding(db).gateway('named').run({ provider: 'openai', endpoint: 'chat/completions', headers: {}, query: {} })).rejects.toThrow(
			'CLOUDFLARE_ACCOUNT_ID',
		)
		await expect(ai.gateway('named').run([])).rejects.toThrow('at least one request')
		await expect(ai.gateway('named').run({ provider: '', endpoint: 'chat/completions', headers: {}, query: {} })).rejects.toThrow('provider')
		expect(fetch).not.toHaveBeenCalled()
	})
})

describe('AI Gateway control API', () => {
	test('getUrl uses the public REST URL result, with universal as the default provider', async () => {
		mockFetch((url, init) => {
			expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/test-account/ai-gateway/gateways/named/url/universal')
			expect(init?.method).toBe('GET')
			expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-token')
			return jsonResponse({ success: true, result: 'https://gateway.ai.cloudflare.com/v1/test-account/named/' })
		})
		expect(await ai.gateway('named').getUrl()).toBe('https://gateway.ai.cloudflare.com/v1/test-account/named/')
	})

	test('getUrl encodes gateway and provider path segments', async () => {
		mockFetch(url => {
			expect(url).toContain('/gateways/a%2Fb/url/custom%2Fprovider')
			return jsonResponse({ result: 'https://gateway.ai.cloudflare.com/v1/test-account/a%2Fb/custom%2Fprovider' })
		})
		await ai.gateway('a/b').getUrl('custom/provider')
	})

	test('getLog unwraps the result, converts created_at to Date, and retains optional fields', async () => {
		const log = {
			id: 'log/1',
			provider: 'openai',
			model: 'gpt-4.1-mini',
			path: 'chat/completions',
			duration: 123,
			success: true,
			cached: false,
			created_at: '2026-09-20T12:00:00.000Z',
			tokens_in: 7,
			tokens_out: 12,
			metadata: '{"user":"123"}',
			request_head: 'request',
			request_head_complete: true,
			response_head: 'response',
			status_code: 200,
		}
		mockFetch(url => {
			expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/test-account/ai-gateway/gateways/named/logs/log%2F1')
			return jsonResponse({ success: true, result: log })
		})
		const result = await ai.gateway('named').getLog('log/1')
		expect(result).toMatchObject({ ...log, created_at: new Date(log.created_at) })
		expect(result.created_at).toBeInstanceOf(Date)
	})

	test('patchLog sends feedback, score, and metadata with PATCH and returns void', async () => {
		const patch = { score: 100, feedback: 1, metadata: { user: '123', optional: null } }
		mockFetch((url, init) => {
			expect(url).toContain('/gateways/named/logs/log-1')
			expect(init?.method).toBe('PATCH')
			expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-token')
			expect(init?.body).toBe(JSON.stringify(patch))
			return jsonResponse({ success: true, result: {} })
		})
		expect(await ai.gateway('named').patchLog('log-1', { feedback: 1, score: 100, metadata: { user: '123', optional: null } })).toBeUndefined()
	})

	test('patchLog preserves explicit nulls and zero scores', async () => {
		mockFetch((_url, init) => {
			expect(init?.body).toBe('{"score":0,"feedback":null,"metadata":null}')
			return jsonResponse({ success: true, result: null })
		})
		await ai.gateway('named').patchLog('log-1', { score: 0, feedback: null, metadata: null })
	})

	test('missing logs have the workerd error class for both read and patch', async () => {
		mockFetch(() => jsonResponse({ success: false, errors: [{ message: 'Log Not Found' }] }, { status: 404 }))
		await expect(ai.gateway('named').getLog('missing')).rejects.toBeInstanceOf(AiGatewayLogNotFound)
		await expect(ai.gateway('named').patchLog('missing', { feedback: -1 })).rejects.toThrow('Log Not Found')
	})

	test('HTTP and success:false control API failures reject with gateway errors', async () => {
		mockFetch(() => jsonResponse({ errors: [{ message: 'Forbidden' }] }, { status: 403 }))
		await expect(ai.gateway('named').getUrl()).rejects.toBeInstanceOf(AiGatewayInternalError)
		mockFetch(() => jsonResponse({ success: false, result: {}, errors: [{ message: 'Patch rejected' }] }))
		await expect(ai.gateway('named').patchLog('log-1', {})).rejects.toThrow('Patch rejected')
	})

	test('rejects malformed URL and log payloads instead of exposing unvalidated data', async () => {
		mockFetch(() => jsonResponse({ success: true, result: { url: 'private binding shape' } }))
		await expect(ai.gateway('named').getUrl()).rejects.toThrow('AI Gateway URL')
		mockFetch(() => jsonResponse({ success: true, result: { id: 'log-1', created_at: 'not-a-date' } }))
		await expect(ai.gateway('named').getLog('log-1')).rejects.toThrow('created_at')
	})

	test('validates patch scores, identifiers, and credentials before HTTP', async () => {
		const fetch = mockFetch(() => jsonResponse({ result: {} }))
		expect(() => ai.gateway('')).toThrow('gateway.id')
		await expect(ai.gateway('named').patchLog('log-1', { score: 101 })).rejects.toThrow('score')
		await expect(ai.gateway('named').getLog('..')).rejects.toThrow('logId')
		await expect(new AiBinding(db).gateway('named').getUrl()).rejects.toThrow('CLOUDFLARE_ACCOUNT_ID')
		expect(fetch).not.toHaveBeenCalled()
	})
})
