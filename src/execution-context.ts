import { AsyncLocalStorage } from 'node:async_hooks'
import { cache } from './bindings/worker-cache'
import type { DispatchExecutionContext } from './bindings/worker-dispatcher'
import { tracing } from './tracing/span'
import { globalExports } from './worker-exports'

const storage = new AsyncLocalStorage<DispatchExecutionContext>()

export function getActiveExecutionContext(): DispatchExecutionContext | undefined {
	return storage.getStore()
}

export function runWithExecutionContext<T>(ctx: DispatchExecutionContext, fn: () => T): T {
	return storage.run(ctx, fn)
}

/** Swallow + log a `waitUntil` rejection. Single source of truth for the log string.
 *  Coerces non-thenables (CF tolerates `ctx.waitUntil(undefined)`) — a synchronous
 *  throw here would strand the wait-until-settle accounting on the worker side. */
export function logIfRejected(promise: Promise<unknown>): Promise<unknown> {
	return Promise.resolve(promise).catch(err => {
		console.error('[lopata] waitUntil promise rejected:', err)
	})
}

export class ExecutionContext {
	readonly cache = cache
	private _promises: Promise<unknown>[] = []
	readonly props: Record<string, unknown>
	/** Cloudflare-compatible custom span API: `ctx.tracing.enterSpan(...)`. */
	readonly tracing = tracing

	constructor(props?: Record<string, unknown>) {
		this.props = props ?? {}
	}

	/** `ctx.exports` — loopback bindings to this worker's own exports. */
	get exports(): Record<string, unknown> {
		return globalExports
	}

	waitUntil(promise: Promise<unknown>): void {
		this._promises.push(logIfRejected(promise))
	}

	passThroughOnException(): void {
		// No origin in local dev — no-op is correct
	}

	/** Dev-only: await all tracked background promises */
	async _awaitAll(): Promise<void> {
		let consumed = 0
		while (consumed < this._promises.length) {
			const pending = this._promises.slice(consumed)
			consumed = this._promises.length
			await Promise.allSettled(pending)
		}
	}
}
