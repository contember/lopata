import { generateId, generateTraceId, getActiveContext, runWithContext, type SpanContext } from './context'
import { buildErrorFrames } from './frames'
import { getTraceWriter, type TraceWriter } from './store'
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

export interface SpanHandle {
	readonly isTraced: boolean
	setAttribute(key: string, value: SpanAttribute): this
	setAttributes(attributes: Record<string, SpanAttribute>): this
	recordException(exception: SpanException): void
	end(): void
}

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

const noopSpan: SpanHandle = {
	get isTraced() {
		return false
	},
	setAttribute() {
		return this
	},
	setAttributes() {
		return this
	},
	recordException() {},
	end() {},
}

/** Runtime-only owner; public handles expose no IDs or runtime finalization methods. */
export class OwnedSpan {
	readonly context: SpanContext
	readonly handle: SpanHandle
	private ended = false
	private bytesUsed = 0

	constructor(opts: SpanOptions, parent: SpanContext | undefined, readonly writer: TraceWriter, manual = false) {
		this.context = {
			traceId: parent?.traceId ?? generateTraceId(),
			spanId: generateId(),
			fetchStack: parent?.fetchStack ?? { current: null },
			subrequests: parent?.subrequests ?? { count: 0 },
			invocation: parent?.invocation,
			invocationSpans: parent?.invocationSpans,
			writer,
			span: this,
		}
		writer.insertSpan({
			spanId: this.context.spanId,
			traceId: this.context.traceId,
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
		const owner = this
		this.handle = {
			get isTraced() {
				return owner.isOpen
			},
			setAttribute(key, value) {
				owner.setAttribute(key, value)
				return this
			},
			setAttributes(attributes) {
				if (!owner.isOpen || owner.bytesUsed > MAX_SPAN_BYTES) return this
				if (!attributes || typeof attributes !== 'object') throw new TypeError('Span attributes must be an object')
				for (const [key, value] of Object.entries(attributes)) owner.setAttribute(key, value)
				return this
			},
			recordException(exception) {
				owner.recordException(exception)
			},
			end() {
				if (manual) owner.finish()
			},
		}
		parent?.invocationSpans?.add(this)
	}

	get isOpen(): boolean {
		return !this.ended && !this.context.invocation?.closed
	}

	private acceptData(kind: 'attribute' | 'exception', name: string, valueSize: number): boolean {
		if (this.bytesUsed > MAX_SPAN_BYTES) return false
		// workerd v1.20261005.1 tracing.c++ counts writes cumulatively, including overwrites.
		this.bytesUsed += valueSize + (kind === 'attribute' ? encoder.encode(name).length : 0)
		if (this.bytesUsed <= MAX_SPAN_BYTES) return true
		const nameSize = encoder.encode(name).length
		const shortName = nameSize > 64 ? `"${truncateName(name)}..." (key length ${nameSize})` : `"${name}"`
		this.writer.updateAttributes(this.context.spanId, {
			'cloudflare.warning.type': 'span_data_limit_exceeded',
			'cloudflare.warning.message': `exceeded span data limit while trying to record ${kind} ${shortName} of size ${valueSize}`,
		})
		return false
	}

	private setAttribute(key: string, value: SpanAttribute): void {
		if (!this.isOpen || this.bytesUsed > MAX_SPAN_BYTES || value === undefined) return
		if (typeof key !== 'string') throw new TypeError('Span attribute key must be a string')
		if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
			throw new TypeError('Span attribute value must be a string, number or boolean')
		}
		if (!this.acceptData('attribute', key, typeof value === 'string' ? encoder.encode(value).length : 8)) return
		this.writer.updateAttributes(this.context.spanId, { [key]: value })
	}

	private recordException(exception: SpanException): void {
		if (!this.isOpen || this.bytesUsed > MAX_SPAN_BYTES) return
		const data = parseException(exception)
		if (!data) return
		let size = 0
		for (const value of Object.values(data)) size += typeof value === 'string' ? encoder.encode(value).length : 8
		if (!this.acceptData('exception', data.name ?? '', size)) return
		this.writer.addEvent({
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
		this.context.invocationSpans?.delete(this)
		const finalStatus = status ?? (this.writer.getSpanStatus(this.context.spanId) === 'error' ? 'error' : 'ok')
		this.writer.endSpan(this.context.spanId, Date.now(), finalStatus, message)
	}

	fail(error: unknown): void {
		if (!this.isOpen) return
		const message = error instanceof Error ? error.message : String(error)
		this.writer.addEvent({
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

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return value !== null && (typeof value === 'object' || typeof value === 'function') && 'then' in value && typeof value.then === 'function'
}

function runAndEnd<T>(span: OwnedSpan, fn: () => T, flagServerError?: boolean): T
function runAndEnd(span: OwnedSpan, fn: () => unknown, flagServerError = false): unknown {
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

function createInternalSpan(opts: SpanOptions): OwnedSpan {
	const parent = opts.newTrace ? undefined : getActiveContext()
	return new OwnedSpan(opts, parent, parent?.writer ?? getTraceWriter())
}

export async function startSpan<T>(opts: SpanOptions, fn: () => T | Promise<T>): Promise<T> {
	if (!opts.newTrace && getActiveContext()?.invocation?.closed) return fn()
	return runAndEnd(createInternalSpan(opts), fn, true)
}

export function startSyncSpan<T>(opts: SpanOptions, fn: () => T): T {
	if (!opts.newTrace && getActiveContext()?.invocation?.closed) return fn()
	return runAndEnd(createInternalSpan(opts), fn)
}

function createCustomSpan(name: string): OwnedSpan | undefined {
	const truncatedName = truncateName(name)
	const parent = getActiveContext()
	if (!parent?.invocation || parent.invocation.closed) return
	return new OwnedSpan({ name: truncatedName }, parent, parent.writer ?? getTraceWriter(), true)
}

export function enterSpan<T, A extends unknown[]>(name: string, callback: (span: SpanHandle, ...args: A) => T, ...args: A): T {
	const span = createCustomSpan(name)
	if (!span) return callback(noopSpan, ...args)
	return runAndEnd(span, () => callback(span.handle, ...args))
}

export const tracing: Tracing = {
	enterSpan,
	startActiveSpan(name, callback, ...args) {
		const span = createCustomSpan(name)
		if (!span) return callback(noopSpan, ...args)
		return runWithContext(span.context, () => callback(span.handle, ...args))
	},
	startSpan(name) {
		return createCustomSpan(name)?.handle ?? noopSpan
	},
	getActiveSpan() {
		const context = getActiveContext()
		if (!context?.invocation || context.invocation.closed) return
		return context.span?.handle ?? context.invocation.root
	},
}

export function setSpanStatus(status: 'ok' | 'error', message?: string): void {
	const ctx = getActiveContext()
	if (!ctx || (ctx.span && !ctx.span.isOpen)) return
	const store = ctx.writer ?? getTraceWriter()
	store.setSpanStatus(ctx.spanId, status, message ?? null)
}

export function setSpanAttribute(key: string, value: unknown): void {
	const ctx = getActiveContext()
	if (!ctx || (ctx.span && !ctx.span.isOpen)) return
	const store = ctx.writer ?? getTraceWriter()
	store.updateAttributes(ctx.spanId, { [key]: value })
}

export function addSpanEvent(name: string, level: string, message: string, attrs?: Record<string, unknown>): void {
	const ctx = getActiveContext()
	if (!ctx || (ctx.span && !ctx.span.isOpen)) return
	const store = ctx.writer ?? getTraceWriter()
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
		const store = ctx?.writer ?? getTraceWriter()
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
