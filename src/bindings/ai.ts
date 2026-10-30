/**
 * Local implementation of the Cloudflare Workers AI binding.
 * Proxies requests to the Cloudflare AI API and logs them to SQLite.
 */
import type { Database } from 'bun:sqlite'

const MAX_LOG_SIZE = 1024

type GatewayMetadata = Record<string, number | string | boolean | null | bigint>

interface GatewayRetries {
	maxAttempts?: 1 | 2 | 3 | 4 | 5
	retryDelayMs?: number
	backoff?: 'constant' | 'linear' | 'exponential'
}

interface UniversalGatewayOptions {
	id?: string
	cacheKey?: string
	cacheTtl?: number
	skipCache?: boolean
	metadata?: GatewayMetadata
	collectLog?: boolean
	eventId?: string
	requestTimeoutMs?: number
	retries?: GatewayRetries
}

interface GatewayOptions extends UniversalGatewayOptions {
	id: string
}

interface AiRunOptions {
	returnRawResponse?: boolean
	rejectIfBusy?: boolean
	gateway?: GatewayOptions
	signal?: AbortSignal
}

interface GatewayRunOptions {
	gateway?: UniversalGatewayOptions
	extraHeaders?: Record<string, string>
	signal?: AbortSignal
}

interface GatewayRequestConfig {
	requestTimeout?: number
	maxAttempts?: number
	retryDelay?: number
	backoff?: 'constant' | 'linear' | 'exponential'
}

interface GatewayRequest {
	provider: string
	endpoint: string
	headers: Record<string, string | number | boolean | object>
	query: unknown
	config?: GatewayRequestConfig
}

interface GatewayPatchLog {
	score?: number | null
	feedback?: -1 | 1 | null
	metadata?: GatewayMetadata | null
}

interface GatewayLog {
	id: string
	provider: string
	model: string
	path: string
	duration: number
	success: boolean
	cached: boolean
	created_at: Date
	model_type?: string
	request_type?: string
	request_content_type?: string
	status_code?: number
	response_content_type?: string
	tokens_in?: number
	tokens_out?: number
	metadata?: string | GatewayMetadata
	step?: number
	cost?: number
	custom_cost?: boolean
	request_size?: number
	request_head?: string
	request_head_complete?: boolean
	response_size?: number
	response_head?: string
	response_head_complete?: boolean
}

export class AiGatewayInternalError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'AiGatewayInternalError'
	}
}

export class AiGatewayLogNotFound extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'AiGatewayLogNotFound'
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: unknown, field: string): string {
	if (typeof value !== 'string') throw new TypeError(`${field} must be a string`)
	return value
}

function identifier(value: unknown, field: string): string {
	const text = stringField(value, field)
	if (!text || text === '.' || text === '..') throw new TypeError(`${field} must be a non-empty identifier`)
	return text
}

function numberField(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${field} must be a finite number`)
	return value
}

function booleanField(value: unknown, field: string): boolean {
	if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`)
	return value
}

function optionalString(value: unknown, field: string): string | undefined {
	return value === undefined ? undefined : stringField(value, field)
}

function optionalNumber(value: unknown, field: string): number | undefined {
	return value === undefined ? undefined : numberField(value, field)
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
	return value === undefined ? undefined : booleanField(value, field)
}

function parseMetadata(value: unknown): GatewayMetadata {
	if (!isRecord(value)) throw new TypeError('metadata must be an object')
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]): [string, GatewayMetadata[string]] => {
			if (entry === null || typeof entry === 'string' || typeof entry === 'boolean' || typeof entry === 'bigint') return [key, entry]
			return [key, numberField(entry, `metadata.${key}`)]
		}),
	)
}

function parseGatewayOptions(value: unknown): UniversalGatewayOptions {
	if (!isRecord(value)) throw new TypeError('gateway options must be an object')
	let retries: GatewayRetries | undefined
	if (value.retries !== undefined) {
		if (!isRecord(value.retries)) throw new TypeError('gateway.retries must be an object')
		const maxAttempts = value.retries.maxAttempts
		if (maxAttempts !== undefined && maxAttempts !== 1 && maxAttempts !== 2 && maxAttempts !== 3 && maxAttempts !== 4 && maxAttempts !== 5) {
			throw new TypeError('gateway.retries.maxAttempts must be an integer from 1 to 5')
		}
		const backoff = value.retries.backoff
		if (backoff !== undefined && backoff !== 'constant' && backoff !== 'linear' && backoff !== 'exponential') {
			throw new TypeError('gateway.retries.backoff must be constant, linear, or exponential')
		}
		retries = { maxAttempts, backoff, retryDelayMs: optionalNumber(value.retries.retryDelayMs, 'gateway.retries.retryDelayMs') }
	}
	return {
		id: value.id === undefined ? undefined : identifier(value.id, 'gateway.id'),
		cacheKey: optionalString(value.cacheKey, 'gateway.cacheKey'),
		cacheTtl: optionalNumber(value.cacheTtl, 'gateway.cacheTtl'),
		skipCache: optionalBoolean(value.skipCache, 'gateway.skipCache'),
		metadata: value.metadata === undefined ? undefined : parseMetadata(value.metadata),
		collectLog: optionalBoolean(value.collectLog, 'gateway.collectLog'),
		eventId: optionalString(value.eventId, 'gateway.eventId'),
		requestTimeoutMs: optionalNumber(value.requestTimeoutMs, 'gateway.requestTimeoutMs'),
		retries,
	}
}

function gatewayHeaders(options?: UniversalGatewayOptions): Headers {
	const headers = new Headers({ 'Content-Type': 'application/json' })
	if (!options) return headers
	const values = {
		'cf-aig-cache-key': options.cacheKey,
		'cf-aig-cache-ttl': options.cacheTtl,
		'cf-aig-skip-cache': options.skipCache,
		'cf-aig-collect-log': options.collectLog,
		'cf-aig-event-id': options.eventId,
		'cf-aig-request-timeout': options.requestTimeoutMs,
		'cf-aig-max-attempts': options.retries?.maxAttempts,
		'cf-aig-retry-delay': options.retries?.retryDelayMs,
		'cf-aig-backoff': options.retries?.backoff,
		'cf-aig-metadata': options.metadata === undefined ? undefined : JSON.stringify(options.metadata),
	}
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined) headers.set(key, String(value))
	}
	return headers
}

function parseSignal(value: unknown): AbortSignal | undefined {
	if (value === undefined) return undefined
	if (!(value instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal')
	return value
}

function parseRunOptions(value: unknown): AiRunOptions {
	if (!isRecord(value)) throw new TypeError('AI run options must be an object')
	const gateway = value.gateway === undefined ? undefined : parseGatewayOptions(value.gateway)
	return {
		returnRawResponse: optionalBoolean(value.returnRawResponse, 'returnRawResponse'),
		rejectIfBusy: optionalBoolean(value.rejectIfBusy, 'rejectIfBusy'),
		gateway: gateway === undefined ? undefined : { ...gateway, id: identifier(gateway.id, 'gateway.id') },
		signal: parseSignal(value.signal),
	}
}

function parseGatewayRunOptions(value: unknown): GatewayRunOptions {
	if (!isRecord(value)) throw new TypeError('gateway run options must be an object')
	let extraHeaders: Record<string, string> | undefined
	if (value.extraHeaders !== undefined) {
		if (!isRecord(value.extraHeaders)) throw new TypeError('extraHeaders must be an object')
		extraHeaders = Object.fromEntries(
			Object.entries(value.extraHeaders).map(([key, entry]): [string, string] => [key, stringField(entry, `extraHeaders.${key}`)]),
		)
	}
	return {
		gateway: value.gateway === undefined ? undefined : parseGatewayOptions(value.gateway),
		extraHeaders,
		signal: parseSignal(value.signal),
	}
}

function parseGatewayRequestConfig(value: unknown): GatewayRequestConfig {
	if (!isRecord(value)) throw new TypeError('config must be an object')
	const requestTimeout = optionalNumber(value.requestTimeout, 'config.requestTimeout')
	if (requestTimeout !== undefined && requestTimeout < 0) throw new TypeError('config.requestTimeout must be non-negative')
	const maxAttempts = optionalNumber(value.maxAttempts, 'config.maxAttempts')
	if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5)) {
		throw new TypeError('config.maxAttempts must be an integer from 1 to 5')
	}
	const retryDelay = optionalNumber(value.retryDelay, 'config.retryDelay')
	if (retryDelay !== undefined && (retryDelay < 0 || retryDelay > 60000)) throw new TypeError('config.retryDelay must be between 0 and 60000')
	const backoff = value.backoff
	if (backoff !== undefined && backoff !== 'constant' && backoff !== 'linear' && backoff !== 'exponential') {
		throw new TypeError('config.backoff must be constant, linear, or exponential')
	}
	return { requestTimeout, maxAttempts, retryDelay, backoff }
}

function parseGatewayRequest(value: unknown): Omit<GatewayRequest, 'headers'> & { headers: Record<string, string> } {
	if (!isRecord(value) || !isRecord(value.headers) || !('query' in value)) throw new TypeError('Invalid AI Gateway request')
	const headers = Object.fromEntries(
		Object.entries(value.headers).map(([key, entry]): [string, string] => {
			if (typeof entry === 'string' || typeof entry === 'boolean') return [key, String(entry)]
			if (typeof entry === 'number') return [key, String(numberField(entry, `headers.${key}`))]
			if (typeof entry === 'object' && entry !== null) return [key, JSON.stringify(entry)]
			throw new TypeError(`Invalid AI Gateway header ${key}`)
		}),
	)
	return {
		provider: identifier(value.provider, 'provider'),
		endpoint: identifier(value.endpoint, 'endpoint'),
		headers,
		query: value.query,
		config: value.config === undefined ? undefined : parseGatewayRequestConfig(value.config),
	}
}

function parsePatchLog(value: unknown): GatewayPatchLog {
	if (!isRecord(value)) throw new TypeError('log patch must be an object')
	const score = value.score === null ? null : optionalNumber(value.score, 'score')
	if (score !== undefined && score !== null && (score < 0 || score > 100)) throw new TypeError('score must be between 0 and 100')
	const feedback = value.feedback
	if (feedback !== undefined && feedback !== null && feedback !== -1 && feedback !== 1) throw new TypeError('feedback must be -1, 1, or null')
	return { score, feedback, metadata: value.metadata === undefined || value.metadata === null ? value.metadata : parseMetadata(value.metadata) }
}

function parseGatewayLog(value: unknown): GatewayLog {
	if (!isRecord(value)) throw new TypeError('Invalid AI Gateway log')
	const createdAt = new Date(stringField(value.created_at, 'created_at'))
	if (!Number.isFinite(createdAt.getTime())) throw new TypeError('Invalid AI Gateway log created_at')
	return {
		id: stringField(value.id, 'id'),
		provider: stringField(value.provider, 'provider'),
		model: stringField(value.model, 'model'),
		path: stringField(value.path, 'path'),
		duration: numberField(value.duration, 'duration'),
		success: booleanField(value.success, 'success'),
		cached: booleanField(value.cached, 'cached'),
		created_at: createdAt,
		model_type: optionalString(value.model_type, 'model_type'),
		request_type: optionalString(value.request_type, 'request_type'),
		request_content_type: optionalString(value.request_content_type, 'request_content_type'),
		status_code: optionalNumber(value.status_code, 'status_code'),
		response_content_type: optionalString(value.response_content_type, 'response_content_type'),
		tokens_in: optionalNumber(value.tokens_in, 'tokens_in'),
		tokens_out: optionalNumber(value.tokens_out, 'tokens_out'),
		metadata: value.metadata === undefined || typeof value.metadata === 'string' ? value.metadata : parseMetadata(value.metadata),
		step: optionalNumber(value.step, 'step'),
		cost: optionalNumber(value.cost, 'cost'),
		custom_cost: optionalBoolean(value.custom_cost, 'custom_cost'),
		request_size: optionalNumber(value.request_size, 'request_size'),
		request_head: optionalString(value.request_head, 'request_head'),
		request_head_complete: optionalBoolean(value.request_head_complete, 'request_head_complete'),
		response_size: optionalNumber(value.response_size, 'response_size'),
		response_head: optionalString(value.response_head, 'response_head'),
		response_head_complete: optionalBoolean(value.response_head_complete, 'response_head_complete'),
	}
}

function envelopeResult(value: unknown): unknown {
	if (!isRecord(value)) throw new Error('Invalid Cloudflare AI response envelope')
	if (value.success !== undefined && typeof value.success !== 'boolean') throw new Error('Invalid Cloudflare AI response success flag')
	if (value.success === false) throw new Error(`Cloudflare AI request failed: ${JSON.stringify(value.errors ?? [])}`)
	if (!('result' in value)) throw new Error('Invalid Cloudflare AI response envelope: missing result')
	return value.result
}

interface LoggedResult<T> {
	value: T
	summary: string
	error?: string
}

async function logRequest<T>(db: Database, model: string, inputs: unknown, streaming: boolean, request: () => Promise<LoggedResult<T>>): Promise<T> {
	const id = crypto.randomUUID()
	const start = Date.now()
	let error: string | undefined
	let summary = ''
	try {
		const result = await request()
		summary = result.summary
		error = result.error
		return result.value
	} catch (err) {
		error = err instanceof Error ? err.message : String(err)
		throw err
	} finally {
		db.prepare(
			`INSERT INTO ai_requests (id, model, input_summary, output_summary, duration_ms, status, error, is_streaming, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(id, model, truncate(inputs), summary, Date.now() - start, error === undefined ? 'ok' : 'error', error ?? null, streaming ? 1 : 0, start)
	}
}

function truncate(value: unknown): string {
	const str = typeof value === 'string' ? value : JSON.stringify(value)
	if (!str) return ''
	return str.length > MAX_LOG_SIZE ? str.slice(0, MAX_LOG_SIZE) + '…' : str
}

interface AiRequestBody {
	body: string | ReadableStream
	contentType: string
	logInput: unknown
}

function prepareRunBody(model: string, inputs: Record<string, unknown>, options: AiRunOptions): AiRequestBody {
	const streamKeys = Object.entries(inputs).filter(([, value]) =>
		value instanceof ReadableStream || value instanceof FormData
		|| (isRecord(value) && (value.body instanceof ReadableStream || value.body instanceof FormData))
	).map(([key]) => key)
	if (streamKeys.length > 1) throw new TypeError('Multiple ReadableStreams are not supported')
	if (streamKeys.length > 0) {
		if (options.gateway) throw new TypeError('AI Gateway does not support ReadableStreams yet')
		if (!model.startsWith('@')) throw new TypeError('Multipart inputs are only supported for native Workers AI models')
		if (options.rejectIfBusy !== undefined) throw new TypeError('rejectIfBusy is not supported with multipart inputs in local dev')
		if (Object.keys(inputs).length !== 1 || !('multipart' in inputs)) {
			throw new TypeError('Only a standalone multipart input is supported in local dev')
		}
		const multipart = inputs.multipart
		if (!isRecord(multipart) || !(multipart.body instanceof ReadableStream)) throw new TypeError('multipart.body must be a ReadableStream')
		if (Object.keys(multipart).some(key => key !== 'body' && key !== 'contentType')) throw new TypeError('Unsupported multipart input fields')
		const contentType = stringField(multipart.contentType, 'multipart.contentType')
		if (!contentType.trim()) throw new TypeError('Content-Type is required with ReadableStream inputs')
		return { body: multipart.body, contentType, logInput: { multipart: { contentType, body: '<stream>' } } }
	}
	let jsonInputs = inputs
	if (options.rejectIfBusy !== undefined) {
		if (!model.startsWith('@')) throw new TypeError('rejectIfBusy is only supported for native Workers AI models in local dev')
		if (inputs.options !== undefined && !isRecord(inputs.options)) throw new TypeError('AI input options must be an object when using rejectIfBusy')
		if (inputs.options?.rejectIfBusy !== undefined && inputs.options.rejectIfBusy !== options.rejectIfBusy) {
			throw new TypeError('Conflicting rejectIfBusy in AI input options')
		}
		jsonInputs = { ...inputs, options: { ...inputs.options, rejectIfBusy: options.rejectIfBusy } }
	}
	return {
		body: JSON.stringify(model.startsWith('@') ? jsonInputs : { model, input: jsonInputs }),
		contentType: 'application/json',
		logInput: jsonInputs,
	}
}

export class AiBinding {
	private readonly db: Database
	private readonly accountId?: string
	private readonly apiToken?: string
	aiGatewayLogId: string | null = null

	constructor(db: Database, accountId?: string, apiToken?: string) {
		this.db = db
		this.accountId = accountId
		this.apiToken = apiToken
	}

	private ensureCredentials(): { accountId: string; apiToken: string } {
		if (!this.accountId || !this.apiToken) {
			throw new Error(
				'Workers AI requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in .dev.vars',
			)
		}
		return { accountId: this.accountId, apiToken: this.apiToken }
	}

	async run(model: string, inputs: Record<string, unknown>, options: AiRunOptions = {}): Promise<unknown> {
		this.aiGatewayLogId = null
		const { accountId, apiToken } = this.ensureCredentials()
		const parsedOptions = parseRunOptions(options)
		identifier(model, 'model')
		if (!isRecord(inputs)) throw new TypeError('AI inputs must be an object')
		const requestBody = prepareRunBody(model, inputs, parsedOptions)
		const isStreaming = inputs.stream === true
		return logRequest(this.db, model, requestBody.logInput, isStreaming, async () => {
			const headers = gatewayHeaders(parsedOptions.gateway)
			headers.set('Content-Type', requestBody.contentType)
			headers.set('Authorization', `Bearer ${apiToken}`)
			if (parsedOptions.gateway) headers.set('cf-aig-gateway-id', parsedOptions.gateway.id)
			// Third-party models use the unified REST envelope, not the legacy Workers AI model-in-path endpoint.
			const thirdParty = !model.startsWith('@')
			const path = thirdParty
				? ''
				: '/' + model.split('/').map(part => encodeURIComponent(identifier(part, 'model segment')).replace('%40', '@')).join('/')
			const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run${path}`
			const response = await fetch(url, {
				method: 'POST',
				headers,
				body: requestBody.body,
				signal: parsedOptions.signal,
			})
			this.aiGatewayLogId = response.headers.get('cf-aig-log-id')

			if (parsedOptions.returnRawResponse) {
				return { value: response, summary: '<raw response>', error: response.ok ? undefined : `HTTP ${response.status}` }
			}

			if (!response.ok) {
				const text = await response.text()
				throw new Error(`HTTP ${response.status}: ${text}`)
			}

			const contentType = response.headers.get('content-type')?.split(';')[0]?.trim()
			if (contentType !== 'application/json' && (isStreaming || contentType)) {
				return { value: response.body, summary: '<streaming>' }
			}
			const json: unknown = await response.json()
			const result = envelopeResult(json)
			return { value: result, summary: truncate(result) }
		})
	}

	async models(params?: Record<string, string>): Promise<unknown[]> {
		const { accountId, apiToken } = this.ensureCredentials()
		const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search`)
		if (params) {
			for (const [key, value] of Object.entries(params)) {
				url.searchParams.set(key, value)
			}
		}
		const response = await fetch(url.toString(), {
			headers: { Authorization: `Bearer ${apiToken}` },
		})
		if (!response.ok) {
			const text = await response.text()
			throw new Error(`Workers AI models() failed: HTTP ${response.status}: ${text}`)
		}
		const json: unknown = await response.json()
		const result = envelopeResult(json)
		if (!Array.isArray(result)) throw new Error('Invalid Workers AI models response: result must be an array')
		return result
	}

	gateway(id: string): AiGateway {
		return new AiGateway(this.db, identifier(id, 'gateway.id'), () => this.ensureCredentials())
	}

	autorag(_id: string): never {
		throw new Error('ai.autorag() is not supported in local dev mode')
	}

	toMarkdown(): never {
		throw new Error('ai.toMarkdown() is not supported in local dev mode')
	}
}

export class AiGateway {
	constructor(
		private readonly db: Database,
		private readonly id: string,
		private readonly credentials: () => { accountId: string; apiToken: string },
	) {}

	private async apiRequest(path: string, method = 'GET', body?: GatewayPatchLog): Promise<unknown> {
		const { accountId, apiToken } = this.credentials()
		const response = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai-gateway/gateways/${encodeURIComponent(this.id)}/${path}`,
			{
				method,
				headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body),
			},
		)
		if (!response.ok) {
			const text = await response.text()
			let message = `HTTP ${response.status}: ${text}`
			try {
				const json: unknown = JSON.parse(text)
				if (isRecord(json) && Array.isArray(json.errors)) {
					const first: unknown = json.errors[0]
					if (isRecord(first) && typeof first.message === 'string') message = first.message
				}
			} catch {
				// Non-JSON errors retain the HTTP status and upstream body.
			}
			if (response.status === 404 && path.startsWith('logs/')) throw new AiGatewayLogNotFound(message)
			throw new AiGatewayInternalError(message)
		}
		try {
			const json: unknown = await response.json()
			return envelopeResult(json)
		} catch (error) {
			throw new AiGatewayInternalError(error instanceof Error ? error.message : String(error))
		}
	}

	async getUrl(provider = 'universal'): Promise<string> {
		const result = await this.apiRequest(`url/${encodeURIComponent(identifier(provider, 'provider'))}`)
		// The public REST API returns a string; workerd's private binding API wraps it in { url }.
		return stringField(result, 'AI Gateway URL')
	}

	async getLog(logId: string): Promise<GatewayLog> {
		return parseGatewayLog(await this.apiRequest(`logs/${encodeURIComponent(identifier(logId, 'logId'))}`))
	}

	async patchLog(logId: string, data: GatewayPatchLog): Promise<void> {
		await this.apiRequest(`logs/${encodeURIComponent(identifier(logId, 'logId'))}`, 'PATCH', parsePatchLog(data))
	}

	async run(data: GatewayRequest | GatewayRequest[], options: GatewayRunOptions = {}): Promise<Response> {
		const { accountId, apiToken } = this.credentials()
		const requests = (Array.isArray(data) ? data : [data]).map(parseGatewayRequest)
		if (requests.length === 0) throw new TypeError('AI Gateway requires at least one request')
		const parsedOptions = parseGatewayRunOptions(options)
		const headers = gatewayHeaders(parsedOptions.gateway)
		for (const [key, value] of Object.entries(parsedOptions.extraHeaders ?? {})) headers.set(key, value)
		headers.set('cf-aig-authorization', `Bearer ${apiToken}`)
		const streaming = requests.some(request => isRecord(request.query) && request.query.stream === true)
		const model = requests.map(request => `${request.provider}/${request.endpoint}`).join(', ')
		return logRequest(this.db, model, requests.map(({ provider, endpoint, query }) => ({ provider, endpoint, query })), streaming, async () => {
			const response = await fetch(`https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(this.id)}`, {
				method: 'POST',
				headers,
				body: JSON.stringify(requests),
				signal: parsedOptions.signal,
			})
			return { value: response, summary: streaming ? '<streaming>' : '<raw response>', error: response.ok ? undefined : `HTTP ${response.status}` }
		})
	}
}
