import type { WranglerConfig } from './config'

/** Minimal interface for the manager stored in route entries — allows both GenerationManager and Vite adapters. */
export interface RoutableManager {
	readonly active: { callFetch(request: Request, server: unknown): Promise<Response | undefined> | Response | undefined } | null
}

/**
 * Extract the path portion from a Cloudflare route pattern.
 * Strips the domain prefix: `example.com/api/*` → `/api/*`
 * Handles patterns that are already path-only: `/api/*` → `/api/*`
 * Strips query strings and hash fragments from the result.
 */
export function extractPathPattern(route: string | { pattern: string }): string {
	let pattern = typeof route === 'string' ? route : route.pattern

	// Strip protocol if present (e.g. `https://example.com/api/*`)
	pattern = pattern.replace(/^https?:\/\//, '')

	let path: string
	if (pattern.startsWith('/')) {
		path = pattern
	} else {
		// Strip domain (and optional port): find the first `/` after the domain
		const slashIndex = pattern.indexOf('/')
		if (slashIndex === -1) path = '/*' // Domain-only pattern like `example.com` matches everything
		else path = pattern.slice(slashIndex)
	}

	// Strip query string and hash fragment
	const qIndex = path.indexOf('?')
	if (qIndex !== -1) path = path.slice(0, qIndex)
	const hIndex = path.indexOf('#')
	if (hIndex !== -1) path = path.slice(0, hIndex)

	return path
}

/**
 * Match a request pathname against a Cloudflare-style route pattern (path portion only).
 * Supports trailing `*` as a wildcard that matches any suffix.
 *
 * Examples:
 * - `/api/*` matches `/api/foo`, `/api/foo/bar`
 * - `/api/users` matches only `/api/users`
 * - `/*` matches everything
 */
export function matchRoute(pathname: string, pattern: string): boolean {
	if (pattern === '/*' || pattern === '*') return true

	if (pattern.endsWith('/*')) {
		const prefix = pattern.slice(0, -2)
		return pathname.startsWith(prefix + '/')
	}

	if (pattern.endsWith('*')) {
		const prefix = pattern.slice(0, -1)
		return pathname.startsWith(prefix)
	}

	return pathname === pattern
}

/** Match a hostname against a host pattern. Supports exact match and `*.domain` wildcards. */
export function matchHost(hostname: string, pattern: string): boolean {
	if (pattern === hostname) return true
	if (pattern.startsWith('*.')) {
		const suffix = pattern.slice(1) // ".localhost"
		// Must have a subdomain — bare hostname doesn't match *.localhost
		return hostname.endsWith(suffix) && hostname.length > suffix.length
	}
	return false
}

/** Count the number of path segments in a pattern (ignoring trailing wildcard). */
function segmentCount(pattern: string): number {
	const clean = pattern.replace(/\/?\*$/, '')
	if (clean === '' || clean === '/') return 0
	return clean.split('/').filter(Boolean).length
}

interface RouteEntry {
	pattern: string
	workerName: string
	manager: RoutableManager
}

/**
 * Dispatches requests to workers based on route patterns.
 * Routes are sorted by specificity (most specific first).
 *
 * Only auxiliary workers should be added here — the main worker
 * is the fallback and handles all unmatched requests.
 */
export class RouteDispatcher {
	private routes: RouteEntry[] = []
	private sorted = true
	private fallback: RoutableManager

	constructor(fallback: RoutableManager) {
		this.fallback = fallback
	}

	addRoutes(config: WranglerConfig, manager: RoutableManager, workerName: string): void {
		if (!config.routes) return

		// Clear existing routes for this worker to support re-registration (e.g. config reload)
		const hadRoutes = this.routes.length > 0
		this.routes = this.routes.filter(r => r.workerName !== workerName)
		if (hadRoutes && this.routes.length === 0) this.sorted = true

		for (const route of config.routes) {
			// Skip custom_domain entries — they are domain ownership claims, not request routing patterns
			if (typeof route === 'object' && route.custom_domain) continue

			const rawPattern = typeof route === 'string' ? route : route.pattern
			if (!rawPattern || rawPattern.trim() === '') {
				console.warn(`[lopata] Warning: empty route pattern in worker "${workerName}" — skipping`)
				continue
			}

			const pattern = extractPathPattern(route)

			// Warn about mid-pattern wildcards (CF only supports trailing wildcards)
			const starIndex = pattern.indexOf('*')
			if (starIndex !== -1 && starIndex < pattern.length - 1) {
				console.warn(`[lopata] Warning: route pattern "${pattern}" has a wildcard not at the end — Cloudflare only supports trailing wildcards`)
			}

			// Skip duplicate patterns from different workers (first registered wins)
			const existing = this.routes.find(r => r.pattern === pattern)
			if (existing) {
				console.warn(
					`[lopata] Warning: route pattern "${pattern}" is already registered by "${existing.workerName}" — skipping duplicate from "${workerName}"`,
				)
				continue
			}

			this.routes.push({ pattern, workerName, manager })
			this.sorted = false
		}
	}

	removeWorkerRoutes(workerName: string): void {
		this.routes = this.routes.filter(r => r.workerName !== workerName)
	}

	private ensureSorted(): void {
		if (this.sorted) return
		this.routes.sort((a, b) => {
			const aHasWild = a.pattern.includes('*')
			const bHasWild = b.pattern.includes('*')
			// Non-wildcard patterns are more specific
			if (aHasWild !== bHasWild) return aHasWild ? 1 : -1
			// More segments = more specific
			const segDiff = segmentCount(b.pattern) - segmentCount(a.pattern)
			if (segDiff !== 0) return segDiff
			// Slash-star (`/api/*`) is more specific than bare-star (`/api*`)
			// because it only matches path-separated suffixes
			const aSlashStar = a.pattern.endsWith('/*')
			const bSlashStar = b.pattern.endsWith('/*')
			if (aSlashStar !== bSlashStar) return aSlashStar ? -1 : 1
			// Longer pattern string as tiebreaker
			return b.pattern.length - a.pattern.length
		})
		this.sorted = true
	}

	resolve(pathname: string): RoutableManager {
		this.ensureSorted()
		for (const entry of this.routes) {
			if (matchRoute(pathname, entry.pattern)) {
				return entry.manager
			}
		}
		return this.fallback
	}

	/** Check whether the given manager is the fallback (main worker). */
	isFallback(manager: RoutableManager): boolean {
		return manager === this.fallback
	}

	hasRoutes(): boolean {
		return this.routes.length > 0
	}

	getRegisteredRoutes(): Array<{ pattern: string; workerName: string }> {
		this.ensureSorted()
		return this.routes.map(r => ({ pattern: r.pattern, workerName: r.workerName }))
	}
}
