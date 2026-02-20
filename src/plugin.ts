import { plugin } from 'bun'
import type { BrowserBinding } from './bindings/browser'
import { SqliteCacheStorage } from './bindings/cache'
import { FixedLengthStream, IdentityTransformStream } from './bindings/cf-streams'
import { ContainerBase, getContainer, getRandom } from './bindings/container'
import { patchGlobalCrypto } from './bindings/crypto-extras'
import { DurableObjectBase, WebSocketRequestResponsePair } from './bindings/durable-object'
import { EmailMessage } from './bindings/email'
import { HTMLRewriter } from './bindings/html-rewriter'
import { WebSocketPair } from './bindings/websocket-pair'
import { NonRetryableError, WorkflowEntrypointBase } from './bindings/workflow'
import { getDatabase } from './db'
import { globalEnv } from './env'
import { getActiveExecutionContext } from './execution-context'
import { getActiveContext } from './tracing/context'
import { instrumentBinding } from './tracing/instrument'
import { addSpanEvent, setSpanAttribute, startSpan } from './tracing/span'

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

const _originalFetch = globalThis.fetch
globalThis.fetch = ((input: any, init?: any): Promise<Response> => {
	const ctx = getActiveContext()
	if (ctx) {
		ctx.fetchStack.current = new Error()
	}
	// Outside a trace context, just pass through
	if (!ctx) return _originalFetch(input, init)

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

		const response = await _originalFetch(fetchRequest as globalThis.Request)

		setSpanAttribute('http.status_code', response.status)
		setSpanAttribute('http.response.headers', headersToRecord(response.headers))

		// Capture response body from a clone (caller keeps the original stream)
		const resBody = await readBodyLimited(response.clone())
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
