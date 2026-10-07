import { generateId, generateTraceId, getActiveContext, runWithContext, type SpanContext } from './context'
import { buildErrorFrames } from './frames'
import { getTraceWriter } from './store'
import type { SpanData } from './types'

export interface SpanOptions {
	name: string
	kind?: SpanData['kind']
	attributes?: Record<string, unknown>
	workerName?: string
	/** Force a new root trace, ignoring any active parent context. */
	newTrace?: boolean
}

export type SpanAttribute = string | number | boolean | undefined
export type SpanException =
	| string
	| { code: string | number; name?: string; message?: string; stack?: string }
	| { code?: string | number; name: string; message?: string; stack?: string }
	| { code?: string | number; name?: string; message: string; stack?: string }

/** Cloudflare custom-span handle. */
export interface SpanHandle {
	readonly isTraced: boolean
	setAttribute(key: string, value: SpanAttribute): this
	setAttributes(attributes: Record<string, SpanAttribute>): this
	recordException(exception: SpanException): void
	end(): void
}

/** Cloudflare-compatible `tracing` namespace exported from `cloudflare:workers` and exposed as `ctx.tracing`. */
export interface Tracing {
	enterSpan<T, A extends unknown[]>(name: string, callback: (span: SpanHandle, ...args: A) => T, ...args: A): T
	startActiveSpan<T, A extends unknown[]>(name: string, callback: (span: SpanHandle, ...args: A) => T, ...args: A): T
	startSpan(name: string): SpanHandle
	getActiveSpan(): SpanHandle | undefined
}

const encoder = new TextEncoder()
const MAX_SPAN_BYTES = 64 * 1024

function truncateName(name: string): string {
	if (typeof name !== 'string') throw new TypeError('Span name must be a string')
	const bytes = encoder.encode(name)
	if (bytes.length <= 64) return name
	let end = 64
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
	return new TextDecoder().decode(bytes.subarray(0, end))
}

interface ExceptionData {
	code?: string | number
	name?: string
	message?: string
	stack?: string
}

function parseException(value: unknown): ExceptionData | undefined {
	if (typeof value === 'string') return { message: value }
	if (!value || typeof value !== 'object') return
	const data: ExceptionData = {}
	const code: unknown = Reflect.get(value, 'code')
	if (code !== undefined) {
		if (typeof code !== 'string' && typeof code !== 'number') throw new TypeError('Exception code must be a string or number')
		data.code = code
	}
	for (const key of ['name', 'message', 'stack']) {
		const field: unknown = Reflect.get(value, key)
		if (field === undefined) continue
		if (typeof field !== 'string') throw new TypeError(`Exception ${key} must be a string`)
		if (key === 'name') data.name = field
		else if (key === 'message') data.message = field
		else data.stack = field
	}
	if (data.code === undefined && data.name === undefined && data.message === undefined) return
	return data
}

/** Writes to one span row. Runtime-owned spans ignore the public `end()`; only the runtime closes them. */
class SpanRecord {
	readonly handle: SpanHandle
	private ended = false
	private bytesUsed = 0

	constructor(readonly context: SpanContext, userOwned: boolean) {
		const record = this
		this.handle = {
			get isTraced() {
				return !record.ended
			},
			setAttribute(key, value) {
				record.setAttribute(key, value)
				return this
			},
			setAttributes(attributes) {
				if (record.ended || record.bytesUsed > MAX_SPAN_BYTES) return this
				if (!attributes || typeof attributes !== 'object') throw new TypeError('Span attributes must be an object')
				for (const [key, value] of Object.entries(attributes)) record.setAttribute(key, value)
				return this
			},
			recordException(exception) {
				record.recordException(exception)
			},
			end() {
				if (userOwned) record.finish()
			},
		}
	}

	private acceptData(kind: 'attribute' | 'exception', name: string, valueSize: number): boolean {
		if (this.bytesUsed > MAX_SPAN_BYTES) return false
		// workerd v1.20261005.1 tracing.c++ counts writes cumulatively, including overwrites.
		this.bytesUsed += valueSize + (kind === 'attribute' ? encoder.encode(name).length : 0)
		if (this.bytesUsed <= MAX_SPAN_BYTES) return true
		const nameSize = encoder.encode(name).length
		const shortName = nameSize > 64 ? `"${truncateName(name)}..." (key length ${nameSize})` : `"${name}"`
		getTraceWriter().updateAttributes(this.context.spanId, {
			'cloudflare.warning.type': 'span_data_limit_exceeded',
			'cloudflare.warning.message': `exceeded span data limit while trying to record ${kind} ${shortName} of size ${valueSize}`,
		})
		return false
	}

	private setAttribute(key: string, value: SpanAttribute): void {
		if (this.ended || this.bytesUsed > MAX_SPAN_BYTES || value === undefined) return
		if (typeof key !== 'string') throw new TypeError('Span attribute key must be a string')
		if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
			throw new TypeError('Span attribute value must be a string, number or boolean')
		}
		if (!this.acceptData('attribute', key, typeof value === 'string' ? encoder.encode(value).length : 8)) return
		getTraceWriter().updateAttributes(this.context.spanId, { [key]: value })
	}

	private recordException(exception: SpanException): void {
		if (this.ended || this.bytesUsed > MAX_SPAN_BYTES) return
		const data = parseException(exception)
		if (!data) return
		let size = 0
		for (const value of Object.values(data)) size += typeof value === 'string' ? encoder.encode(value).length : 8
		if (!this.acceptData('exception', data.name ?? '', size)) return
		getTraceWriter().addEvent({
			spanId: this.context.spanId,
			traceId: this.context.traceId,
			timestamp: Date.now(),
			name: 'exception',
			level: 'error',
			message: data.message ?? '',
			attributes: { ...data },
		})
	}

	finish(status?: 'ok' | 'error', message?: string): void {
		if (this.ended) return
		this.ended = true
		const writer = getTraceWriter()
		const finalStatus = status ?? (writer.getSpanStatus(this.context.spanId) === 'error' ? 'error' : 'ok')
		writer.endSpan(this.context.spanId, Date.now(), finalStatus, message)
	}

	fail(error: unknown): void {
		if (this.ended) return
		const message = error instanceof Error ? error.message : String(error)
		getTraceWriter().addEvent({
			spanId: this.context.spanId,
			traceId: this.context.traceId,
			timestamp: Date.now(),
			name: 'exception',
			level: 'error',
			message,
			attributes: error instanceof Error ? { stack: error.stack } : {},
		})
		this.finish('error', message)
	}
}

const records = new WeakMap<SpanContext, SpanRecord>()

function createSpan(opts: SpanOptions, userOwned: boolean): SpanRecord {
	const parent = opts.newTrace ? undefined : getActiveContext()
	const context: SpanContext = {
		traceId: parent?.traceId ?? generateTraceId(),
		spanId: generateId(),
		// Share fetchStack ref across all spans in the same trace so that
		// fetch call-site stacks captured in sub-spans are visible in the root
		// span's error handler.
		fetchStack: parent?.fetchStack ?? { current: null },
		// Subrequest budget is per top-level request: a root span (no parent) mints
		// a fresh counter; child spans inherit it.
		subrequests: parent?.subrequests ?? { count: 0 },
	}
	getTraceWriter().insertSpan({
		spanId: context.spanId,
		traceId: context.traceId,
		parentSpanId: parent?.spanId ?? null,
		name: opts.name,
		kind: opts.kind ?? 'internal',
		status: 'unset',
		statusMessage: null,
		startTime: Date.now(),
		endTime: null,
		durationMs: null,
		attributes: opts.attributes ?? {},
		workerName: opts.workerName ?? null,
	})
	const record = new SpanRecord(context, userOwned)
	records.set(context, record)
	return record
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return value !== null && (typeof value === 'object' || typeof value === 'function') && 'then' in value && typeof value.then === 'function'
}

/**
 * Runs `fn` inside the span and ends the span when `fn` returns or — if it returned a thenable —
 * when that settles. Sync callbacks stay sync. A throw/rejection marks the span errored.
 */
function runAndEnd<T>(span: SpanRecord, fn: () => T, flagServerError?: boolean): T
function runAndEnd(span: SpanRecord, fn: () => unknown, flagServerError = false): unknown {
	const succeed = (result: unknown) => {
		if (flagServerError && result instanceof Response && result.status >= 500) {
			span.finish('error', `HTTP ${result.status}`)
		} else {
			span.finish()
		}
		return result
	}
	try {
		const result = runWithContext(span.context, fn)
		if (isThenable(result)) {
			return Promise.resolve(result).then(succeed, error => {
				span.fail(error)
				throw error
			})
		}
		return succeed(result)
	} catch (error) {
		span.fail(error)
		throw error
	}
}

export async function startSpan<T>(opts: SpanOptions, fn: () => T | Promise<T>): Promise<T> {
	return runAndEnd(createSpan(opts, false), fn, true)
}

/** Synchronous variant of startSpan for instrumenting non-async APIs (e.g. DO
 *  state.storage.sql.exec is sync). The span ends as soon as fn returns. */
export function startSyncSpan<T>(opts: SpanOptions, fn: () => T): T {
	return runAndEnd(createSpan(opts, false), fn)
}

export function enterSpan<T, A extends unknown[]>(name: string, callback: (span: SpanHandle, ...args: A) => T, ...args: A): T {
	const span = createSpan({ name: truncateName(name) }, true)
	return runAndEnd(span, () => callback(span.handle, ...args))
}

/** Spans opened by `startActiveSpan` / `startSpan` stay open until the user calls `end()`. */
export const tracing: Tracing = {
	enterSpan,
	startActiveSpan(name, callback, ...args) {
		const span = createSpan({ name: truncateName(name) }, true)
		return runWithContext(span.context, () => callback(span.handle, ...args))
	},
	startSpan(name) {
		return createSpan({ name: truncateName(name) }, true).handle
	},
	getActiveSpan() {
		const context = getActiveContext()
		if (!context) return
		let record = records.get(context)
		if (!record) {
			// A parent adopted across a thread boundary is owned by the other side.
			record = new SpanRecord(context, false)
			records.set(context, record)
		}
		return record.handle
	},
}

export function setSpanStatus(status: 'ok' | 'error', message?: string): void {
	const ctx = getActiveContext()
	if (!ctx) return
	getTraceWriter().setSpanStatus(ctx.spanId, status, message ?? null)
}

export function setSpanAttribute(key: string, value: unknown): void {
	const ctx = getActiveContext()
	if (!ctx) return
	getTraceWriter().updateAttributes(ctx.spanId, { [key]: value })
}

export function addSpanEvent(name: string, level: string, message: string, attrs?: Record<string, unknown>): void {
	const ctx = getActiveContext()
	if (!ctx) return
	getTraceWriter().addEvent({
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
		const store = getTraceWriter()
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
