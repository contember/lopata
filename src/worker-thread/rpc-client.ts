/** Worker-side caller for stateful binding RPC. */

import type { BindingTarget, SerializedResponse, WorkerCommand, WorkerMessage } from './protocol'

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
		const headers: [string, string][] = []
		request.headers.forEach((v, k) => headers.push([k, v]))
		const body = request.body ? await request.arrayBuffer() : null

		const id = this._nextId++
		return new Promise<SerializedResponse>((resolve, reject) => {
			this._pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
			this._post({ type: 'binding-fetch', id, target, request: { url: request.url, method: request.method, headers, body } })
		})
	}

	/** Called from the worker's onmessage when a binding-result/error arrives. */
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
