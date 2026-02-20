import type { Plugin } from 'vite'

let initialized = false

/**
 * Sets up global Cloudflare-compatible APIs in the Bun process:
 * caches, HTMLRewriter, WebSocketPair, IdentityTransformStream, FixedLengthStream,
 * navigator.userAgent, scheduler.wait(), crypto extensions.
 *
 * Runs once on configureServer (before middleware), idempotent.
 * Imports are lazy because the plugin is externalized by Vite's config bundler —
 * dynamic imports run at dev server startup time through Bun's native loader.
 */
export function globalsPlugin(): Plugin {
	return {
		name: 'bunflare:globals',

		async configureServer() {
			if (initialized) return
			initialized = true

			const { SqliteCacheStorage } = await import('../bindings/cache.ts')
			const { HTMLRewriter } = await import('../bindings/html-rewriter.ts')
			const { WebSocketPair } = await import('../bindings/websocket-pair.ts')
			const { IdentityTransformStream, FixedLengthStream } = await import('../bindings/cf-streams.ts')
			const { patchGlobalCrypto } = await import('../bindings/crypto-extras.ts')
			const { getDatabase } = await import('../db.ts')
			const { instrumentBinding } = await import('../tracing/instrument.ts')

			// Global caches (CacheStorage)
			const cacheMethods = ['match', 'put', 'delete']
			const rawCacheStorage = new SqliteCacheStorage(getDatabase())
			rawCacheStorage.default = instrumentBinding(rawCacheStorage.default, {
				type: 'cache',
				name: 'default',
				methods: cacheMethods,
			}) as typeof rawCacheStorage.default

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

			Object.defineProperty(globalThis, 'HTMLRewriter', {
				value: HTMLRewriter,
				writable: false,
				configurable: true,
			})

			Object.defineProperty(globalThis, 'WebSocketPair', {
				value: WebSocketPair,
				writable: false,
				configurable: true,
			})

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

			patchGlobalCrypto()

			Object.defineProperty(globalThis.navigator, 'userAgent', {
				value: 'Cloudflare-Workers',
				writable: false,
				configurable: true,
			})

			Object.defineProperty(globalThis, 'scheduler', {
				value: {
					wait(ms: number): Promise<void> {
						return new Promise((resolve) => setTimeout(resolve, ms))
					},
				},
				writable: false,
				configurable: true,
			})
		},
	}
}
