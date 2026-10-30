import { plugin } from 'bun'
import type { Database } from 'bun:sqlite'
import { buildAnalyticsEngineSqlResponse, isAnalyticsEngineSqlUrl, isLocalAnalyticsEngineToken } from './bindings/analytics-engine-sql'
import type { ImageTransformOptions, OutputOptions } from './bindings/images'
import { setupCloudflareGlobals } from './setup-globals'
import { getActiveContext } from './tracing/context'
import { addSpanEvent, persistError, setSpanAttribute, startSpan } from './tracing/span'
import { registerVirtualModules } from './virtual-modules'

setupCloudflareGlobals()

// Register addEventListener shim for legacy service worker syntax
// Workers that use addEventListener("fetch", handler) instead of export default { fetch }
const _serviceWorkerHandlers: { fetch?: (event: any) => void } = {}

Object.defineProperty(globalThis, 'addEventListener', {
	value: (type: string, handler: (event: any) => void) => {
		if (type === 'fetch') {
			_serviceWorkerHandlers.fetch = handler
		}
	},
	writable: false,
	configurable: true,
}) /** @internal Get the registered service worker fetch handler */
;(globalThis as any).__lopata_sw_handlers = _serviceWorkerHandlers

/** The fetch handler registered via the legacy `addEventListener('fetch', …)`
 *  service-worker syntax, if any. The worker-thread runtime falls back to this
 *  when the module has no `export default { fetch }`. */
export function getServiceWorkerFetchHandler(): ((event: unknown) => void) | undefined {
	return _serviceWorkerHandlers.fetch
}

// ─── Console instrumentation ─────────────────────────────────────────
// Captures console.log/info/warn/error/debug as span events when inside a trace context.

function formatConsoleArg(arg: unknown): string {
	if (typeof arg === 'string') return arg
	if (arg instanceof Error) return arg.stack ?? arg.message
	try {
		return JSON.stringify(arg)
	} catch {
		return String(arg)
	}
}

const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const
type ConsoleMethod = (typeof consoleMethods)[number]

const _originalConsole: Record<ConsoleMethod, (...args: unknown[]) => void> = {} as any

for (const method of consoleMethods) {
	// biome-ignore lint/suspicious/noConsole: console interception shim
	_originalConsole[method] = console[method].bind(console)
	;(console as any)[method] = (...args: unknown[]) => {
		_originalConsole[method](...args)
		const ctx = getActiveContext()
		if (!ctx) return
		const message = args.map(formatConsoleArg).join(' ')
		addSpanEvent(`console.${method}`, method, message)
		if (method === 'error') {
			const errorArg = args.find((a) => a instanceof Error)
			persistError(errorArg ?? new Error(message), 'console.error')
		}
	}
}

// ─── Fetch instrumentation ───────────────────────────────────────────
// Creates a tracing span for every outgoing fetch and captures HTTP metadata.
// Also captures call-site stacks for async stack reconstruction (see stitchAsyncStack).

function headersToRecord(h: Headers): Record<string, string | string[]> {
	const obj: Record<string, string | string[]> = {}
	h.forEach((v, k) => {
		if (k === 'set-cookie') return // handled below — a keyed record would keep only the last cookie
		obj[k] = v
	})
	const setCookie = h.getSetCookie()
	if (setCookie.length > 0) {
		obj['set-cookie'] = setCookie
	}
	return obj
}

/** Apply cf.image transform to a fetch response */
async function applyCfImageTransform(response: Response, imageOpts: Record<string, unknown>): Promise<Response> {
	const ct = response.headers.get('content-type') ?? ''
	if (!ct.startsWith('image/') || !response.body) return response

	const { ImagesBinding } = await import('./bindings/images')
	const images = new ImagesBinding()

	// Split cf.image options into transform options and output options
	const { format: rawFormat, quality, compression, metadata, ...transformRest } = imageOpts
	const transformer = images.input(response.body).transform(transformRest as ImageTransformOptions)

	// Determine output format
	let outputFormat: OutputOptions['format'] = ct as OutputOptions['format']
	if (rawFormat && rawFormat !== 'auto') {
		const shortToMime: Record<string, OutputOptions['format']> = {
			avif: 'image/avif',
			webp: 'image/webp',
			jpeg: 'image/jpeg',
			png: 'image/png',
			gif: 'image/gif',
		}
		outputFormat = shortToMime[rawFormat as string] ?? outputFormat
	}
	// Fallback to a valid format if the source CT isn't in our supported set
	if (!['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif'].includes(outputFormat)) {
		outputFormat = 'image/webp'
	}

	const outputOpts: OutputOptions = { format: outputFormat }
	if (rawFormat === 'auto') {
		// Pass format through transform-level auto detection
		;(transformRest as ImageTransformOptions).format = 'auto'
	}
	if (quality !== undefined) outputOpts.quality = quality as OutputOptions['quality']
	if (compression !== undefined) outputOpts.compression = compression as OutputOptions['compression']
	if (metadata !== undefined) outputOpts.metadata = metadata as OutputOptions['metadata']

	const result = await transformer.output(outputOpts)
	const headers = new Headers(response.headers)
	headers.set('content-type', result.contentType())
	headers.delete('content-length') // size changed after transform
	return new Response(result.image(), { status: response.status, statusText: response.statusText, headers })
}

const _originalFetch = globalThis.fetch
globalThis.fetch = ((input: any, init?: any): Promise<Response> => {
	// Intercept the Cloudflare Analytics Engine SQL API (no Worker binding exists
	// for reads) and serve it from the local SQLite store — same code runs in dev
	// and prod unchanged.
	const aeMethod = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
	const aeUrl = typeof input === 'string'
		? input
		: input instanceof URL
		? input.href
		: input instanceof Request
		? input.url
		: undefined
	// Gate on the bearer token: missing or `Bearer local` is served locally; a real
	// token falls through to the actual Cloudflare API (prod).
	const aeAuth = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('authorization')
	if (aeMethod === 'POST' && typeof aeUrl === 'string' && isAnalyticsEngineSqlUrl(aeUrl) && isLocalAnalyticsEngineToken(aeAuth)) {
		// Set per worker-thread by buildThreadEnv / buildDoWorkerEnv before user code
		// runs. Fail loudly rather than fall back to a possibly-wrong data dir, which
		// would return plausible but incorrect numbers.
		const db = (globalThis as { __lopata_db?: Database }).__lopata_db
		if (!db) throw new Error('Analytics Engine SQL API was intercepted before the worker-thread database was wired')
		const aeReq = new Request(input, init)
		if (!getActiveContext()) return aeReq.text().then(sql => buildAnalyticsEngineSqlResponse(db, sql))
		return startSpan({
			name: 'analytics_engine sql',
			kind: 'client',
			attributes: { 'http.method': 'POST', 'http.url': aeUrl },
		}, async () => {
			const sql = (await aeReq.text()).trim()
			if (sql) setSpanAttribute('db.statement', sql)
			const res = buildAnalyticsEngineSqlResponse(db, sql)
			setSpanAttribute('http.status_code', res.status)
			return res
		})
	}

	const ctx = getActiveContext()
	if (ctx) {
		ctx.fetchStack.current = new Error()
	}

	// Extract cf.image options before creating request (Request constructor drops cf)
	const cfImageOpts = init?.cf?.image as Record<string, unknown> | undefined

	// Outside a trace context, handle cf.image without tracing
	if (!ctx) {
		const p = _originalFetch(input, init)
		return cfImageOpts ? p.then(r => applyCfImageTransform(r, cfImageOpts)) : p
	}

	const request = new Request(input, init)
	const url = request.url
	const method = request.method
	let pathname: string
	try {
		pathname = new URL(url).pathname
	} catch {
		pathname = url
	}

	return startSpan({
		name: `fetch ${method} ${pathname}`,
		kind: 'client',
		attributes: {
			'http.method': method,
			'http.url': url,
			'http.request.headers': headersToRecord(request.headers),
		},
	}, async () => {
		let response = await _originalFetch(request)

		// Apply cf.image transform if present
		if (cfImageOpts) {
			response = await applyCfImageTransform(response, cfImageOpts)
		}

		setSpanAttribute('http.status_code', response.status)
		setSpanAttribute('http.response.headers', headersToRecord(response.headers))

		return response
	})
}) as typeof globalThis.fetch

plugin({
	name: 'cloudflare-workers-shim',
	setup(build) {
		registerVirtualModules(build)
	},
})
