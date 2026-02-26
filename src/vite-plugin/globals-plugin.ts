import type { Plugin } from 'vite'

let initialized = false

/**
 * Sets up global Cloudflare-compatible APIs in the Bun process.
 *
 * Runs once on configureServer (before middleware), idempotent.
 * Uses dynamic import because the plugin file is externalized by Vite's config bundler —
 * the import runs at dev server startup time through Bun's native loader.
 */
export function globalsPlugin(): Plugin {
	return {
		name: 'lopata:globals',

		async configureServer() {
			if (initialized) return
			initialized = true

			const { setupCloudflareGlobals } = await import('../setup-globals.ts')
			setupCloudflareGlobals()
		},
	}
}
