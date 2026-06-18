import { generateId, generateTraceId, getActiveContext, runWithContext } from './context'
import { buildErrorFrames } from './frames'
import { getTraceStore, type TraceStore } from './store'
import type { SpanData } from './types'

export interface SpanOptions {
	name: string
	kind?: SpanData['kind']
	attributes?: Record<string, unknown>
	workerName?: string
	/** Force a new root trace, ignoring any active parent context. */
	newTrace?: boolean
}

/** Handle passed to span callbacks, mirroring Cloudflare's custom-span Span object. */
export interface SpanHandle {
	/** Set an attribute on the span. Passing `undefined` is a no-op, matching Cloudflare (allows optional chaining). */
	setAttribute(key: string, value: string | number | boolean | undefined): void
	/** Whether this invocation is being traced. Always true in lopata's dev runtime. */
	readonly isTraced: boolean
}

interface SpanRunOptions extends SpanOptions {
	/** Internal hook: inspect a successful result before the span's final status is computed,
	 *  so it can flag a failure (used by startSpan to mark an HTTP 5xx Response errored). */
	onSuccess?: (result: unknown, spanId: string, store: TraceStore) => void
}

/**
 * Core span runner shared by startSpan / startSyncSpan / enterSpan. Creates a child span of
 * the active context (or a new root when `newTrace`), runs `fn` inside it, and ends the span
 * when `fn` returns or — if it returned a thenable — when that promise settles. The result is
 * returned as-is: synchronous callbacks stay synchronous, async ones return the promise. On a
 * thrown/rejected error the span is marked errored and an `exception` event is recorded.
 */
function runInSpan<T>(opts: SpanRunOptions, fn: (span: SpanHandle) => T): T {
	const store = getTraceStore()
	const parent = opts.newTrace ? undefined : getActiveContext()

	const spanId = generateId()
	const traceId = parent?.traceId ?? generateTraceId()
	const parentSpanId = parent?.spanId ?? null

	const span: SpanData = {
		spanId,
		traceId,
		parentSpanId,
		name: opts.name,
		kind: opts.kind ?? 'internal',
		status: 'unset',
		statusMessage: null,
		startTime: Date.now(),
		endTime: null,
		durationMs: null,
		attributes: opts.attributes ?? {},
		workerName: opts.workerName ?? null,
	}
	store.insertSpan(span)

	// Share fetchStack ref across all spans in the same trace so that
	// fetch call-site stacks captured in sub-spans are visible in the root
	// span's error handler.
	const fetchStack = parent?.fetchStack ?? { current: null }
	// Subrequest budget is per top-level request: a root span (no parent) mints
	// a fresh counter; child spans inherit it. This resets the budget on each
	// incoming request, matching Cloudflare — instead of leaking across the
	// whole dev-server lifetime.
	const subrequests = parent?.subrequests ?? { count: 0 }

	const handle: SpanHandle = {
		setAttribute(key, value) {
			if (value === undefined) return
			store.updateAttributes(spanId, { [key]: value })
		},
		isTraced: true,
	}

	const succeed = (result: unknown): void => {
		opts.onSuccess?.(result, spanId, store)
		const currentStatus = store.getSpanStatus(spanId)
		store.endSpan(spanId, Date.now(), currentStatus === 'error' ? 'error' : 'ok')
	}

	const fail = (err: unknown): void => {
		const message = err instanceof Error ? err.message : String(err)
		store.endSpan(spanId, Date.now(), 'error', message)
		store.addEvent({
			spanId,
			traceId,
			timestamp: Date.now(),
			name: 'exception',
			level: 'error',
			message,
			attributes: err instanceof Error ? { stack: err.stack } : {},
		})
	}

	try {
		const result = runWithContext({ traceId, spanId, fetchStack, subrequests }, () => fn(handle))
		if (result != null && typeof (result as { then?: unknown }).then === 'function') {
			return (result as unknown as Promise<unknown>).then(
				value => {
					succeed(value)
					return value
				},
				err => {
					fail(err)
					throw err
				},
			) as T
		}
		succeed(result)
		return result
	} catch (err) {
		fail(err)
		throw err
	}
}

/** Flags a span errored when the handler returned an HTTP 5xx Response. */
function flagServerErrorStatus(result: unknown, spanId: string, store: TraceStore): void {
	if (result instanceof Response && result.status >= 500) {
		store.setSpanStatus(spanId, 'error', `HTTP ${result.status}`)
	}
}

export async function startSpan<T>(opts: SpanOptions, fn: () => T | Promise<T>): Promise<T> {
	return runInSpan<T | Promise<T>>({ ...opts, onSuccess: flagServerErrorStatus }, () => fn())
}

/** Synchronous variant of startSpan for instrumenting non-async APIs (e.g. DO
 *  state.storage.sql.exec is sync). The span ends as soon as fn returns; fn runs
 *  inside the span context so any spans it creates nest correctly. */
export function startSyncSpan<T>(opts: SpanOptions, fn: () => T): T {
	return runInSpan<T>(opts, () => fn())
}

/**
 * Cloudflare-compatible custom span API (`tracing.enterSpan` from `cloudflare:workers`, also
 * `ctx.tracing`). Runs `fn` inside a child span of the active trace context, passing a span
 * handle for `setAttribute` / `isTraced`. The callback's value is returned as-is (sync stays
 * sync, async returns the promise) and the span auto-ends when the callback returns or its
 * returned promise settles — matching Cloudflare's semantics.
 */
export function enterSpan<T>(name: string, fn: (span: SpanHandle) => T): T {
	return runInSpan<T>({ name }, fn)
}

/** Cloudflare-compatible `tracing` namespace exported from `cloudflare:workers` and exposed as `ctx.tracing`. */
export const tracing = { enterSpan }

export function setSpanStatus(status: 'ok' | 'error', message?: string): void {
	const ctx = getActiveContext()
	if (!ctx) return
	const store = getTraceStore()
	store.setSpanStatus(ctx.spanId, status, message ?? null)
}

export function setSpanAttribute(key: string, value: unknown): void {
	const ctx = getActiveContext()
	if (!ctx) return
	const store = getTraceStore()
	store.updateAttributes(ctx.spanId, { [key]: value })
}

export function addSpanEvent(name: string, level: string, message: string, attrs?: Record<string, unknown>): void {
	const ctx = getActiveContext()
	if (!ctx) return
	const store = getTraceStore()
	store.addEvent({
		spanId: ctx.spanId,
		traceId: ctx.traceId,
		timestamp: Date.now(),
		name,
		level,
		message,
		attributes: attrs ?? {},
	})
}

/** Persist an error to the errors table, linking it to the current trace/span context.
 *  Optional traceId/spanId override ALS context (needed when ALS scope is lost, e.g. after startSpan returns in Bun). */
export function persistError(error: unknown, source: string, workerName?: string, traceId?: string, spanId?: string): string | null {
	try {
		const err = error instanceof Error ? error : new Error(String(error))
		const ctx = getActiveContext()
		const store = getTraceStore()
		const id = crypto.randomUUID()
		store.insertError({
			id,
			timestamp: Date.now(),
			errorName: err.name,
			errorMessage: err.message,
			workerName: workerName ?? null,
			traceId: traceId ?? ctx?.traceId ?? null,
			spanId: spanId ?? ctx?.spanId ?? null,
			source,
			data: JSON.stringify({
				error: {
					name: err.name,
					message: err.message,
					stack: err.stack ?? String(error),
					frames: buildErrorFrames(err.stack ?? ''),
				},
				request: { method: '', url: '', headers: {} },
				env: {},
				bindings: [],
				runtime: {
					bunVersion: Bun.version,
					platform: process.platform,
					arch: process.arch,
					workerName,
				},
			}),
		})
		return id
	} catch {
		// Never let error persistence break the caller
		return null
	}
}
