import { AsyncLocalStorage } from 'node:async_hooks'
import { tracing } from './tracing/span'

const storage = new AsyncLocalStorage<ExecutionContext>()

export function getActiveExecutionContext(): ExecutionContext | undefined {
	return storage.getStore()
}

export function runWithExecutionContext<T>(ctx: ExecutionContext, fn: () => T): T {
	return storage.run(ctx, fn)
}

/** Swallow + log a `waitUntil` rejection. Single source of truth for the log string. */
export function logIfRejected(promise: Promise<unknown>): Promise<unknown> {
	return promise.catch(err => {
		console.error('[lopata] waitUntil promise rejected:', err)
	})
}

export class ExecutionContext {
	private _promises: Promise<unknown>[] = []
	readonly props: Record<string, unknown>
	/** Cloudflare-compatible custom span API: `ctx.tracing.enterSpan(...)`. */
	readonly tracing = tracing

	constructor(props?: Record<string, unknown>) {
		this.props = props ?? {}
	}

	waitUntil(promise: Promise<unknown>): void {
		this._promises.push(logIfRejected(promise))
	}

	passThroughOnException(): void {
		// No origin in local dev — no-op is correct
	}

	/** Dev-only: await all tracked background promises */
	async _awaitAll(): Promise<void> {
		await Promise.allSettled(this._promises)
	}
}
