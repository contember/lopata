import { SqliteCacheStorage } from './bindings/cache'
import { FixedLengthStream, IdentityTransformStream } from './bindings/cf-streams'
import { patchGlobalCrypto } from './bindings/crypto-extras'
import { HTMLRewriter } from './bindings/html-rewriter'
import { WebSocketPair } from './bindings/websocket-pair'
import { getDatabase } from './db'
import { instrumentBinding } from './tracing/instrument'
import { addSpanEvent, setSpanAttribute, startSpan } from './tracing/span'

let initialized = false

/**
 * Sets up global Cloudflare-compatible APIs:
 * caches, HTMLRewriter, WebSocketPair, IdentityTransformStream, FixedLengthStream,
 * navigator.userAgent, navigator.language, performance.timeOrigin, scheduler.wait(),
 * crypto extensions, and __lopata userland tracing API.
 *
 * Idempotent — safe to call multiple times.
 */
export function setupCloudflareGlobals() {
	if (initialized) return
	initialized = true // ─── Userland tracing API ────────────────────────────────────────────
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
}
