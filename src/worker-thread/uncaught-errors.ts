/**
 * Unhandled rejections and uncaught exceptions inside a worker thread (user worker or
 * Durable Object). Without process handlers Bun treats either as fatal and closes the
 * thread; workerd keeps the isolate serving. An unhandled rejection is logged and
 * dispatched as `unhandledrejection` / `rejectionhandled` on the global scope
 * (workerd src/workerd/api/global-scope.c++ `emitPromiseRejection`, src/workerd/jsg/promise.c++).
 * An exception thrown by a task (timer, event listener) is logged
 * (workerd src/workerd/io/io-context.c++ `IoContext::taskFailed`); see `runFailableCommand`.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

class PromiseRejectionEvent extends Event {
	readonly promise: Promise<unknown>
	readonly reason: unknown

	constructor(type: string, init: { promise: Promise<unknown>; reason?: unknown }) {
		super(type)
		this.promise = init.promise
		this.reason = init.reason
	}
}

/** Fails the command (request, RPC call, DO command) whose async context scheduled the throwing task. */
const commandFailure = new AsyncLocalStorage<(error: unknown) => void>()

/**
 * Runs one dispatched command so that an uncaught exception from a task it scheduled
 * fails this command only. workerd just logs such an exception and later cancels a
 * request that can no longer produce a response (`IoContext::abortFromHang`); failing it
 * with the thrown error is the approximation. Concurrent commands are unaffected.
 */
export function runFailableCommand<T>(dispatch: () => Promise<T>): Promise<T> {
	const failure = Promise.withResolvers<never>()
	return commandFailure.run(failure.reject, () => Promise.race([dispatch(), failure.promise]))
}

// Bun's global scope is an EventTarget, but its types do not declare a global `dispatchEvent`.
function dispatchRejectionEvent(event: PromiseRejectionEvent): void {
	EventTarget.prototype.dispatchEvent.call(globalThis, event)
}

export function installUncaughtErrorHandlers(): void {
	Object.defineProperty(globalThis, 'PromiseRejectionEvent', { value: PromiseRejectionEvent, writable: true, configurable: true })
	process.on('unhandledRejection', (reason, promise) => {
		console.error('[lopata] Unhandled promise rejection:', reason)
		dispatchRejectionEvent(new PromiseRejectionEvent('unhandledrejection', { promise, reason }))
	})
	// workerd dispatches `rejectionhandled` without a reason.
	process.on('rejectionHandled', promise => {
		dispatchRejectionEvent(new PromiseRejectionEvent('rejectionhandled', { promise }))
	})
	// Bun reports exceptions from timers and event listeners (dispatchEvent does not rethrow) here,
	// in the async context that scheduled them. A `queueMicrotask` throw and a throw from an
	// `unhandledrejection` listener arrive without one and are only logged.
	process.on('uncaughtException', err => {
		console.error('[lopata] Uncaught exception:', err)
		commandFailure.getStore()?.(err)
	})
}
