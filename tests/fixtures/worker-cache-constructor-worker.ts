import { cache, WorkerEntrypoint } from 'cloudflare:workers'
import type { CacheExecutionContext } from '../../src/bindings/worker-cache'

export default class ConstructorWorker extends WorkerEntrypoint {
	private receipt: ReturnType<typeof cache.purge>
	constructor(ctx: CacheExecutionContext, env: unknown) {
		super(ctx, env)
		this.receipt = cache.purge({ purgeEverything: true })
	}
	async fetch(): Promise<Response> {
		return new Response(JSON.stringify(await this.receipt))
	}
	async scheduled(): Promise<void> {
		await this.receipt
	}
	async email(): Promise<void> {
		await this.receipt
	}
}
