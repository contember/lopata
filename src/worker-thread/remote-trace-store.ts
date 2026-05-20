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

export class RemoteTraceStore implements Pick<TraceStore, RemotedMethods> {
	private _statuses = new Map<string, 'ok' | 'error' | 'unset'>()
	private _post: (msg: WorkerMessage) => void

	constructor(post: (msg: WorkerMessage) => void) {
		this._post = post
	}

	insertSpan(span: SpanData): void {
		this._statuses.set(span.spanId, span.status)
		this._post({ type: 'trace-span-insert', span })
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
		this._post({ type: 'trace-span-attrs', spanId, attrs })
	}

	addEvent(event: Omit<SpanEventData, 'id'>): void {
		this._post({ type: 'trace-span-event', event })
	}

	insertError(opts: TraceErrorPayload): void {
		this._post({ type: 'trace-error', error: opts })
	}
}
