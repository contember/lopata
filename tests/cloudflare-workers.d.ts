/**
 * Type declarations for `cloudflare:workers` virtual module (test-only).
 * At runtime, Bun.plugin provides the actual implementations.
 */
declare module 'cloudflare:workers' {
	export class DurableObject {
		ctx: any
		env: any
		constructor(ctx: any, env: any)
	}

	export class WorkflowEntrypoint {
		ctx: any
		env: any
		constructor(ctx: any, env: any)
		run(event: any, step: any): Promise<unknown>
	}

	export class WorkerEntrypoint {
		protected ctx: unknown
		protected env: unknown
		constructor(ctx: unknown, env: unknown)
	}

	export class RpcTarget {}

	export class WebSocketRequestResponsePair {
		constructor(request: string, response: string)
		readonly request: string
		readonly response: string
	}

	export class WebSocketPair {
		0: WebSocket
		1: WebSocket
	}

	export const env: Record<string, any>

	export function waitUntil(promise: Promise<unknown>): void
}

declare module 'cloudflare:workflows' {
	export class NonRetryableError extends Error {
		constructor(message?: string)
	}
}

declare var caches: {
	default: {
		match(request: Request | string): Promise<Response | undefined>
		put(request: Request | string, response: Response): Promise<void>
		delete(request: Request | string): Promise<boolean>
	}
	open(cacheName: string): Promise<{
		match(request: Request | string): Promise<Response | undefined>
		put(request: Request | string, response: Response): Promise<void>
		delete(request: Request | string): Promise<boolean>
	}>
}
