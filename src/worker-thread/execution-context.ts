/**
 * Worker-thread implementation of CF's `ExecutionContext`. Tracks
 * `waitUntil()` promises locally (they capture worker-side closures) and
 * notifies main of each add/settle so reload drain can wait for them.
 */

import { logIfRejected } from '../execution-context'
import type { WorkerMessage } from './protocol'

// Worker-thread-global wait-until id sequence. Ids never cross thread
// boundaries (each generation has its own worker), so a module-level counter
// is enough to keep main's `_pendingWaitUntil` Set unambiguous across
// concurrent fetches.
let nextWaitUntilId = 1

export class WorkerExecutionContext {
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
		this._post({ type: 'wait-until-add', id })
		logIfRejected(promise).finally(() => {
			this._post({ type: 'wait-until-settle', id })
		})
	}

	passThroughOnException(): void {
		// No origin in local dev — no-op matches CF semantics when the runtime
		// has nowhere to pass through to.
	}
}
