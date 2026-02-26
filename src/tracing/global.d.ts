/**
 * Lopata userland tracing API.
 *
 * Available on `globalThis.__lopata` when running under Lopata dev server.
 * In production (Cloudflare Workers) the global is `undefined` — wrap calls
 * in a thin helper that falls back to a no-op:
 *
 * ```ts
 * // app/lib/trace.ts
 * type TraceFn = <T>(name: string, fn: () => T | Promise<T>) => Promise<T>
 *
 * export const trace: TraceFn = (name, fn) =>
 *   globalThis.__lopata?.trace(name, fn) ?? fn()
 *
 * export const setAttribute = (key: string, value: unknown) =>
 *   globalThis.__lopata?.setAttribute(key, value)
 *
 * export const addEvent = (name: string, message?: string) =>
 *   globalThis.__lopata?.addEvent(name, message)
 * ```
 *
 * Add this file to your tsconfig types to get autocomplete:
 * ```json
 * { "compilerOptions": { "types": ["lopata/src/tracing/global"] } }
 * ```
 */

interface LopataTracing {
	/**
	 * Create a traced span around `fn`. The span is visible in the Lopata
	 * dashboard and becomes a child of the currently active span (if any).
	 */
	trace<T>(name: string, fn: () => T | Promise<T>): Promise<T>
	/**
	 * Create a traced span with custom attributes.
	 */
	trace<T>(name: string, attrs: Record<string, unknown>, fn: () => T | Promise<T>): Promise<T>

	/**
	 * Set an attribute on the currently active span.
	 */
	setAttribute(key: string, value: unknown): void

	/**
	 * Add an event (log entry) to the currently active span.
	 */
	addEvent(name: string, message?: string, attrs?: Record<string, unknown>): void
}

declare var __lopata: LopataTracing | undefined
