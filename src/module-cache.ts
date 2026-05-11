import path from 'node:path'

interface ModuleRegistry {
	registry: Map<unknown, unknown>
}

interface BunGlobal {
	Loader?: ModuleRegistry
}

let warnedMissingRegistry = false

/**
 * Invalidate the JavaScriptCore module registry for user-code files under
 * `baseDir`, excluding `node_modules`. This forces Bun to re-read and
 * re-evaluate every transitive dep on the next import.
 *
 * Why: lopata reloads the worker via `await import('<entry>?v=<ts>')`. That
 * query-string trick only invalidates the entry — Bun's module registry is
 * keyed by resolved specifier, so static imports inside the entry continue
 * to resolve to the originally cached transitive modules. Without this
 * call, edits to any file other than the entry itself silently no-op
 * across reloads (the watcher fires, `[lopata] Reloaded` prints, but the
 * active worker still references the old module graph).
 *
 * Caveats:
 *   - Uses `globalThis.Loader`, an undocumented JSC/Bun internal. If Bun
 *     ever renames or removes it, hot-reload regresses to the prior
 *     entry-only behavior — `tests/hmr-e2e.test.ts` "transitive dep
 *     change" cases will catch the regression.
 *   - `node_modules` paths are skipped so dependency imports stay cached
 *     across reloads (re-evaluating them every save would be slow and
 *     pointless — they don't change in a dev session).
 */
export function invalidateUserModules(baseDir: string): void {
	const loader = (globalThis as unknown as BunGlobal).Loader
	if (!loader?.registry) {
		if (!warnedMissingRegistry) {
			warnedMissingRegistry = true
			console.warn(
				'[lopata] globalThis.Loader.registry not available — transitive hot-reload is disabled. '
					+ 'Edits to files other than the worker entrypoint will require a manual restart.',
			)
		}
		return
	}

	const prefix = path.resolve(baseDir) + path.sep
	const nodeModulesSegment = `${path.sep}node_modules${path.sep}`
	for (const key of [...loader.registry.keys()]) {
		if (typeof key !== 'string') continue
		// Strip query string (e.g. `?v=<ts>`) before comparing with disk paths.
		const pathPart = key.split('?')[0] ?? key
		if (!pathPart.startsWith(prefix)) continue
		if (pathPart.includes(nodeModulesSegment)) continue
		loader.registry.delete(key)
	}
}
