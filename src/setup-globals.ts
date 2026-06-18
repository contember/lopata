import { SqliteCacheStorage } from './bindings/cache'
import { FixedLengthStream, IdentityTransformStream } from './bindings/cf-streams'
import { patchGlobalCrypto } from './bindings/crypto-extras'
import { WebSocketRequestResponsePair } from './bindings/durable-object'
import { HTMLRewriter } from './bindings/html-rewriter'
import { WebSocketPair } from './bindings/websocket-pair'
import { getDatabase } from './db'
import { instrumentBinding } from './tracing/instrument'

let initialized = false

/**
 * Sets up global Cloudflare-compatible APIs:
 * caches, HTMLRewriter, WebSocketPair, IdentityTransformStream, FixedLengthStream,
 * navigator.userAgent, navigator.language, performance.timeOrigin, scheduler.wait(),
 * and crypto extensions.
 *
 * Custom user spans are provided via the Cloudflare-native `tracing.enterSpan`
 * API exported from `cloudflare:workers` (see src/virtual-modules.ts), not a
 * Lopata-specific global.
 *
 * Idempotent — safe to call multiple times.
 */
export function setupCloudflareGlobals() {
	if (initialized) return
	initialized = true

	// Register global `caches` object (CacheStorage) with tracing.
	// Lazy: only creates the SqliteCacheStorage (and its getDatabase() call) on first access.
	let _cacheStorage: SqliteCacheStorage | null = null
	const cacheMethods = ['match', 'put', 'delete']
	function getCacheStorage(): SqliteCacheStorage {
		if (!_cacheStorage) {
			_cacheStorage = new SqliteCacheStorage(getDatabase())
			_cacheStorage.default = instrumentBinding(_cacheStorage.default, {
				type: 'cache',
				name: 'default',
				methods: cacheMethods,
			}) as typeof _cacheStorage.default
			const originalOpen = _cacheStorage.open.bind(_cacheStorage)
			_cacheStorage.open = async (cacheName: string) => {
				const cache = await originalOpen(cacheName)
				return instrumentBinding(cache, {
					type: 'cache',
					name: cacheName,
					methods: cacheMethods,
				})
			}
		}
		return _cacheStorage
	}

	Object.defineProperty(globalThis, 'caches', {
		get: () => getCacheStorage(),
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

	// Register global `WebSocketRequestResponsePair` class (used by DO hibernation API)
	Object.defineProperty(globalThis, 'WebSocketRequestResponsePair', {
		value: WebSocketRequestResponsePair,
		writable: false,
		configurable: true,
	})

	// Patch Response to preserve CF-specific `webSocket` property from init
	const OriginalResponse = globalThis.Response
	globalThis.Response = class extends OriginalResponse {
		webSocket?: InstanceType<typeof WebSocketPair>[0]

		constructor(body?: any, init?: ResponseInit & { webSocket?: InstanceType<typeof WebSocketPair>[0] }) {
			super(body, init)
			if (init && 'webSocket' in init) {
				this.webSocket = init.webSocket
			}
		}
	}

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
