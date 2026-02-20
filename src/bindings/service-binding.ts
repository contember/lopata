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

export class ServiceBinding {
	private _resolver: (() => { workerModule: Record<string, unknown>; env: Record<string, unknown> }) | null = null
	private _entrypoint: string | undefined
	private _serviceName: string
	private _limits: Required<ServiceBindingLimits>
	_subrequestCount: number = 0

	constructor(serviceName: string, entrypoint?: string, limits?: ServiceBindingLimits) {
		this._serviceName = serviceName
		this._entrypoint = entrypoint
		this._limits = { ...SERVICE_BINDING_DEFAULTS, ...limits }
	}

	_wire(
		resolverOrModule: (() => { workerModule: Record<string, unknown>; env: Record<string, unknown> }) | Record<string, unknown>,
		env?: Record<string, unknown>,
	): void {
		if (typeof resolverOrModule === 'function' && env === undefined) {
			// New API: resolver function
			this._resolver = resolverOrModule as () => { workerModule: Record<string, unknown>; env: Record<string, unknown> }
		} else {
			// Legacy API: _wire(workerModule, env)
			const workerModule = resolverOrModule as Record<string, unknown>
			const capturedEnv = env!
			this._resolver = () => ({ workerModule, env: capturedEnv })
		}
	}

	get isWired(): boolean {
		return this._resolver !== null
	}

	private _resolve(): { workerModule: Record<string, unknown>; env: Record<string, unknown> } {
		if (!this._resolver) {
			throw new Error(`Service binding "${this._serviceName}" is not wired — target worker not loaded`)
		}
		return this._resolver()
	}

	private _checkSubrequestLimit(): void {
		this._subrequestCount++
		if (this._subrequestCount > this._limits.maxSubrequests) {
			throw new Error(
				`Service binding "${this._serviceName}": subrequest limit exceeded (max ${this._limits.maxSubrequests})`,
			)
		}
	}

	private _getTarget(ctx?: ExecutionContext): Record<string, unknown> {
		const { workerModule, env } = this._resolve()
		if (this._entrypoint) {
			const cls = workerModule[this._entrypoint] as (new(...args: unknown[]) => Record<string, unknown>) | undefined
			if (!cls) {
				throw new Error(`Entrypoint "${this._entrypoint}" not exported from worker module`)
			}
			return new cls(ctx ?? new ExecutionContext(), env)
		}
		// Default export: could be class-based or object-based
		const def = workerModule.default
		if (typeof def === 'function' && def.prototype && typeof def.prototype.fetch === 'function') {
			return new (def as new(ctx: ExecutionContext, env: unknown) => Record<string, unknown>)(ctx ?? new ExecutionContext(), env)
		}
		return def as Record<string, unknown>
	}

	async fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
		this._checkSubrequestLimit()
		const execCtx = new ExecutionContext()
		const target = this._getTarget(execCtx)
		if (!target?.fetch || typeof target.fetch !== 'function') {
			throw new Error(`Service binding "${this._serviceName}" target has no fetch() handler`)
		}
		const url = input instanceof URL ? input.toString() : input
		const request = typeof url === 'string' ? new Request(url, init) : url
		// Class-based entrypoints receive (request) — env/ctx via constructor
		// Object-based entrypoints receive (request, env, ctx)
		const { workerModule, env } = this._resolve()
		const def = workerModule.default
		const isClass = this._entrypoint || (typeof def === 'function' && def.prototype?.fetch)

		// Propagate trace context to target worker so child spans link correctly
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
		throw new Error(
			`Service binding "${this._serviceName}": connect() (TCP sockets) is not supported in local dev mode`,
		)
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
					self._checkSubrequestLimit()
					warnInvalidRpcArgs(args, prop)
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
					self._checkSubrequestLimit()
					const promise = new Promise<unknown>((resolve, reject) => {
						try {
							const target = self._getTarget()
							const member = target[prop]
							if (typeof member === 'function') {
								resolve(createRpcFunctionStub(member as Function, target))
							} else {
								resolve(wrapRpcReturnValue(member, prop))
							}
						} catch (e) {
							reject(e)
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
): Record<string, unknown> {
	const binding = new ServiceBinding(serviceName, entrypoint, limits)
	return binding.toProxy()
}
