import { getActiveContext, runWithContext, type SpanContext } from './context'
import { OwnedSpan, type SpanHandle, type SpanOptions } from './span'
import { getTraceWriter } from './store'

export type TraceCompletion =
	| { kind: 'complete' }
	| { kind: 'error'; error: unknown }
	| { kind: 'cancelled'; reason?: string }
	| { kind: 'terminated'; reason: string }

export interface InvocationTrace {
	readonly root: SpanHandle
	readonly completed: Promise<void>
	readonly closed: boolean
	run<T>(callback: () => T): T
	retain(kind: 'handler' | 'response-body' | 'wait-until'): (completion?: TraceCompletion) => void
	finishHandler(completion?: TraceCompletion): void
	terminate(reason: string): void
}

export function createInvocationTrace(options: SpanOptions): InvocationTrace {
	const active = getActiveContext()
	const parent: SpanContext | undefined = options.newTrace || !active ? undefined : {
		traceId: active.traceId,
		spanId: active.spanId,
		fetchStack: active.fetchStack,
		subrequests: active.subrequests,
	}
	const root = new OwnedSpan(options, parent, active?.writer ?? getTraceWriter())
	const spans = new Set<OwnedSpan>()
	const completion = Promise.withResolvers<void>()
	let holds = 1
	let handlerFinished = false
	let closed = false
	let outcome: TraceCompletion = { kind: 'complete' }

	function remember(result: TraceCompletion): void {
		if (result.kind === 'terminated' || outcome.kind === 'complete' || (outcome.kind === 'cancelled' && result.kind === 'error')) {
			outcome = result
		}
	}

	function finalize(): void {
		if (closed || holds > 0) return
		const status = outcome.kind === 'complete' ? 'ok' : 'error'
		const message = outcome.kind === 'error'
			? outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
			: outcome.kind === 'complete'
			? undefined
			: outcome.reason ?? 'Invocation cancelled'
		for (const span of spans) span.finish(outcome.kind === 'complete' ? undefined : status, message)
		if (outcome.kind === 'error') root.fail(outcome.error)
		else root.finish(outcome.kind === 'complete' ? undefined : status, message)
		closed = true
		completion.resolve()
	}

	const invocation: InvocationTrace = {
		root: root.handle,
		completed: completion.promise,
		get closed() {
			return closed
		},
		run(callback) {
			return runWithContext(root.context, callback)
		},
		retain(_kind) {
			if (closed) return () => {}
			holds++
			let released = false
			return (result = { kind: 'complete' }) => {
				if (released || closed) return
				released = true
				remember(result)
				holds--
				finalize()
			}
		},
		finishHandler(result = { kind: 'complete' }) {
			if (handlerFinished || closed) return
			handlerFinished = true
			remember(result)
			holds--
			finalize()
		},
		terminate(reason) {
			if (closed) return
			remember({ kind: 'terminated', reason })
			holds = 0
			finalize()
		},
	}
	root.context.invocation = invocation
	root.context.invocationSpans = spans
	return invocation
}

export function getActiveInvocation(): InvocationTrace | undefined {
	const invocation = getActiveContext()?.invocation
	return invocation?.closed ? undefined : invocation
}
