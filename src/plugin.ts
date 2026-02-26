import { plugin } from 'bun'
import type { BrowserBinding } from './bindings/browser'
import { SqliteCacheStorage } from './bindings/cache'
import { FixedLengthStream, IdentityTransformStream } from './bindings/cf-streams'
import { ContainerBase, getContainer, getRandom } from './bindings/container'
import { patchGlobalCrypto } from './bindings/crypto-extras'
import { DurableObjectBase, WebSocketRequestResponsePair } from './bindings/durable-object'
import { EmailMessage } from './bindings/email'
import { HTMLRewriter } from './bindings/html-rewriter'
import type { ImageTransformOptions, OutputOptions } from './bindings/images'
import { WebSocketPair } from './bindings/websocket-pair'
import { NonRetryableError, WorkflowEntrypointBase } from './bindings/workflow'
import { getDatabase } from './db'
import { globalEnv } from './env'
import { getActiveExecutionContext } from './execution-context'
import { getActiveContext } from './tracing/context'
import { instrumentBinding } from './tracing/instrument'
import { addSpanEvent, persistError, setSpanAttribute, startSpan } from './tracing/span'

// ─── Userland tracing API ────────────────────────────────────────────
// Exposes a lightweight global that user code can call to create custom
// spans visible in the Lopata dashboard.  In production (without Lopata)
// the global is simply absent, so the user's thin wrapper becomes a no-op.

;(globalThis as any).__lopata = {
	trace<T>(name: string, attrsOrFn: Record<string, unknown> | (() => T | Promise<T>), maybeFn?: () => T | Promise<T>): Promise<T> {
		const fn = typeof attrsOrFn === 'function' ? attrsOrFn : maybeFn!
		const attributes = typeof attrsOrFn === 'function' ? undefined : attrsOrFn
		return startSpan({ name, attributes }, fn)
	},
	setAttribute: setSpanAttribute,
	addEvent(name: string, message?: string, attrs?: Record<string, unknown>): void {
		addSpanEvent(name, 'info', message ?? '', attrs)
	},
}

// Register global `caches` object (CacheStorage) with tracing
const rawCacheStorage = new SqliteCacheStorage(getDatabase())
const cacheMethods = ['match', 'put', 'delete']

// Instrument the default cache
rawCacheStorage.default = instrumentBinding(rawCacheStorage.default, {
	type: 'cache',
	name: 'default',
	methods: cacheMethods,
}) as typeof rawCacheStorage.default

// Wrap open() to return instrumented caches
const originalOpen = rawCacheStorage.open.bind(rawCacheStorage)
rawCacheStorage.open = async (cacheName: string) => {
	const cache = await originalOpen(cacheName)
	return instrumentBinding(cache, {
		type: 'cache',
		name: cacheName,
		methods: cacheMethods,
	})
}

Object.defineProperty(globalThis, 'caches', {
	value: rawCacheStorage,
	writable: false,
	configurable: true,
})

// Register global `HTMLRewriter` class
Object.defineProperty(globalThis, 'HTMLRewriter', {
	value: HTMLRewriter,
	writable: false,
	configurable: true,
})

// Register global `WebSocketPair` class
Object.defineProperty(globalThis, 'WebSocketPair', {
	value: WebSocketPair,
	writable: false,
	configurable: true,
})

// Register global CF stream classes
Object.defineProperty(globalThis, 'IdentityTransformStream', {
	value: IdentityTransformStream,
	writable: false,
	configurable: true,
})

Object.defineProperty(globalThis, 'FixedLengthStream', {
	value: FixedLengthStream,
	writable: false,
	configurable: true,
})

// Patch crypto with CF-specific extensions (timingSafeEqual, DigestStream)
patchGlobalCrypto()

// Set navigator.userAgent to match Cloudflare Workers
Object.defineProperty(globalThis.navigator, 'userAgent', {
	value: 'Cloudflare-Workers',
	writable: false,
	configurable: true,
})

// Set navigator.language (behind enable_navigator_language compat flag in CF)
if (!globalThis.navigator.language) {
	Object.defineProperty(globalThis.navigator, 'language', {
		value: 'en',
		writable: false,
		configurable: true,
	})
}

// Set performance.timeOrigin to 0 (CF semantics)
Object.defineProperty(globalThis.performance, 'timeOrigin', {
	value: 0,
	writable: false,
	configurable: true,
})

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

// Register scheduler.wait(ms) — await-able setTimeout alternative
Object.defineProperty(globalThis, 'scheduler', {
	value: {
		wait(ms: number): Promise<void> {
			return new Promise((resolve) => setTimeout(resolve, ms))
		},
	},
	writable: false,
	configurable: true,
})

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
// Creates a tracing span for every outgoing fetch and captures request/response bodies.
// Also captures call-site stacks for async stack reconstruction (see stitchAsyncStack).

const MAX_BODY_CAPTURE = 128 * 1024 // 128 KB
const TEXT_TYPES = [
	'application/json',
	'text/',
	'application/xml',
	'application/javascript',
	'application/x-www-form-urlencoded',
	'application/graphql',
]

function isTextContent(ct: string | null): boolean {
	if (!ct) return true // no content-type → assume text
	return TEXT_TYPES.some(t => ct.includes(t))
}

function headersToRecord(h: Headers): Record<string, string> {
	const obj: Record<string, string> = {}
	h.forEach((v, k) => {
		obj[k] = v
	})
	return obj
}

async function readBodyLimited(r: Request | Response): Promise<string | null> {
	if (!r.body) return null
	const ct = r.headers.get('content-type')
	const cl = r.headers.get('content-length')
	const size = cl ? parseInt(cl, 10) : null
	if (!isTextContent(ct)) {
		return size != null ? `[binary ${ct}: ${size} bytes]` : `[binary: ${ct ?? 'unknown'}]`
	}
	if (size != null && size > MAX_BODY_CAPTURE) {
		return `[body too large: ${size} bytes]`
	}
	try {
		const text = await r.text()
		return text.length > MAX_BODY_CAPTURE
			? text.slice(0, MAX_BODY_CAPTURE) + '… [truncated]'
			: text || null
	} catch {
		return null
	}
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
	const fetchRequest = request.clone()
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
		// Capture request body (from the original — fetchRequest is sent to the network)
		const reqBody = await readBodyLimited(request)
		if (reqBody) setSpanAttribute('http.request.body', reqBody)

		let response = await _originalFetch(fetchRequest as globalThis.Request)

		// Apply cf.image transform if present
		if (cfImageOpts) {
			response = await applyCfImageTransform(response, cfImageOpts)
		}

		setSpanAttribute('http.status_code', response.status)
		setSpanAttribute('http.response.headers', headersToRecord(response.headers))

		// Capture response body from a clone (caller keeps the original stream)
		const resBody = await readBodyLimited(response.clone() as Response)
		if (resBody) setSpanAttribute('http.response.body', resBody)

		return response
	})
}) as typeof globalThis.fetch

plugin({
	name: 'cloudflare-workers-shim',
	setup(build) {
		build.module('cloudflare:workers', () => {
			// Use a getter so `env` always returns the latest built env object
			return {
				exports: {
					DurableObject: DurableObjectBase,
					WorkflowEntrypoint: WorkflowEntrypointBase,
					WorkerEntrypoint: class WorkerEntrypoint {
						protected ctx: unknown
						protected env: unknown
						constructor(ctx: unknown, env: unknown) {
							this.ctx = ctx
							this.env = env
							;(this as any)[Symbol.for('lopata.RpcTarget')] = true
						}
					},
					WebSocketRequestResponsePair,
					WebSocketPair,
					RpcTarget: class RpcTarget {
						constructor() {
							;(this as any)[Symbol.for('lopata.RpcTarget')] = true
						}
					},
					env: globalEnv,
					waitUntil(promise: Promise<unknown>): void {
						const ctx = getActiveExecutionContext()
						if (ctx) {
							ctx.waitUntil(promise)
						}
					},
				},
				loader: 'object',
			}
		})

		build.module('@cloudflare/containers', () => {
			return {
				exports: {
					Container: ContainerBase,
					getContainer,
					getRandom,
					switchPort(request: Request, port: number): Request {
						const headers = new Headers(request.headers)
						headers.set('cf-container-target-port', port.toString())
						return new Request(request, { headers })
					},
					loadBalance: getRandom,
				},
				loader: 'object',
			}
		})

		build.module('cloudflare:email', () => {
			return {
				exports: {
					EmailMessage,
				},
				loader: 'object',
			}
		})

		build.module('cloudflare:workflows', () => {
			return {
				exports: {
					NonRetryableError,
				},
				loader: 'object',
			}
		})

		build.module('@cloudflare/puppeteer', () => {
			return {
				exports: {
					default: {
						launch: (endpoint: BrowserBinding, opts?: { keep_alive?: number }) => endpoint.launch(opts),
						connect: (endpoint: BrowserBinding, sessionId: string) => endpoint.connect(sessionId),
						sessions: (endpoint: BrowserBinding) => endpoint.sessions(),
					},
					ActiveSession: {} as any, // type-only re-export placeholder
				},
				loader: 'object',
			}
		})
	},
})
