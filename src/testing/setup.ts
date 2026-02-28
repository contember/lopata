import { plugin } from 'bun'
import type { SqliteCacheStorage } from '../bindings/cache'
import { setupCloudflareGlobals } from '../setup-globals'
import { registerVirtualModules } from '../virtual-modules'

/**
 * Mutable ref for per-test caches instance.
 * Set by `createTestEnv()`, cleared by `dispose()`.
 * The `caches` global getter reads from this ref.
 */
export const testCachesRef: { current: SqliteCacheStorage | null } = { current: null }

let initialized = false

/**
 * Sets up the test environment:
 * - Registers cloudflare:* virtual modules via Bun.plugin
 * - Sets up global Cloudflare APIs (HTMLRewriter, WebSocketPair, crypto, etc.)
 * - Overrides `caches` global to use in-memory storage from testCachesRef
 *
 * Idempotent — safe to call multiple times.
 */
export function setupTestEnv() {
	if (initialized) return
	initialized = true

	setupCloudflareGlobals()

	// Override caches to use the per-test in-memory ref instead of filesystem
	Object.defineProperty(globalThis, 'caches', {
		get: () => {
			if (!testCachesRef.current) {
				throw new Error('caches is not available — call createTestEnv() first')
			}
			return testCachesRef.current
		},
		configurable: true,
	})

	plugin({
		name: 'cloudflare-workers-test-shim',
		setup(build) {
			registerVirtualModules(build)
		},
	})
}

// Auto-run on import (preload behavior)
setupTestEnv()
