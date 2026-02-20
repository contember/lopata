import { AsyncLocalStorage } from 'node:async_hooks'

const storage = new AsyncLocalStorage<ExecutionContext>()

export function getActiveExecutionContext(): ExecutionContext | undefined {
	return storage.getStore()
}

export function runWithExecutionContext<T>(ctx: ExecutionContext, fn: () => T): T {
	return storage.run(ctx, fn)
}

export class ExecutionContext {
	private _promises: Promise<unknown>[] = []
	readonly props: Record<string, unknown>

	constructor(props?: Record<string, unknown>) {
		this.props = props ?? {}
	}

	waitUntil(promise: Promise<unknown>): void {
		this._promises.push(promise.catch(err => {
			console.error('[lopata] waitUntil promise rejected:', err)
		}))
	}

	passThroughOnException(): void {
		// No origin in local dev — no-op is correct
	}

	/** Dev-only: await all tracked background promises */
	async _awaitAll(): Promise<void> {
		await Promise.allSettled(this._promises)
	}
}
