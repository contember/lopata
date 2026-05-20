/**
 * Worker-thread implementation of CF's `ExecutionContext`. Tracks
 * `waitUntil()` promises locally (they capture worker-side closures) and
 * notifies main of each add/settle so reload drain can wait for them.
 */

import type { WorkerMessage } from './protocol'

export class WorkerExecutionContext {
	readonly props: Record<string, unknown>
	private _post: (msg: WorkerMessage) => void

	constructor(post: (msg: WorkerMessage) => void, props?: Record<string, unknown>) {
		this._post = post
		this.props = props ?? {}
	}

	waitUntil(promise: Promise<unknown>): void {
		this._post({ type: 'wait-until-add' })
		Promise.resolve(promise).catch(err => {
			console.error('[lopata] waitUntil promise rejected:', err)
		}).finally(() => {
			this._post({ type: 'wait-until-settle' })
		})
	}

	passThroughOnException(): void {
		// No origin in local dev — no-op matches CF semantics when the runtime
		// has nowhere to pass through to.
	}
}
