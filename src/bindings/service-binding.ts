/**
 * Service Binding — worker-to-worker communication via HTTP fetch and RPC.
 *
 * The binding is a Proxy that supports:
 * - `.fetch(request | url, init?)` — calls the target worker's fetch() handler
 * - `.myMethod(args)` — RPC call to the target's entrypoint class method (always returns Promise)
 * - `.myProperty` — RPC property access (returns thenable/Promise)
 * - `.connect()` — stub for TCP socket (throws — not supported in dev)
 */

import { ExecutionContext } from '../execution-context'
import { warnInvalidRpcArgs } from '../rpc-validate'
import { getActiveContext, runWithContext } from '../tracing/context'
import type { ResolvedTarget } from '../worker-registry'
import { createRpcFunctionStub, NON_RPC_PROPS, wrapRpcReturnValue } from './rpc-stub'

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
 * Used by `ServiceBinding._getTarget` (in-process) and the worker-thread's
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
	): void {
		if (typeof resolverOrModule === 'function' && env === undefined) {
			// New API: resolver function
			this._resolver = resolverOrModule as () => ResolvedTarget
		} else {
			// Legacy API: _wire(workerModule, env)
			const workerModule = resolverOrModule as Record<string, unknown>
			const capturedEnv = env!
			this._resolver = () => ({ kind: 'in-process', workerModule, env: capturedEnv })
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

	private _getTarget(ctx?: ExecutionContext): Record<string, unknown> {
		const resolved = this._resolve()
		if (resolved.kind !== 'in-process') {
			throw new Error(
				`Service binding "${this._serviceName}": in-process resolve attempted but the target worker runs in thread isolation — calls must route through the thread executor`,
			)
		}
		const execCtx = ctx ?? new ExecutionContext(this._props)
		return resolveEntrypointTarget(resolved.workerModule, this._entrypoint, execCtx, resolved.env)
	}

	async fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
		const url = input instanceof URL ? input.toString() : input
		const request = typeof url === 'string' ? new Request(url, init) : url

		// Resolve first so a missing target throws the real error instead of
		// burning a slot in the per-request subrequest budget on every failed call.
		const resolved = this._resolve()
		this._checkSubrequestLimit()
		if (resolved.kind === 'thread') {
			return resolved.executor.executeFetch(request, this._props)
		}

		const execCtx = new ExecutionContext(this._props)
		const target = this._getTarget(execCtx)
		if (!target?.fetch || typeof target.fetch !== 'function') {
			throw new Error(`Service binding "${this._serviceName}" target has no fetch() handler`)
		}
		const { workerModule, env } = resolved
		const def = workerModule.default
		const isClass = this._entrypoint || (typeof def === 'function' && def.prototype?.fetch)

		const parentCtx = getActiveContext()
		const doCall = async () => {
			const response = isClass
				? await (target.fetch as (r: Request) => Promise<Response>)(request)
				: await (target.fetch as (r: Request, e: unknown, c: ExecutionContext) => Promise<Response>)(request, env, execCtx)
			execCtx._awaitAll().catch(() => {})
			return response
		}

		if (parentCtx) {
			return runWithContext(parentCtx, doCall)
		}
		return doCall()
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
					const target = self._getTarget()
					const member = target[prop]
					if (typeof member !== 'function') {
						throw new Error(`Service binding "${self._serviceName}": "${prop}" is not a method on the target`)
					}
					// Propagate trace context so child spans link correctly
					const parentCtx = getActiveContext()
					const doCall = () => (member as (...a: unknown[]) => unknown).call(target, ...args)
					const result = parentCtx
						? runWithContext(parentCtx, doCall)
						: doCall()
					// CF always wraps in Promise for async consistency
					return Promise.resolve(result).then((r) => wrapRpcReturnValue(r, prop))
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
					const promise = new Promise<unknown>((resolveP, rejectP) => {
						try {
							const target = self._getTarget()
							const member = target[prop]
							if (typeof member === 'function') {
								resolveP(createRpcFunctionStub(member as Function, target))
							} else {
								resolveP(wrapRpcReturnValue(member, prop))
							}
						} catch (e) {
							rejectP(e)
						}
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
