import { generateId, generateTraceId, getActiveContext, runWithContext } from './context'
import { buildErrorFrames } from './frames'
import { getTraceStore } from './store'
import type { SpanData } from './types'

export interface SpanOptions {
	name: string
	kind?: SpanData['kind']
	attributes?: Record<string, unknown>
	workerName?: string
	/** Force a new root trace, ignoring any active parent context. */
	newTrace?: boolean
}

export async function startSpan<T>(opts: SpanOptions, fn: () => T | Promise<T>): Promise<T> {
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

	try {
		const result = await runWithContext({ traceId, spanId, fetchStack }, () => fn())
		if (result instanceof Response && result.status >= 500) {
			store.setSpanStatus(spanId, 'error', `HTTP ${result.status}`)
		}
		const currentStatus = store.getSpanStatus(spanId)
		store.endSpan(spanId, Date.now(), currentStatus === 'error' ? 'error' : 'ok')
		return result
	} catch (err) {
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
		throw err
	}
}

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
