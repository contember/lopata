import type { WranglerConfig } from '../config'
import type { GenerationManager } from '../generation-manager'
import type { LopataConfig } from '../lopata-config'
import type { WorkerRegistry } from '../worker-registry'
import { handlePreflight, withCors } from './cors'
import { dispatch } from './dispatch'
import { handleR2Download, handleR2Upload } from './r2'
import type { HandlerContext } from './types'

const ctx: HandlerContext = { config: null, manager: null, registry: null, lopataConfig: null }

export function setDashboardConfig(config: WranglerConfig): void {
	ctx.config = config
}

export function setGenerationManager(manager: GenerationManager): void {
	ctx.manager = manager
}

export function setWorkerRegistry(registry: WorkerRegistry): void {
	ctx.registry = registry
}

export function setLopataConfig(config: LopataConfig): void {
	ctx.lopataConfig = config
}

export function handleApiRequest(request: Request): Response | Promise<Response> {
	const url = new URL(request.url)

	// CORS preflight
	if (request.method === 'OPTIONS') {
		return handlePreflight()
	}

	// RPC endpoint
	if (url.pathname === '/__api/rpc' && request.method === 'POST') {
		return dispatch(request, ctx)
	}

	// R2 upload (multipart/form-data)
	if (url.pathname === '/__api/r2/upload' && request.method === 'POST') {
		return handleR2Upload(request)
	}

	// R2 download
	if (url.pathname === '/__api/r2/download' && request.method === 'GET') {
		return handleR2Download(url)
	}

	return withCors(new Response('Not found', { status: 404 }))
}
