/**
 * Worker-thread implementation of CF's `ExecutionContext`. Tracks
 * `waitUntil()` promises locally (they capture worker-side closures) and
 * notifies main of each add/settle so reload drain can wait for them.
 */

import { logIfRejected } from '../execution-context'
import type { WorkerMessage } from './protocol'

export class WorkerExecutionContext {
	/** @internal Reserved for Phase 7 service-binding `props` wiring; currently always `{}`. */
	readonly props: Record<string, unknown>
	private _post: (msg: WorkerMessage) => void

	constructor(post: (msg: WorkerMessage) => void, props?: Record<string, unknown>) {
		this._post = post
		this.props = props ?? {}
	}

	waitUntil(promise: Promise<unknown>): void {
		this._post({ type: 'wait-until-add' })
		logIfRejected(promise).finally(() => {
			this._post({ type: 'wait-until-settle' })
		})
	}

	passThroughOnException(): void {
		// No origin in local dev — no-op matches CF semantics when the runtime
		// has nowhere to pass through to.
	}
}
