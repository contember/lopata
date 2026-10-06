declare module 'cloudflare:workers' {
	export const tracing: import('../../../src/tracing/span').Tracing
	export function waitUntil(promise: Promise<unknown>): void
	export class WorkerEntrypoint {
		protected ctx: import('../../../src/worker-thread/execution-context').WorkerExecutionContext
		protected env: unknown
		constructor(ctx: import('../../../src/worker-thread/execution-context').WorkerExecutionContext, env: unknown)
	}
}
