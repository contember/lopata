/**
 * Worker-side stand-in for `TraceStore`. Each operation is forwarded to
 * main via postMessage so the single persistent store + dashboard
 * subscribers stay the source of truth. We keep a tiny local mirror of
 * span statuses because `startSpan` reads `getSpanStatus(spanId)`
 * synchronously and the bridge is async-only.
 */

import type { TraceStore } from '../tracing/store'
import type { SpanData, SpanEventData } from '../tracing/types'
import type { TraceErrorPayload, WorkerMessage } from './protocol'

/** Methods of `TraceStore` actually called from worker-side code. Adding a new
 *  call site against the store from `span.ts` / `instrument.ts` / `setup-globals.ts`
 *  must extend this list (and `RemoteTraceStore` below). */
type RemotedMethods = 'insertSpan' | 'endSpan' | 'setSpanStatus' | 'getSpanStatus' | 'updateAttributes' | 'addEvent' | 'insertError'

/**
 * Keep only structured-clone-safe values so the `postMessage` to main can't
 * throw a `DataCloneError`. Trace attributes are user-controlled (`setAttribute`,
 * `addEvent`, logged objects) and may carry functions, symbols or class
 * instances that survive in-process but not across the worker boundary. Mirrors
 * `serializeError`'s per-key cloneable filter: a non-cloneable value is dropped,
 * never thrown — a trace attribute is diagnostic and must never fail the request.
 * Allocates a copy only when something actually has to be dropped.
 */
function sanitizeAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
	let safe: Record<string, unknown> | null = null
	for (const key of Object.keys(attrs)) {
		try {
			structuredClone(attrs[key])
		} catch {
			if (!safe) safe = { ...attrs }
			delete safe[key]
		}
	}
	return safe ?? attrs
}

export class RemoteTraceStore implements Pick<TraceStore, RemotedMethods> {
	private _statuses = new Map<string, 'ok' | 'error' | 'unset'>()
	private _post: (msg: WorkerMessage) => void

	constructor(post: (msg: WorkerMessage) => void) {
		this._post = post
	}

	insertSpan(span: SpanData): void {
		this._statuses.set(span.spanId, span.status)
		try {
			this._post({ type: 'trace-span-insert', span })
		} catch {
			this._post({ type: 'trace-span-insert', span: { ...span, attributes: sanitizeAttributes(span.attributes) } })
		}
	}

	endSpan(spanId: string, endTime: number, status: 'ok' | 'error', statusMessage?: string): void {
		this._post({ type: 'trace-span-end', spanId, endTime, status, statusMessage: statusMessage ?? null })
		this._statuses.delete(spanId)
	}

	setSpanStatus(spanId: string, status: 'ok' | 'error', statusMessage: string | null): void {
		this._statuses.set(spanId, status)
		this._post({ type: 'trace-span-status', spanId, status, statusMessage })
	}

	getSpanStatus(spanId: string): string | null {
		return this._statuses.get(spanId) ?? null
	}

	updateAttributes(spanId: string, attrs: Record<string, unknown>): void {
		try {
			this._post({ type: 'trace-span-attrs', spanId, attrs })
		} catch {
			this._post({ type: 'trace-span-attrs', spanId, attrs: sanitizeAttributes(attrs) })
		}
	}

	addEvent(event: Omit<SpanEventData, 'id'>): void {
		try {
			this._post({ type: 'trace-span-event', event })
		} catch {
			this._post({ type: 'trace-span-event', event: { ...event, attributes: sanitizeAttributes(event.attributes) } })
		}
	}

	insertError(opts: TraceErrorPayload): void {
		this._post({ type: 'trace-error', error: opts })
	}
}
