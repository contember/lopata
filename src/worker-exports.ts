/**
 * The current thread's `ctx.exports` — also what `import { exports } from
 * 'cloudflare:workers'` resolves to. Kept as one object mutated in place (like
 * `globalEnv`) because the module import binds to it before the worker module loads.
 */
export const globalExports: Record<string, unknown> = {}

export function setGlobalExports(exports: Record<string, unknown>): void {
	for (const key of Object.keys(globalExports)) {
		delete globalExports[key]
	}
	Object.assign(globalExports, exports)
}
