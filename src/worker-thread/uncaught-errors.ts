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
import { CFWebSocket } from '../bindings/websocket-pair'

class PromiseRejectionEvent extends Event {
	readonly promise: Promise<unknown>
	readonly reason: unknown

	constructor(type: string, init: { promise: Promise<unknown>; reason?: unknown }) {
		super(type)
		this.promise = init.promise
		this.reason = init.reason
	}
}

interface CommandScope {
	/** Set once an uncaught exception failed the command before it completed. */
	failed: boolean
	fail: (error: unknown) => void
}

/** The command (request, RPC call, DO command) whose async context scheduled the throwing task. */
const commandScope = new AsyncLocalStorage<CommandScope>()

/**
 * Runs one dispatched command so that an uncaught exception from a task it scheduled
 * fails this command only. workerd just logs such an exception and later cancels a
 * request that can no longer produce a response (`IoContext::abortFromHang`); failing it
 * with the thrown error is the approximation. Concurrent commands are unaffected.
 */
export function runFailableCommand<T>(dispatch: () => Promise<T>, onLateResult?: (late: T) => void): Promise<T> {
	const failure = Promise.withResolvers<never>()
	let completed = false
	const scope: CommandScope = {
		failed: false,
		fail: error => {
			if (completed || scope.failed) return
			scope.failed = true
			failure.reject(error)
		},
	}
	return commandScope.run(scope, () => {
		const result = dispatch()
		// The caller already got the failure; release what the handler produced after all.
		result.then(late => {
			if (scope.failed) onLateResult?.(late)
		}, () => {})
		return Promise.race([result, failure.promise]).finally(() => {
			completed = true
		})
	})
}

/** Whether the command running in this async context already failed, so its result will be discarded. */
export function currentCommandFailed(): boolean {
	return commandScope.getStore()?.failed ?? false
}

/** Releases a response nobody will read: stops its body producer and closes a returned WebSocket. */
export function discardResponse(response: Response): void {
	response.body?.cancel().catch(() => {})
	if ('webSocket' in response && response.webSocket instanceof CFWebSocket) response.webSocket.close(1011, 'request failed')
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
		commandScope.getStore()?.fail(err)
	})
}
