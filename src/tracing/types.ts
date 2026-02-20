export interface SpanData {
	spanId: string
	traceId: string
	parentSpanId: string | null
	name: string
	kind: 'server' | 'internal' | 'client'
	status: 'ok' | 'error' | 'unset'
	statusMessage: string | null
	startTime: number
	endTime: number | null
	durationMs: number | null
	attributes: Record<string, unknown>
	workerName: string | null
}

export interface SpanEventData {
	id?: number
	spanId: string
	traceId: string
	timestamp: number
	name: string
	level: string | null
	message: string | null
	attributes: Record<string, unknown>
}

export type TraceEvent =
	| { type: 'span.start'; span: SpanData }
	| { type: 'span.end'; span: SpanData }
	| { type: 'span.event'; event: SpanEventData }

export interface TraceSummary {
	traceId: string
	rootSpanName: string
	workerName: string | null
	status: 'ok' | 'error' | 'unset'
	statusMessage: string | null
	startTime: number
	durationMs: number | null
	spanCount: number
	errorCount: number
}

export interface TraceDetail {
	spans: SpanData[]
	events: SpanEventData[]
}
