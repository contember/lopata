/** Worker-side caller for stateful binding RPC. */

import type { BindingTarget, SerializedResponse, WorkerCommand, WorkerMessage } from './protocol'
import { serializeRequest } from './serialize'

interface PendingCall {
	resolve: (value: unknown) => void
	reject: (error: Error) => void
}

export class RpcClient {
	private _pending = new Map<number, PendingCall>()
	private _nextId = 1
	private _post: (msg: WorkerMessage) => void

	constructor(post: (msg: WorkerMessage) => void) {
		this._post = post
	}

	call(target: BindingTarget, method: string, args: unknown[]): Promise<unknown> {
		const id = this._nextId++
		return new Promise((resolve, reject) => {
			this._pending.set(id, { resolve, reject })
			this._post({ type: 'binding-call', id, target, method, args })
		})
	}

	async callFetch(target: BindingTarget, request: Request): Promise<SerializedResponse> {
		const req = await serializeRequest(request)
		const id = this._nextId++
		return new Promise<SerializedResponse>((resolve, reject) => {
			// `_pending` is widened to `unknown`; SerializedResponse satisfies that.
			this._pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
			this._post({ type: 'binding-fetch', id, target, request: req })
		})
	}

	/** Returns true when `cmd` was a binding-result/error we consumed. */
	handle(cmd: WorkerCommand): boolean {
		switch (cmd.type) {
			case 'binding-result':
			case 'binding-fetch-result': {
				const p = this._pending.get(cmd.id)
				if (!p) return true
				this._pending.delete(cmd.id)
				p.resolve(cmd.type === 'binding-result' ? cmd.value : cmd.response)
				return true
			}
			case 'binding-error':
			case 'binding-fetch-error': {
				const p = this._pending.get(cmd.id)
				if (!p) return true
				this._pending.delete(cmd.id)
				const err = new Error(cmd.error.message)
				if (cmd.error.stack) err.stack = cmd.error.stack
				err.name = cmd.error.name ?? 'Error'
				p.reject(err)
				return true
			}
			default:
				return false
		}
	}
}
