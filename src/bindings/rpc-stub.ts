/**
 * RPC stub utilities for wrapping RpcTarget instances and functions
 * returned from DO/service binding RPC calls.
 *
 * On Cloudflare, when an RPC method returns an RpcTarget or function,
 * CF wraps it in a stub proxy. This module provides equivalent local
 * wrapping so code behaves consistently between dev and production.
 */

import { warnInvalidRpcArgs, warnInvalidRpcReturn } from '../rpc-validate'
import type { RpcLease } from './rpc-session'

// Brand symbol shared across plugin.ts and vite-plugin/modules-plugin.ts
export const RPC_TARGET_BRAND = Symbol.for('lopata.RpcTarget')

export function isRpcTarget(value: unknown): boolean {
	return (
		value !== null
		&& typeof value === 'object'
		&& (value as Record<symbol, unknown>)[RPC_TARGET_BRAND] === true
	)
}

// Properties that should NOT be proxied as RPC (JS internals, Promise protocol, etc.)
export const NON_RPC_PROPS = new Set<string | symbol>([
	'then',
	'catch',
	'finally', // Promise/thenable protocol
	'toJSON',
	'valueOf',
	'toString', // conversion
	Symbol.toPrimitive,
	Symbol.toStringTag,
	Symbol.iterator,
	Symbol.asyncIterator,
	// `using` / `await using` declarations. The lookup happens on the proxy
	// itself; without a special-case, Symbol-keyed names cross the worker
	// boundary as RPC method names and crash with `DataCloneError`. ECMA-262
	// requires the looked-up value to be callable when the resource is an
	// object, so every proxy that exposes a `using`-disposable shape must
	// return `noopDispose` for these symbols *before* hitting this set.
	Symbol.dispose,
	Symbol.asyncDispose,
])

/** No-op disposer shared by every proxy that needs to satisfy `using` declarations. */
export const noopDispose: () => void = () => {}

/**
 * Build a Proxy that exposes `.fetch` (HTTP round-trip) and turns any other
 * property access into a method call. Used to construct cross-thread binding
 * proxies — main-worker service bindings, DO stubs, and DO-worker env-binding
 * proxies all share this shape.
 *
 * `callbacks.call` is invoked for any prop that isn't `'fetch'` or in
 * `NON_RPC_PROPS`. `extras` overrides specific props (DO stubs use it to
 * surface `id`/`name`, service bindings to surface `connect`). Per-prop
 * methods are cached so hot callers don't allocate a fresh closure per
 * access.
 */
export function makeBindingProxy(
	callbacks: {
		fetch: (input: Request | string | URL, init?: RequestInit) => Promise<Response>
		call: (prop: string, args: unknown[]) => unknown
		/** Optional property read (`await binding.prop`). When supplied, the
		 *  per-prop callable is also thenable, issuing a property-get instead of
		 *  resolving to the function itself. */
		getProperty?: (prop: string) => Promise<unknown>
	},
	extras: Record<string | symbol, unknown> = {},
): Record<string, unknown> {
	const methodCache = new Map<string | symbol, unknown>()
	return new Proxy({} as Record<string, unknown>, {
		get(_obj, prop) {
			if (prop === Symbol.dispose || prop === Symbol.asyncDispose) return noopDispose
			if (NON_RPC_PROPS.has(prop)) return undefined
			if (prop in extras) return extras[prop]
			// Any other symbol key (user `Symbol.for(...)`, an unlisted well-known
			// symbol) must not become an RPC method name — symbols aren't
			// structured-cloneable and would throw DataCloneError. Mirrors the guard
			// in createRpcStub / the service-binding proxy.
			if (typeof prop === 'symbol') return undefined
			const cached = methodCache.get(prop)
			if (cached) return cached
			if (prop === 'fetch') {
				methodCache.set(prop, callbacks.fetch)
				return callbacks.fetch
			}
			const fn = (...args: unknown[]) => callbacks.call(prop as string, args)
			// Make the callable thenable so `await binding.prop` does a property-get
			// RPC (matching CF + the in-process path) instead of awaiting the
			// function object and resolving to it.
			if (callbacks.getProperty) {
				const getProperty = callbacks.getProperty
				;(fn as { then?: unknown }).then = (
					onFulfilled?: ((value: unknown) => unknown) | null,
					onRejected?: ((reason: unknown) => unknown) | null,
				) => getProperty(prop as string).then(onFulfilled, onRejected)
			}
			methodCache.set(prop, fn)
			return fn
		},
	})
}

// Cache to avoid wrapping the same target twice (handles `return this`)
const stubCache = new WeakMap<object, object>()
export interface RpcExecutionScope {
	run<T>(callback: () => T): T
	retain?(): RpcLease
	/** Wrap caller-facing promises outside run() so interruption cannot settle the actual call. */
	awaitResult?<T>(pending: Promise<T>): Promise<T>
}
const scopedStubCaches = new WeakMap<RpcExecutionScope, WeakMap<object, object>>()
interface RpcStubOwner {
	scope: RpcExecutionScope | undefined
	receiver: RpcExecutionScope | undefined
	run<T>(callback: () => T): T
	rebind(scope: RpcExecutionScope): object
	dispose(): void
}
const stubOwners = new WeakMap<object, RpcStubOwner>()
const scopeReceivers = new WeakMap<RpcExecutionScope, RpcExecutionScope>()
const rpcDisposers = new WeakMap<object, () => void>()

function withinScope<T>(scope: RpcExecutionScope | undefined, callback: () => T): T {
	return scope ? scope.run(callback) : callback()
}

function awaitScopedResult<T>(scope: RpcExecutionScope | undefined, pending: Promise<T>): Promise<T> {
	return scope?.awaitResult ? scope.awaitResult(pending) : pending
}

/**
 * Wrap an RpcTarget instance in a Proxy that mimics CF stub behavior:
 * - Method calls: validate args → call → wrap return value
 * - Property access: thenable pattern, wraps returned RpcTarget/function values
 * - Filters `_`-prefixed properties (returns undefined)
 * - Session-backed stubs own a disposable lease; legacy stubs use no-op disposal
 * - dup() → new stub wrapping same target
 */
export function createRpcStub(target: object, scope?: RpcExecutionScope): object {
	let cache = scope ? scopedStubCaches.get(scope) : stubCache
	if (!cache) {
		cache = new WeakMap()
		if (scope) scopedStubCaches.set(scope, cache)
	}
	const cached = scope?.retain ? undefined : cache.get(target)
	if (cached) return cached
	const stub = createRpcStubUncached(target, scope)
	if (!scope?.retain) cache.set(target, stub)
	return stub
}

/** Create a stub without caching (used by dup()) */
function createRpcStubUncached(target: object, scope?: RpcExecutionScope): object {
	const lease = scope?.retain?.()
	const execution = lease ?? scope
	const stub = new Proxy({}, {
		get(_obj, prop: string | symbol) {
			if (prop === Symbol.dispose || prop === Symbol.asyncDispose) return lease ? () => lease.dispose() : noopDispose
			if (NON_RPC_PROPS.has(prop)) return undefined
			if (typeof prop === 'symbol') return undefined
			if (typeof prop === 'string' && prop.startsWith('_')) return undefined
			if (prop === 'dup') return () => withinScope(execution, () => createRpcStubUncached(target, scope))

			const member: unknown = withinScope(execution, () => Reflect.get(target, prop))

			if (typeof member === 'function') {
				const rpcCallable = async (...args: unknown[]) =>
					awaitScopedResult(
						scope,
						withinScope(execution, async () => {
							warnInvalidRpcArgs(args, prop)
							const result: unknown = await Reflect.apply(member, target, args)
							return withinScope(scope, () => wrapRpcReturnValue(result, prop, scope))
						}),
					)
				Object.defineProperty(rpcCallable, 'then', {
					get() {
						const pending = awaitScopedResult(scope, withinScope(execution, async () => createRpcFunctionStub(member, target, scope)))
						return pending.then.bind(pending)
					},
				})
				return rpcCallable
			}

			const rpcCallable = (..._args: unknown[]) => {
				return Promise.reject(new Error(`"${prop}" is not a method on the RPC target`))
			}
			Object.defineProperty(rpcCallable, 'then', {
				get() {
					// Promise assimilation reads `then` synchronously, before invoking it in a microtask.
					const pending = awaitScopedResult(
						scope,
						withinScope(execution, async () => {
							const result = await member
							return withinScope(scope, () => wrapRpcReturnValue(result, prop, scope))
						}),
					)
					return pending.then.bind(pending)
				},
			})
			return rpcCallable
		},
	})
	stubOwners.set(stub, {
		scope,
		receiver: scope ? scopeReceivers.get(scope) ?? scope : undefined,
		run: callback => withinScope(execution, callback),
		rebind: next => createRpcStubUncached(target, next),
		dispose: lease ? () => lease.dispose() : noopDispose,
	})
	if (lease) rpcDisposers.set(stub, () => lease.dispose())
	return stub
}

/**
 * Wrap a function in a callable stub with validation + Symbol.dispose + dup().
 */
export function createRpcFunctionStub(fn: Function, thisArg?: object, scope?: RpcExecutionScope): Function {
	const lease = scope?.retain?.()
	const execution = lease ?? scope
	const stub = async (...args: unknown[]) =>
		awaitScopedResult(
			scope,
			withinScope(execution, async () => {
				warnInvalidRpcArgs(args, fn.name || '<anonymous>')
				const result: unknown = await Reflect.apply(fn, thisArg, args)
				return withinScope(scope, () => wrapRpcReturnValue(result, fn.name || '<anonymous>', scope))
			}),
		)

	Object.defineProperty(stub, Symbol.dispose, {
		value: lease ? () => lease.dispose() : noopDispose,
		writable: false,
		configurable: true,
	})

	Object.defineProperty(stub, Symbol.asyncDispose, {
		value: lease ? () => lease.dispose() : noopDispose,
		writable: false,
		configurable: true,
	})

	Object.defineProperty(stub, 'dup', {
		value: () => withinScope(execution, () => createRpcFunctionStub(fn, thisArg, scope)),
		writable: false,
		configurable: true,
	})

	stubOwners.set(stub, {
		scope,
		receiver: scope ? scopeReceivers.get(scope) ?? scope : undefined,
		run: callback => withinScope(execution, callback),
		rebind: next => createRpcFunctionStub(fn, thisArg, next),
		dispose: lease ? () => lease.dispose() : noopDispose,
	})
	if (lease) rpcDisposers.set(stub, () => lease.dispose())
	return stub
}

/**
 * Wrap a Promise in an RpcPromise proxy that supports promise pipelining.
 *
 * `stub.getChild().childMethod()` works without intermediate await:
 * - then/catch/finally → delegate to underlying promise
 * - Any other property → returns a pipelined callable
 */
export function createRpcPromise(promise: Promise<unknown>): Promise<unknown> {
	return new Proxy(promise, {
		get(target, prop: string | symbol) {
			// Promise protocol — delegate to the underlying promise
			if (prop === 'then' || prop === 'catch' || prop === 'finally') {
				const method = target[prop as keyof Promise<unknown>] as Function
				return method.bind(target)
			}

			if (prop === Symbol.dispose || prop === Symbol.asyncDispose) return noopDispose

			// dup() — new RpcPromise wrapping same promise
			if (prop === 'dup') return () => createRpcPromise(promise)

			// NON_RPC_PROPS (excluding then/catch/finally already handled)
			if (NON_RPC_PROPS.has(prop)) return undefined

			if (typeof prop === 'symbol') return undefined

			// Filter _-prefixed
			if (prop.startsWith('_')) return undefined

			// Promise pipelining: property access chains through the resolved value
			const pipelined = (...args: unknown[]) => {
				const chained = promise.then((resolved) => {
					if (resolved === null || resolved === undefined) {
						throw new Error(`Cannot access "${prop}" on ${String(resolved)}`)
					}
					const member = (resolved as Record<string, unknown>)[prop]
					if (typeof member !== 'function') {
						throw new Error(`"${prop}" is not a method on the resolved value`)
					}
					return (member as Function).call(resolved, ...args)
				}).then((r) => wrapRpcReturnValue(r, prop))
				return createRpcPromise(chained)
			}

			// Make pipelined callable also thenable for property access
			pipelined.then = (
				onFulfilled?: ((value: unknown) => unknown) | null,
				onRejected?: ((reason: unknown) => unknown) | null,
			) => {
				const chained = promise.then((resolved) => {
					if (resolved === null || resolved === undefined) {
						return undefined
					}
					const member = (resolved as Record<string, unknown>)[prop]
					if (typeof member === 'function') {
						return createRpcFunctionStub(member as Function, resolved as object)
					}
					return wrapRpcReturnValue(member, prop)
				})
				return chained.then(onFulfilled, onRejected)
			}

			return pipelined
		},
	}) as Promise<unknown>
}

/**
 * Inspect a return value and wrap it appropriately:
 * - RpcTarget instance → createRpcStub()
 * - Function → createRpcFunctionStub()
 * - Otherwise → warn if invalid + pass through
 */
export function wrapRpcReturnValue(value: unknown, context: string, scope?: RpcExecutionScope): unknown {
	const acquired: (() => void)[] = []
	const transferred: (() => void)[] = []
	try {
		const result = wrapRpcValue(value, context, scope, new Map(), acquired, transferred)
		disposeRpcValues(transferred)
		return result
	} catch (error) {
		try {
			disposeRpcValues(acquired)
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], 'RPC result wrapping and cleanup failed')
		}
		throw error
	}
}

function forwardingScope(receiver: RpcExecutionScope, retain: () => RpcLease, origin: RpcExecutionScope | undefined): RpcExecutionScope {
	const scope: RpcExecutionScope = {
		run: callback => withinScope(receiver, () => withinScope(origin, callback)),
		awaitResult: pending => awaitScopedResult(receiver, awaitScopedResult(origin, pending)),
		retain() {
			const receivingLease = retain()
			let originatingLease: RpcLease | undefined
			try {
				originatingLease = origin?.retain?.()
			} catch (error) {
				receivingLease.dispose()
				throw error
			}
			let disposed = false
			return {
				run: callback => receivingLease.run(() => withinScope(originatingLease ?? origin, callback)),
				dispose() {
					if (disposed) return
					disposed = true
					disposeRpcValues([
						() => originatingLease?.dispose(),
						() => receivingLease.dispose(),
					])
				},
			}
		},
	}
	scopeReceivers.set(scope, receiver)
	return scope
}

function disposeRpcValues(disposers: readonly (() => void)[]): void {
	const errors: unknown[] = []
	for (const dispose of disposers) {
		try {
			dispose()
		} catch (error) {
			errors.push(error)
		}
	}
	if (errors.length) throw new AggregateError(errors, 'RPC result disposal failed')
}

function wrapRpcValue(
	value: unknown,
	context: string,
	scope: RpcExecutionScope | undefined,
	seen: Map<object, object>,
	acquired: (() => void)[],
	transferred: (() => void)[],
): unknown {
	if (value === null || value === undefined) return value
	if (typeof value === 'object' || typeof value === 'function') {
		const owner = stubOwners.get(value)
		if (owner) {
			if (!scope?.retain || owner.scope === scope || owner.receiver === scope) return value
			const previous = seen.get(value)
			if (previous) return previous
			const retain = scope.retain.bind(scope)
			const forwarded = owner.run(() => owner.rebind(forwardingScope(scope, retain, owner.scope)))
			seen.set(value, forwarded)
			const dispose = rpcDisposers.get(forwarded)
			if (dispose) acquired.push(dispose)
			transferred.push(() => owner.dispose())
			return forwarded
		}
	}

	if (isRpcTarget(value)) {
		if (typeof value === 'object') {
			const stub = createRpcStub(value, scope)
			const dispose = rpcDisposers.get(stub)
			if (dispose) acquired.push(dispose)
			return stub
		}
	}

	if (typeof value === 'function') {
		const stub = createRpcFunctionStub(value, undefined, scope)
		const dispose = rpcDisposers.get(stub)
		if (dispose) acquired.push(dispose)
		return stub
	}

	if (
		scope?.retain && typeof value === 'object'
		&& (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
	) {
		const previous = seen.get(value)
		if (previous) return previous
		const result: unknown[] | Record<string, unknown> = Array.isArray(value) ? new Array(value.length) : {}
		if (Object.getPrototypeOf(value) === null) Object.setPrototypeOf(result, null)
		seen.set(value, result)
		const children: (() => void)[] = []
		let disposed = false
		const dispose = () => {
			if (disposed) return
			disposed = true
			disposeRpcValues(children)
		}
		Object.defineProperty(result, Symbol.dispose, { value: dispose })
		Object.defineProperty(result, Symbol.asyncDispose, { value: dispose })
		rpcDisposers.set(result, dispose)
		// Read each enumerable property once, matching the existing RPC serialization contract.
		for (const key of Object.keys(value)) {
			const child: unknown = withinScope(scope, () => Reflect.get(value, key))
			const wrapped = wrapRpcValue(child, context, scope, seen, acquired, transferred)
			Object.defineProperty(result, key, { value: wrapped, enumerable: true, writable: true, configurable: true })
			if (wrapped !== null && (typeof wrapped === 'object' || typeof wrapped === 'function')) {
				const dispose = rpcDisposers.get(wrapped)
				if (dispose) children.push(dispose)
			}
		}
		return result
	}

	// Not an RpcTarget or function — validate and pass through
	warnInvalidRpcReturn(value, context)
	return value
}
