/**
 * Worker-thread implementation of CF's `ExecutionContext`. Tracks
 * `waitUntil()` promises locally (they capture worker-side closures) and
 * notifies main of each add/settle so reload drain can wait for them.
 */

import { unavailableWorkerCache } from '../bindings/worker-cache'
import { logIfRejected } from '../execution-context'
import { getActiveInvocation, type TraceCompletion } from '../tracing/invocation'
import { tracing } from '../tracing/span'
import type { WorkerMessage } from './protocol'

// Worker-thread-global wait-until id sequence. Ids never cross thread
// boundaries (each generation has its own worker), so a module-level counter
// is enough to keep main's `_pendingWaitUntil` Set unambiguous across
// concurrent fetches.
let nextWaitUntilId = 1

/**
 * Register a background promise with main's reload-drain accounting (same
 * `wait-until-add` / `wait-until-settle` protocol as `ctx.waitUntil`). Used for
 * worker-side work that isn't tied to an `ExecutionContext` — e.g. an in-flight
 * queue batch, so reload drain waits for it instead of terminating mid-batch.
 */
export function trackBackgroundWork(post: (msg: WorkerMessage) => void, promise: Promise<unknown>): void {
	const id = nextWaitUntilId++
	post({ type: 'wait-until-add', id })
	logIfRejected(promise).finally(() => {
		post({ type: 'wait-until-settle', id })
	})
}

export class WorkerExecutionContext {
	readonly tracing = tracing
	private readonly invocation = getActiveInvocation()
	cache = unavailableWorkerCache
	exports: Record<string, unknown> = {}
	/** `ctx.props` — carries the calling worker's service-binding `props` for
	 *  `entrypoint-rpc` / `fetch` dispatch; `{}` for top-level HTTP. */
	readonly props: Record<string, unknown>
	private _post: (msg: WorkerMessage) => void

	constructor(post: (msg: WorkerMessage) => void, props?: Record<string, unknown>) {
		this._post = post
		this.props = props ?? {}
	}

	waitUntil(promise: Promise<unknown>): void {
		const id = nextWaitUntilId++
		const release = this.invocation?.retain('wait-until')
		let completion: TraceCompletion = { kind: 'complete' }
		try {
			this._post({ type: 'wait-until-add', id })
		} catch (error) {
			release?.({ kind: 'error', error })
			throw error
		}
		const observed = Promise.resolve(promise).catch(error => {
			completion = { kind: 'error', error }
			throw error
		})
		logIfRejected(observed).finally(() => {
			try {
				this._post({ type: 'wait-until-settle', id })
			} finally {
				release?.(completion)
			}
		})
	}

	passThroughOnException(): void {
		// No origin in local dev — no-op matches CF semantics when the runtime
		// has nowhere to pass through to.
	}
}
