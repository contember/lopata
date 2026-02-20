/**
 * RPC stub utilities for wrapping RpcTarget instances and functions
 * returned from DO/service binding RPC calls.
 *
 * On Cloudflare, when an RPC method returns an RpcTarget or function,
 * CF wraps it in a stub proxy. This module provides equivalent local
 * wrapping so code behaves consistently between dev and production.
 */

import { warnInvalidRpcArgs, warnInvalidRpcReturn } from '../rpc-validate'

// Brand symbol shared across plugin.ts and vite-plugin/modules-plugin.ts
export const RPC_TARGET_BRAND = Symbol.for('bunflare.RpcTarget')

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
])

// Cache to avoid wrapping the same target twice (handles `return this`)
const stubCache = new WeakMap<object, object>()

/**
 * Wrap an RpcTarget instance in a Proxy that mimics CF stub behavior:
 * - Method calls: validate args → call → wrap return value
 * - Property access: thenable pattern, wraps returned RpcTarget/function values
 * - Filters `_`-prefixed properties (returns undefined)
 * - Symbol.dispose → no-op
 * - dup() → new stub wrapping same target
 */
export function createRpcStub(target: object): object {
	const cached = stubCache.get(target)
	if (cached) return cached

	const stub = new Proxy({} as Record<string, unknown>, {
		get(_obj, prop: string | symbol) {
			if (NON_RPC_PROPS.has(prop)) return undefined

			// Symbol.dispose — no-op for `using` keyword compatibility
			if (prop === Symbol.dispose) {
				return () => {}
			}

			if (typeof prop === 'symbol') return undefined

			// Filter _-prefixed private members (CF hides these)
			if (prop.startsWith('_')) return undefined

			// dup() — returns a new stub wrapping the same target
			if (prop === 'dup') {
				return () => {
					// Create a fresh stub (bypass cache)
					const dup = createRpcStubUncached(target)
					return dup
				}
			}

			const member = (target as Record<string, unknown>)[prop]

			// If it's a function, return an rpcCallable with thenable for property access
			if (typeof member === 'function') {
				const rpcCallable = (...args: unknown[]) => {
					warnInvalidRpcArgs(args, prop)
					const result = (member as Function).call(target, ...args)
					return Promise.resolve(result).then((r) => wrapRpcReturnValue(r, prop))
				}

				// Thenable for `await stub.method` (returns the wrapped function itself)
				rpcCallable.then = (
					onFulfilled?: ((value: unknown) => unknown) | null,
					onRejected?: ((reason: unknown) => unknown) | null,
				) => {
					const wrapped = createRpcFunctionStub(member as Function, target)
					return Promise.resolve(wrapped).then(onFulfilled, onRejected)
				}

				return rpcCallable
			}

			// Non-function property: return thenable
			const rpcCallable = (..._args: unknown[]) => {
				return Promise.reject(new Error(`"${prop}" is not a method on the RPC target`))
			}

			rpcCallable.then = (
				onFulfilled?: ((value: unknown) => unknown) | null,
				onRejected?: ((reason: unknown) => unknown) | null,
			) => {
				const wrapped = wrapRpcReturnValue(member, prop)
				return Promise.resolve(wrapped).then(onFulfilled, onRejected)
			}

			return rpcCallable
		},
	})

	stubCache.set(target, stub)
	return stub
}

/** Create a stub without caching (used by dup()) */
function createRpcStubUncached(target: object): object {
	return new Proxy({} as Record<string, unknown>, {
		get(_obj, prop: string | symbol) {
			if (NON_RPC_PROPS.has(prop)) return undefined
			if (prop === Symbol.dispose) return () => {}
			if (typeof prop === 'symbol') return undefined
			if (typeof prop === 'string' && prop.startsWith('_')) return undefined
			if (prop === 'dup') return () => createRpcStubUncached(target)

			const member = (target as Record<string, unknown>)[prop]

			if (typeof member === 'function') {
				const rpcCallable = (...args: unknown[]) => {
					warnInvalidRpcArgs(args, prop as string)
					const result = (member as Function).call(target, ...args)
					return Promise.resolve(result).then((r) => wrapRpcReturnValue(r, prop as string))
				}
				rpcCallable.then = (
					onFulfilled?: ((value: unknown) => unknown) | null,
					onRejected?: ((reason: unknown) => unknown) | null,
				) => {
					const wrapped = createRpcFunctionStub(member as Function, target)
					return Promise.resolve(wrapped).then(onFulfilled, onRejected)
				}
				return rpcCallable
			}

			const rpcCallable = (..._args: unknown[]) => {
				return Promise.reject(new Error(`"${prop}" is not a method on the RPC target`))
			}
			rpcCallable.then = (
				onFulfilled?: ((value: unknown) => unknown) | null,
				onRejected?: ((reason: unknown) => unknown) | null,
			) => {
				const wrapped = wrapRpcReturnValue(member, prop as string)
				return Promise.resolve(wrapped).then(onFulfilled, onRejected)
			}
			return rpcCallable
		},
	})
}

/**
 * Wrap a function in a callable stub with validation + Symbol.dispose + dup().
 */
export function createRpcFunctionStub(fn: Function, thisArg?: object): Function {
	const stub = (...args: unknown[]) => {
		warnInvalidRpcArgs(args, fn.name || '<anonymous>')
		const result = fn.call(thisArg, ...args)
		return Promise.resolve(result).then((r) => wrapRpcReturnValue(r, fn.name || '<anonymous>'))
	}

	Object.defineProperty(stub, Symbol.dispose, {
		value: () => {},
		writable: false,
		configurable: true,
	})

	Object.defineProperty(stub, 'dup', {
		value: () => createRpcFunctionStub(fn, thisArg),
		writable: false,
		configurable: true,
	})

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

			// Symbol.dispose — no-op
			if (prop === Symbol.dispose) return () => {}

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
export function wrapRpcReturnValue(value: unknown, context: string): unknown {
	if (value === null || value === undefined) return value

	if (isRpcTarget(value)) {
		return createRpcStub(value as object)
	}

	if (typeof value === 'function') {
		return createRpcFunctionStub(value as Function)
	}

	// Not an RpcTarget or function — validate and pass through
	warnInvalidRpcReturn(value, context)
	return value
}
