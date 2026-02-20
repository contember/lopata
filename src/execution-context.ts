export class ExecutionContext {
	private _promises: Promise<unknown>[] = []

	waitUntil(promise: Promise<unknown>): void {
		this._promises.push(promise.catch(err => {
			console.error('[bunflare] waitUntil promise rejected:', err)
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
