/**
 * Local implementation of the Cloudflare AI Search namespace binding
 * (`ai_search_namespaces`).
 *
 * Running vector search + RAG locally is impractical, so this binding
 * proxies to the real Cloudflare AI Search REST API — same strategy as
 * `AiBinding`. Every proxied call is logged to SQLite for the dashboard.
 *
 * Requires `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in `.dev.vars`
 * or the environment.
 */
import { randomUUIDv7 } from 'bun'
import type { Database } from 'bun:sqlite'

const MAX_LOG_SIZE = 1024

function truncate(value: unknown): string {
	const str = typeof value === 'string' ? value : JSON.stringify(value)
	if (!str) return ''
	return str.length > MAX_LOG_SIZE ? str.slice(0, MAX_LOG_SIZE) + '…' : str
}

function isEnvelope(json: unknown): json is { success: boolean; result: unknown } {
	return typeof json === 'object' && json !== null && 'success' in json && 'result' in json
}

interface CreateInstanceOptions {
	id: string
	type?: string
	source?: unknown
}

interface SearchOptions {
	messages: { role: string; content: string }[]
	ai_search_options?: {
		instance_ids?: string[]
		[key: string]: unknown
	}
	stream?: boolean
	[key: string]: unknown
}

export class AiSearchInstance {
	private readonly binding: AiSearchNamespaceBinding
	readonly id: string
	readonly metadata: Record<string, unknown>

	constructor(binding: AiSearchNamespaceBinding, id: string, metadata: Record<string, unknown> = {}) {
		this.binding = binding
		this.id = id
		this.metadata = metadata
	}

	async search(options: SearchOptions): Promise<unknown> {
		return this.binding._proxyInstance('search', this.id, options)
	}

	async chatCompletions(options: SearchOptions): Promise<unknown> {
		return this.binding._proxyInstance('chatCompletions', this.id, options)
	}

	async info(): Promise<unknown> {
		return this.binding._instanceInfo(this.id)
	}
}

export class AiSearchNamespaceBinding {
	private readonly db: Database
	private readonly namespace: string
	private readonly accountId?: string
	private readonly apiToken?: string

	constructor(db: Database, namespace: string, accountId?: string, apiToken?: string) {
		this.db = db
		this.namespace = namespace
		this.accountId = accountId
		this.apiToken = apiToken
	}

	private ensureCredentials(): { accountId: string; apiToken: string } {
		if (!this.accountId || !this.apiToken) {
			throw new Error(
				'AI Search requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in .dev.vars',
			)
		}
		return { accountId: this.accountId, apiToken: this.apiToken }
	}

	async create(opts: CreateInstanceOptions): Promise<AiSearchInstance> {
		const result = await this.proxy('POST', '/ai-search/instances', opts, 'create')
		return new AiSearchInstance(this, opts.id, (result as Record<string, unknown> | null) ?? {})
	}

	/**
	 * Synchronous, like workers-types' `AiSearchNamespace.get()`: no request is made,
	 * so a missing instance surfaces on the first call made through the handle.
	 */
	get(id: string): AiSearchInstance {
		return new AiSearchInstance(this, id)
	}

	async list(opts?: Record<string, string>): Promise<unknown> {
		const query = opts ? '?' + new URLSearchParams(opts).toString() : ''
		return this.proxy('GET', `/ai-search/instances${query}`, undefined, 'list')
	}

	async delete(id: string): Promise<boolean> {
		await this.proxy('DELETE', `/ai-search/instances/${encodeURIComponent(id)}`, undefined, 'delete')
		return true
	}

	async search(options: SearchOptions): Promise<unknown> {
		return this.proxy('POST', `/ai-search/namespaces/${encodeURIComponent(this.namespace)}/search`, options, 'search')
	}

	async chatCompletions(options: SearchOptions): Promise<unknown> {
		return this.proxy(
			'POST',
			`/ai-search/namespaces/${encodeURIComponent(this.namespace)}/chat/completions`,
			options,
			'chatCompletions',
		)
	}

	/** @internal — called by AiSearchInstance */
	async _instanceInfo(instanceId: string): Promise<unknown> {
		return this.proxy('GET', `/ai-search/instances/${encodeURIComponent(instanceId)}`, undefined, 'instance.info')
	}

	/** @internal — called by AiSearchInstance */
	async _proxyInstance(method: 'search' | 'chatCompletions', instanceId: string, options: SearchOptions): Promise<unknown> {
		const path = method === 'search'
			? `/ai-search/instances/${encodeURIComponent(instanceId)}/search`
			: `/ai-search/instances/${encodeURIComponent(instanceId)}/chat/completions`
		return this.proxy('POST', path, options, `instance.${method}`)
	}

	private async proxy(
		httpMethod: string,
		apiPath: string,
		body: unknown,
		operation: string,
	): Promise<unknown> {
		const { accountId, apiToken } = this.ensureCredentials()
		const id = randomUUIDv7()
		const start = Date.now()
		let status = 'ok'
		let error: string | undefined
		let outputSummary = ''

		try {
			const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}${apiPath}`
			const response = await fetch(url, {
				method: httpMethod,
				headers: {
					Authorization: `Bearer ${apiToken}`,
					'Content-Type': 'application/json',
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			})

			if (!response.ok) {
				const text = await response.text()
				status = 'error'
				error = `HTTP ${response.status}: ${text}`
				throw new Error(error)
			}

			if ((body as SearchOptions | undefined)?.stream) {
				outputSummary = '<streaming>'
				return response.body
			}

			const ct = response.headers.get('content-type') ?? ''
			if (ct.includes('application/json')) {
				const json = await response.json()
				outputSummary = truncate(json)
				// The binding resolves to the payload itself, not the REST envelope
				// (`{ success, errors, messages, result }`) the API wraps it in.
				return isEnvelope(json) ? json.result : json
			}
			const text = await response.text()
			outputSummary = truncate(text)
			return text
		} catch (err) {
			if (status !== 'error') {
				status = 'error'
				error = err instanceof Error ? err.message : String(err)
			}
			throw err
		} finally {
			const duration = Date.now() - start
			this.db
				.prepare(
					`INSERT INTO ai_search_requests (id, namespace, operation, input_summary, output_summary, duration_ms, status, error, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(id, this.namespace, operation, truncate(body), outputSummary, duration, status, error ?? null, start)
		}
	}
}
