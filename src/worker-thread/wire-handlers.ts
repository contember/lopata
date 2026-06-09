/**
 * Workflow + queue wiring that runs after the user module loads in the worker
 * thread. Kept out of `thread-env.ts` so the env builder doesn't need to
 * receive the user module — buildThreadEnv runs before `import(modulePath)`.
 */

import type { Database } from 'bun:sqlite'
import { QueueConsumer } from '../bindings/queue'
import { wireWorkflowClass } from '../bindings/workflow'
import type { WranglerConfig } from '../config'
import type { ThreadEnvBuilt } from './thread-env'

export function wireWorkflows(built: ThreadEnvBuilt, workerModule: Record<string, unknown>): void {
	for (const wf of built.workflows) {
		wireWorkflowClass(wf.binding, wf.className, workerModule, built.env)
	}
}

/**
 * Spawn queue consumers in the worker thread. Shared SQLite means the consumer
 * can poll, manage leases, and apply ack/retry decisions locally — exactly
 * like the in-process flow — without any cross-thread RPC.
 */
export function startThreadQueueConsumers(
	config: WranglerConfig,
	db: Database,
	env: Record<string, unknown>,
	workerModule: Record<string, unknown>,
	workerName?: string,
): QueueConsumer[] {
	const handler = resolveQueueHandler(workerModule)
	if (!handler) return []
	const consumers: QueueConsumer[] = []
	for (const cfg of config.queues?.consumers ?? []) {
		const consumer = new QueueConsumer(
			db,
			{
				queue: cfg.queue,
				maxBatchSize: cfg.max_batch_size ?? 10,
				maxBatchTimeout: cfg.max_batch_timeout ?? 5,
				maxRetries: cfg.max_retries ?? 3,
				deadLetterQueue: cfg.dead_letter_queue ?? null,
				maxConcurrency: cfg.max_concurrency ?? null,
				retryDelay: cfg.retry_delay ?? null,
			},
			handler,
			env,
			workerName,
		)
		consumer.start()
		consumers.push(consumer)
	}
	return consumers
}

/** Wrap whatever the user returns into the QueueHandler signature (`Promise<void>`). */
function resolveQueueHandler(workerModule: Record<string, unknown>): ((batch: unknown, env: unknown, ctx: unknown) => Promise<void>) | null {
	const def = workerModule.default
	if (typeof def === 'function' && def.prototype) {
		const proto = def.prototype as Record<string, unknown>
		if (typeof proto.queue !== 'function') return null
		// Class-based: construct a fresh instance per batch — same per-batch
		// construction `resolveHandler` does for fetch/scheduled/email in entry.ts.
		const Ctor = def as new(ctx: unknown, env: unknown) => Record<string, (...a: unknown[]) => Promise<unknown>>
		return async (batch, env, ctx) => {
			const instance = new Ctor(ctx, env)
			await instance.queue!(batch, env, ctx)
		}
	}
	const obj = def as Record<string, unknown> | null | undefined
	const queueFn = obj?.queue
	if (typeof queueFn !== 'function') return null
	const fn = queueFn as (batch: unknown, env: unknown, ctx: unknown) => Promise<unknown>
	return async (batch, env, ctx) => {
		await fn.call(obj, batch, env, ctx)
	}
}
