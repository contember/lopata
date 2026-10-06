/**
 * Service Binding — worker-to-worker communication via HTTP fetch and RPC.
 *
 * The binding is a Proxy that supports:
 * - `.fetch(request | url, init?)` — calls the target worker's fetch() handler
 * - `.myMethod(args)` — RPC call to the target's entrypoint class method (always returns Promise)
 * - `.myProperty` — RPC property access (returns thenable/Promise)
 * - `.connect()` — stub for TCP socket (throws — not supported in dev)
 */

import type { CompatibilitySelection } from '../compatibility'
import { legacyCompatibility, runWithCompatibility } from '../compatibility-context'
import { ExecutionContext, runWithExecutionContext } from '../execution-context'
import { warnInvalidRpcArgs } from '../rpc-validate'
import { getActiveContext } from '../tracing/context'
import { createInvocationTrace, getActiveInvocation, type InvocationTrace } from '../tracing/invocation'
import type { ResolvedTarget } from '../worker-registry'
import { createRpcSession, type RpcSession } from './rpc-session'
import { createRpcFunctionStub, NON_RPC_PROPS, wrapRpcReturnValue } from './rpc-stub'
import { assetsOnlyRejection } from './static-assets'
import { getWorkerDispatcher, isWorkerResponse, trackInvocationResponse, workerRequest } from './worker-cache'

type WorkerModule = Record<string, unknown>

export interface ServiceBindingLimits {
	/** Max subrequests per top-level request (CF default: 1000 for workers, 32 for service bindings) */
	maxSubrequests?: number
	/** Max payload size in bytes for RPC arguments (CF default: 32 MiB) */
	maxRpcPayloadSize?: number
}

const SERVICE_BINDING_DEFAULTS: Required<ServiceBindingLimits> = {
	maxSubrequests: 1000,
	maxRpcPayloadSize: 32 * 1024 * 1024,
}

// Internal properties that should be forwarded to the ServiceBinding instance
const INTERNAL_PROPS = new Set(['_wire', 'isWired', '_subrequestCount'])

/** Error thrown by `connect()` (both in-process and worker-thread paths). */
export function serviceBindingConnectError(name: string): Error {
	return new Error(`Service binding "${name}": connect() (TCP sockets) is not supported in local dev mode`)
}

/**
 * Resolve the call target for a service binding RPC (`fetch` or method):
 * a named entrypoint class, an unnamed default class, or the default object.
 *
 * Used by in-process service dispatch and the worker-thread's
 * `invokeEntrypointRpc`. Single source of truth so the in-process and
 * thread-mode paths can't drift.
 */
export function resolveEntrypointTarget(
	workerModule: Record<string, unknown>,
	entrypoint: string | undefined,
	ctx: unknown,
	env: unknown,
): Record<string, unknown> {
	if (entrypoint) {
		const cls = workerModule[entrypoint]
		if (typeof cls !== 'function') {
			throw new Error(`Entrypoint "${entrypoint}" not exported from worker module`)
		}
		return new (cls as new(ctx: unknown, env: unknown) => Record<string, unknown>)(ctx, env)
	}
	const def = workerModule.default
	if (typeof def === 'function' && def.prototype) {
		return new (def as new(ctx: unknown, env: unknown) => Record<string, unknown>)(ctx, env)
	}
	return def as Record<string, unknown>
}

export class ServiceBinding {
	private _resolver: (() => ResolvedTarget) | null = null
	private _entrypoint: string | undefined
	private _serviceName: string
	private _limits: Required<ServiceBindingLimits>
	_subrequestCount: number = 0

	private _props: Record<string, unknown>

	constructor(serviceName: string, entrypoint?: string, limits?: ServiceBindingLimits, props?: Record<string, unknown>) {
		this._serviceName = serviceName
		this._entrypoint = entrypoint
		this._limits = { ...SERVICE_BINDING_DEFAULTS, ...limits }
		this._props = props ?? {}
	}

	_wire(
		resolverOrModule: (() => ResolvedTarget) | Record<string, unknown>,
		env?: Record<string, unknown>,
		compatibility: CompatibilitySelection = legacyCompatibility,
	): void {
		if (typeof resolverOrModule === 'function' && env === undefined) {
			// New API: resolver function
			this._resolver = resolverOrModule as () => ResolvedTarget
		} else {
			// Legacy API: _wire(workerModule, env)
			const workerModule = resolverOrModule as Record<string, unknown>
			const capturedEnv = env!
			this._resolver = () => ({ kind: 'in-process', workerModule, env: capturedEnv, compatibility })
		}
	}

	get isWired(): boolean {
		return this._resolver !== null
	}

	private _resolve(): ResolvedTarget {
		if (!this._resolver) {
			throw new Error(`Service binding "${this._serviceName}" is not wired — target worker not loaded`)
		}
		return this._resolver()
	}

	private _checkSubrequestLimit(): void {
		// Prefer the per-top-level-request counter on the active span context so
		// the budget resets each incoming request (Cloudflare semantics). Fall
		// back to the per-binding counter only when there is no request context
		// (direct or programmatic use, e.g. tests) — otherwise the count would
		// leak across the whole dev-server lifetime and eventually 500 every
		// asset request that goes through a service binding.
		const requestCounter = getActiveContext()?.subrequests
		const count = requestCounter ? ++requestCounter.count : ++this._subrequestCount
		if (count > this._limits.maxSubrequests) {
			throw new Error(
				`Service binding "${this._serviceName}": subrequest limit exceeded (max ${this._limits.maxSubrequests})`,
			)
		}
	}

	private async _invokeFallback<T>(
		resolved: ResolvedTarget,
		name: string,
		callback: (ctx: ExecutionContext, invocation: InvocationTrace, target: Extract<ResolvedTarget, { kind: 'in-process' }>) => T | Promise<T>,
	): Promise<T> {
		// An assets-only worker has no script, so it exposes no RPC surface at all —
		// say that plainly instead of blaming thread isolation.
		if (resolved.kind === 'assets') {
			throw new Error(
				`Service binding "${this._serviceName}": the target is an assets-only worker (no "main"), so it has no RPC methods — only fetch() is available`,
			)
		}
		if (resolved.kind !== 'in-process') {
			throw new Error(
				`Service binding "${this._serviceName}": in-process resolve attempted but the target worker runs in thread isolation — calls must route through the thread executor`,
			)
		}
		const invocation = createInvocationTrace({ name, kind: 'server', workerName: this._serviceName })
		return runWithCompatibility(resolved.compatibility, () =>
			invocation.run(async () => {
				try {
					const ctx = new ExecutionContext(this._props)
					const result = await runWithExecutionContext(ctx, () => callback(ctx, invocation, resolved))
					invocation.finishHandler()
					return result
				} catch (error) {
					invocation.finishHandler({ kind: 'error', error })
					throw error
				}
			}))
	}

	private _invokeRpcFallback(
		resolved: ResolvedTarget,
		method: string,
		callback: (target: Record<string, unknown>, session: RpcSession) => unknown,
	): Promise<unknown> {
		const caller = getActiveInvocation()
		return this._invokeFallback(resolved, `rpc ${this._entrypoint ?? 'default'}.${method}`, async (ctx, invocation, target) => {
			const session = createRpcSession({
				run: callback => runWithCompatibility(target.compatibility, () => invocation.run(() => runWithExecutionContext(ctx, callback))),
				retain: () => invocation.retain('handler'),
				isClosed: () => invocation.closed || caller?.closed === true,
			})
			void caller?.completed.then(() => session.close())
			void invocation.completed.then(() => session.close())
			try {
				return await session.run(() => {
					const instance = resolveEntrypointTarget(target.workerModule, this._entrypoint, ctx, target.env)
					return callback(instance, session)
				})
			} finally {
				session.finish()
			}
		})
	}

	async fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
		const request = workerRequest(input, init)

		// Resolve first so a missing target throws the real error instead of
		// burning a slot in the per-request subrequest budget on every failed call.
		const resolved = this._resolve()
		this._checkSubrequestLimit()
		if (resolved.kind === 'thread') {
			return resolved.executor.executeFetch(request, this._props, this._entrypoint, true)
		}
		// Assets-only target: no script to invoke — its asset layer answers, including
		// its own html_handling / not_found_handling. A declared `entrypoint` names an
		// export of a script that doesn't exist, so serving assets would quietly ignore
		// what the binding asked for.
		if (resolved.kind === 'assets') {
			if (this._entrypoint) {
				throw new Error(
					`Service binding "${this._serviceName}": entrypoint "${this._entrypoint}" was requested, but the target is an assets-only worker (no "main") and exports nothing — drop the entrypoint to serve its static assets`,
				)
			}
			// Same gate as direct dispatch: a binding must not turn `POST /file` into a
			// 200 that the worker itself would answer with 405.
			const rejection = assetsOnlyRejection(request)
			if (rejection) return rejection
			return resolved.assets.fetch(request)
		}

		const dispatcher = getWorkerDispatcher(resolved.workerModule, resolved.env)
		if (dispatcher) return dispatcher.fetch(request, this._entrypoint, this._props, true)
		return this._invokeFallback(resolved, `${request.method} ${new URL(request.url).pathname}`, async (ctx, invocation) => {
			const target = resolveEntrypointTarget(resolved.workerModule, this._entrypoint, ctx, resolved.env)
			const handler = target?.fetch
			if (typeof handler !== 'function') {
				throw new Error(`Service binding "${this._serviceName}" target has no fetch() handler`)
			}
			const def = resolved.workerModule.default
			const isClass = this._entrypoint || (typeof def === 'function' && def.prototype)
			const response: unknown = await Reflect.apply(handler, target, isClass ? [request] : [request, resolved.env, ctx])
			if (!isWorkerResponse(response)) throw new TypeError('Worker fetch must return a Response')
			const tracked = trackInvocationResponse(response, invocation, ctx)
			invocation.root.setAttribute('http.status_code', response.status)
			if (response.status >= 500) invocation.finishHandler({ kind: 'error', error: new Error(`HTTP ${response.status}`) })
			return tracked
		})
	}

	connect(_address: string | { hostname: string; port: number }): never {
		throw serviceBindingConnectError(this._serviceName)
	}

	toProxy(): Record<string, unknown> {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const self = this
		return new Proxy({} as Record<string, unknown>, {
			get(_obj, prop: string | symbol) {
				if (typeof prop === 'symbol') {
					if (NON_RPC_PROPS.has(prop)) return undefined
					return undefined
				}

				if (prop === 'fetch') {
					return self.fetch.bind(self)
				}
				if (prop === 'connect') {
					return self.connect.bind(self)
				}
				if (INTERNAL_PROPS.has(prop)) {
					const val = (self as unknown as Record<string, unknown>)[prop]
					if (typeof val === 'function') return val.bind(self)
					return val
				}
				// Non-RPC props should not trigger proxy behavior
				if (NON_RPC_PROPS.has(prop)) {
					return undefined
				}

				// RPC: return a callable that also acts as a thenable for property access
				// If called as a function → RPC method call (always returns Promise)
				// If awaited → RPC property read (returns Promise of the property value)
				const rpcCallable = (...args: unknown[]) => {
					warnInvalidRpcArgs(args, prop)
					// Resolve first so a missing target throws the real error before
					// the budget moves.
					const resolved = self._resolve()
					self._checkSubrequestLimit()
					if (resolved.kind === 'thread') {
						return resolved.executor.executeEntrypointRpc(self._entrypoint, prop, args, self._props)
							.then((r) => wrapRpcReturnValue(r, prop))
					}
					if (resolved.kind === 'in-process') {
						const dispatcher = getWorkerDispatcher(resolved.workerModule, resolved.env)
						if (dispatcher) return dispatcher.rpc(self._entrypoint, prop, args, self._props)
					}
					return self._invokeRpcFallback(resolved, prop, async (target, session) => {
						const member = target[prop]
						if (typeof member !== 'function') {
							throw new Error(`Service binding "${self._serviceName}": "${prop}" is not a method on the target`)
						}
						const value: unknown = await Reflect.apply(member, target, args)
						return session.run(() => wrapRpcReturnValue(value, prop, session))
					})
				}

				// Make it thenable for property access: `await binding.prop`
				rpcCallable.then = (
					onFulfilled?: ((value: unknown) => unknown) | null,
					onRejected?: ((reason: unknown) => unknown) | null,
				) => {
					// Resolve before incrementing so a missing target doesn't burn budget.
					const resolved = self._resolve()
					self._checkSubrequestLimit()
					if (resolved.kind === 'thread') {
						const executor = resolved.executor
						const entrypoint = self._entrypoint
						const props = self._props
						const promise = executor.executeEntrypointPropertyGet(entrypoint, prop, props).then((result) => {
							if (result.kind === 'function') {
								// Property is a function on the entrypoint — hand back a function-stub
								// that RPCs through to the worker thread on each call.
								const remoteFn = (...callArgs: unknown[]) => executor.executeEntrypointRpc(entrypoint, prop, callArgs, props)
								return createRpcFunctionStub(remoteFn, undefined)
							}
							return wrapRpcReturnValue(result.value, prop)
						})
						return promise.then(onFulfilled, onRejected)
					}
					if (resolved.kind === 'in-process') {
						const dispatcher = getWorkerDispatcher(resolved.workerModule, resolved.env)
						if (dispatcher) return dispatcher.property(self._entrypoint, prop, self._props).then(onFulfilled, onRejected)
					}
					const promise = self._invokeRpcFallback(resolved, prop, async (target, session) => {
						const member: unknown = await target[prop]
						return session.run(() => {
							return typeof member === 'function'
								? createRpcFunctionStub(member, target, session)
								: wrapRpcReturnValue(member, prop, session)
						})
					})
					return promise.then(onFulfilled, onRejected)
				}

				return rpcCallable
			},
		})
	}
}

/**
 * Create a service binding proxy.
 */
export function createServiceBinding(
	serviceName: string,
	entrypoint?: string,
	limits?: ServiceBindingLimits,
	props?: Record<string, unknown>,
): Record<string, unknown> {
	const binding = new ServiceBinding(serviceName, entrypoint, limits, props)
	return binding.toProxy()
}
