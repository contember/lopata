/**
 * Cross-thread binding RPC — shared core used by both worker channels.
 *
 * One frame ({@link RpcCallRequest} / {@link RpcFetchRequest} + their
 * replies in `./protocol.ts`) covers both:
 *  - main ↔ user-worker thread (`WorkerThreadExecutor` in `./executor.ts`)
 *  - main ↔ DO-instance worker thread (`WorkerExecutor` in `../bindings/do-executor-worker.ts`)
 *
 * The two channels carry channel-specific messages on top (fetch/scheduled,
 * ws-bridge events, container lifecycle, …) but the binding RPC half is
 * identical: resolve binding from `target`, invoke under the caller's trace
 * context, serialize the result. This module hosts that half.
 */

import { EmailMessage } from '../bindings/email'
import { runWithParentContext } from '../tracing/context'
import type {
	BindingTarget,
	ParentSpanContext,
	RpcCallErrorReply,
	RpcCallReply,
	RpcCallRequest,
	RpcFetchErrorReply,
	RpcFetchReply,
	RpcFetchRequest,
	RpcReply,
	SerializedRequest,
	SerializedResponse,
} from './protocol'
import { deserializeError, serializeError } from './protocol'
import { deserializeRequest, serializeRequest, serializeResponse } from './serialize'

/**
 * Restore class identities that structured-clone strips. Worker proxies tag
 * such args with `__lopata_class` so we can rebuild the real instance here.
 */
export function reifyArgs(args: unknown[]): unknown[] {
	return args.map(reifyArg)
}

function reifyArg(arg: unknown): unknown {
	if (arg && typeof arg === 'object' && '__lopata_class' in arg) {
		const tag = (arg as { __lopata_class: string }).__lopata_class
		if (tag === 'EmailMessage') {
			const { from, to, raw } = arg as unknown as { from: string; to: string; raw: unknown }
			return new EmailMessage(from, to, raw as Uint8Array | ArrayBuffer | string)
		}
	}
	return arg
}

export interface RpcDispatchHooks {
	/** Resolve a binding from main env (channel-specific: user-worker supports
	 *  `instanceId` namespace .get(), DO channel doesn't). */
	resolveBinding(target: BindingTarget): Record<string, unknown>
	/** Post a reply back through the channel's transport. */
	post(reply: RpcReply): void
	/** Return false once the channel is torn down so we drop late replies. */
	isAlive(): boolean
	/** Optional hook to add transport-specific fields (e.g. webSocketId) to a
	 *  serialized response after fetch resolves. */
	decorateResponse?(response: Response, serialized: SerializedResponse): void
}

export async function dispatchRpcCall(req: RpcCallRequest, hooks: RpcDispatchHooks): Promise<void> {
	try {
		const resolved = hooks.resolveBinding(req.target)
		const fn = resolved[req.method]
		if (typeof fn !== 'function') {
			throw new Error(`Binding "${req.target.binding}" has no method "${req.method}"`)
		}
		const args = reifyArgs(req.args)
		const value = await runWithParentContext(req.parent, () => (fn as (...a: unknown[]) => unknown).call(resolved, ...args))
		if (!hooks.isAlive()) return
		hooks.post({ type: 'rpc-call-result', id: req.id, value } satisfies RpcCallReply)
	} catch (e) {
		if (!hooks.isAlive()) return
		hooks.post({ type: 'rpc-call-error', id: req.id, error: serializeError(e) } satisfies RpcCallErrorReply)
	}
}

export async function dispatchRpcFetch(req: RpcFetchRequest, hooks: RpcDispatchHooks): Promise<void> {
	try {
		const resolved = hooks.resolveBinding(req.target)
		const fetch = resolved.fetch
		if (typeof fetch !== 'function') {
			throw new Error(`Binding "${req.target.binding}" has no fetch() method`)
		}
		const request = deserializeRequest(req.request)
		const response = await runWithParentContext(
			req.parent,
			() => (fetch as (r: Request) => Promise<Response>).call(resolved, request),
		)
		if (!hooks.isAlive()) return
		const serialized = await serializeResponse(response)
		hooks.decorateResponse?.(response, serialized)
		hooks.post({ type: 'rpc-fetch-result', id: req.id, response: serialized } satisfies RpcFetchReply)
	} catch (e) {
		if (!hooks.isAlive()) return
		hooks.post({ type: 'rpc-fetch-error', id: req.id, error: serializeError(e) } satisfies RpcFetchErrorReply)
	}
}

interface PendingCall {
	resolve: (value: unknown) => void
	reject: (error: Error) => void
}

/**
 * Worker-side RPC caller: posts {@link RpcCallRequest}/{@link RpcFetchRequest},
 * resolves the matching reply.
 *
 * Reads the active span context on every call so spans created on the
 * receiving thread (including spans inside nested cross-thread hops) nest
 * under the caller's current span.
 */
export class RpcClient {
	private _pending = new Map<number, PendingCall>()
	private _nextId = 1
	private _post: (req: RpcCallRequest | RpcFetchRequest) => void
	private _getParent: () => ParentSpanContext | undefined

	constructor(
		post: (req: RpcCallRequest | RpcFetchRequest) => void,
		getParent: () => ParentSpanContext | undefined,
	) {
		this._post = post
		this._getParent = getParent
	}

	call(target: BindingTarget, method: string, args: unknown[]): Promise<unknown> {
		const id = this._nextId++
		return new Promise((resolve, reject) => {
			this._pending.set(id, { resolve, reject })
			this._post({ type: 'rpc-call', id, target, method, args, parent: this._getParent() })
		})
	}

	async callFetch(target: BindingTarget, request: Request): Promise<SerializedResponse> {
		const req = await serializeRequest(request)
		const id = this._nextId++
		return new Promise<SerializedResponse>((resolve, reject) => {
			this._pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
			this._post({ type: 'rpc-fetch', id, target, request: req, parent: this._getParent() })
		})
	}

	/** Returns true when `msg` was a unified RPC reply we consumed. */
	handle(msg: { type: string }): boolean {
		switch (msg.type) {
			case 'rpc-call-result':
			case 'rpc-fetch-result': {
				const reply = msg as RpcCallReply | RpcFetchReply
				const p = this._pending.get(reply.id)
				if (!p) return true
				this._pending.delete(reply.id)
				p.resolve(reply.type === 'rpc-call-result' ? reply.value : reply.response)
				return true
			}
			case 'rpc-call-error':
			case 'rpc-fetch-error': {
				const reply = msg as RpcCallErrorReply | RpcFetchErrorReply
				const p = this._pending.get(reply.id)
				if (!p) return true
				this._pending.delete(reply.id)
				p.reject(deserializeError(reply.error))
				return true
			}
			default:
				return false
		}
	}

	rejectAll(err: Error): void {
		for (const [, p] of this._pending) p.reject(err)
		this._pending.clear()
	}
}
