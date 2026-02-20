import { getTraceStore } from '../../../tracing/store'
import type { TraceDetail, TraceSummary } from '../../../tracing/types'

export const handlers = {
	'traces.list'(input: { limit?: number; cursor?: string }): { items: TraceSummary[]; cursor: string | null } {
		if (input.limit !== undefined && (typeof input.limit !== 'number' || input.limit < 1)) {
			throw new Error('limit must be a positive number')
		}
		if (input.cursor !== undefined && typeof input.cursor !== 'string') {
			throw new Error('cursor must be a string')
		}
		const store = getTraceStore()
		return store.listTraces({ limit: input.limit ?? 50, cursor: input.cursor })
	},

	'traces.getTrace'(input: { traceId: string }): TraceDetail {
		if (!input.traceId || typeof input.traceId !== 'string') {
			throw new Error('traceId is required and must be a string')
		}
		const store = getTraceStore()
		return store.getTrace(input.traceId)
	},

	'traces.search'(input: { query: string; limit?: number }): { items: TraceSummary[]; cursor: string | null } {
		if (!input.query || typeof input.query !== 'string') {
			throw new Error('query is required and must be a string')
		}
		if (input.limit !== undefined && (typeof input.limit !== 'number' || input.limit < 1)) {
			throw new Error('limit must be a positive number')
		}
		const store = getTraceStore()
		return store.searchTraces(input.query, input.limit ?? 50)
	},

	'traces.listSpans'(
		input: { limit?: number; cursor?: string },
	): {
		items: Array<
			{ spanId: string; traceId: string; name: string; status: string; durationMs: number | null; startTime: number; workerName: string | null }
		>
		cursor: string | null
	} {
		if (input.limit !== undefined && (typeof input.limit !== 'number' || input.limit < 1)) {
			throw new Error('limit must be a positive number')
		}
		const store = getTraceStore()
		return store.listAllSpans({ limit: input.limit ?? 50, cursor: input.cursor })
	},

	'traces.listLogs'(
		input: { limit?: number; cursor?: string },
	): {
		items: Array<{ id: number; spanId: string; traceId: string; timestamp: number; name: string; level: string | null; message: string | null }>
		cursor: string | null
	} {
		if (input.limit !== undefined && (typeof input.limit !== 'number' || input.limit < 1)) {
			throw new Error('limit must be a positive number')
		}
		const store = getTraceStore()
		return store.listAllLogs({ limit: input.limit ?? 50, cursor: input.cursor })
	},

	'traces.errors'(input: { traceId: string }) {
		if (!input.traceId || typeof input.traceId !== 'string') {
			throw new Error('traceId is required and must be a string')
		}
		const store = getTraceStore()
		return store.getErrorsForTrace(input.traceId)
	},

	'traces.clear'(_input: {}): { ok: true } {
		const store = getTraceStore()
		store.clearTraces()
		return { ok: true }
	},
}
