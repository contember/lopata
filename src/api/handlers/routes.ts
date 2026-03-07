import { extractPathPattern } from '../../route-matcher'
import type { HandlerContext, RouteInfo } from '../types'

export const handlers = {
	'routes.list'(_input: {}, ctx: HandlerContext): RouteInfo[] {
		const routes: RouteInfo[] = []

		// Show host-based routes
		for (const hr of ctx.hostRoutes) {
			routes.push({ pattern: hr.pattern, workerName: hr.workerName, isFallback: false, type: 'host' })
		}

		if (ctx.routeDispatcher) {
			for (const r of ctx.routeDispatcher.getRegisteredRoutes()) {
				if (r.hostPatterns) continue // already shown as host routes
				routes.push({ pattern: r.pattern, workerName: r.workerName, isFallback: false })
			}
		}

		// In single-worker mode, show routes from config
		if (!ctx.routeDispatcher && ctx.config?.routes) {
			const workerName = ctx.config.name || 'main'
			for (const route of ctx.config.routes) {
				if (typeof route === 'object' && route.custom_domain) continue
				routes.push({ pattern: extractPathPattern(route), workerName, isFallback: false })
			}
		}

		// Add main/fallback worker entry
		const mainName = ctx.registry
			? Array.from(ctx.registry.listManagers().keys())[0] ?? 'main'
			: ctx.config?.name || 'main'
		routes.push({ pattern: '/*', workerName: mainName, isFallback: true })

		return routes
	},
}
