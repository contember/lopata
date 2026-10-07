import { AsyncLocalStorage } from 'node:async_hooks'
import { cache } from './bindings/worker-cache'
import type { DispatchExecutionContext } from './bindings/worker-dispatcher'
import { getActiveInvocation, type TraceCompletion } from './tracing/invocation'
import { tracing } from './tracing/span'

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
	exports: Record<string, unknown> = {}
	private _promises: Promise<unknown>[] = []
	private readonly invocation = getActiveInvocation()
	readonly props: Record<string, unknown>
	/** Cloudflare-compatible custom span API: `ctx.tracing.enterSpan(...)`. */
	readonly tracing = tracing

	constructor(props?: Record<string, unknown>) {
		this.props = props ?? {}
	}

	waitUntil(promise: Promise<unknown>): void {
		const release = this.invocation?.retain('wait-until')
		let completion: TraceCompletion = { kind: 'complete' }
		const observed = Promise.resolve(promise).catch(error => {
			completion = { kind: 'error', error }
			throw error
		})
		this._promises.push(logIfRejected(observed).finally(() => release?.(completion)))
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
