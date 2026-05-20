/**
 * Message protocol between main thread and worker-thread runtime.
 *
 * Main thread owns Bun.serve, file watcher, GenerationManager, dashboard.
 * Worker thread owns the user module graph + per-thread env. Reload =
 * terminate + respawn.
 */

import type { WranglerConfig } from '../config'
import type { TraceStore } from '../tracing/store'
import type { SpanData, SpanEventData } from '../tracing/types'

/** Parent span context handed to the worker so its spans nest under main's server span. */
export interface ParentSpanContext {
	traceId: string
	spanId: string
}

export type TraceErrorPayload = Parameters<TraceStore['insertError']>[0]

export interface SerializedRequest {
	url: string
	method: string
	headers: [string, string][]
	body: ArrayBuffer | null
}

export interface SerializedResponse {
	status: number
	statusText: string
	headers: [string, string][]
	body: ArrayBuffer | null
}

export interface SerializedError {
	message: string
	stack?: string
	name?: string
}

export interface WorkerInitConfig {
	modulePath: string
	/** Wrangler config — already parsed, with `env.<name>` overrides applied. */
	config: WranglerConfig
	baseDir: string
}

export interface BindingTarget {
	binding: string
	/**
	 * @internal Scaffold for upcoming workflow / DO instance RPC. When set, main
	 * resolves via `env[binding].get(instanceId)` before invoking `method`.
	 */
	instanceId?: string
}

/** Main → worker */
export type WorkerCommand =
	| { type: 'init'; config: WorkerInitConfig }
	| { type: 'fetch'; id: number; request: SerializedRequest; parent?: ParentSpanContext }
	| { type: 'binding-result'; id: number; value: unknown }
	| { type: 'binding-error'; id: number; error: SerializedError }

/** Worker → main */
export type WorkerMessage =
	| { type: 'need-init' }
	| { type: 'ready' }
	| { type: 'init-error'; error: SerializedError }
	| { type: 'fetch-result'; id: number; response: SerializedResponse }
	| { type: 'fetch-error'; id: number; error: SerializedError }
	| { type: 'binding-call'; id: number; target: BindingTarget; method: string; args: unknown[] }
	// `ctx.waitUntil(p)` and its settlement. Main keeps a counter so reload drain
	// waits for background work the response no longer carries.
	| { type: 'wait-until-add' }
	| { type: 'wait-until-settle' }
	// Trace store forwarding. The worker holds a `RemoteTraceStore` that posts
	// each operation here; main writes to the single real `TraceStore` so the
	// dashboard's subscribers fire normally.
	//
	// INVARIANT: wire shape == TraceStore row shape. If `SpanData` /
	// `SpanEventData` / `insertError` params gain a non-optional field, bump a
	// protocol version and translate at the dispatch site in `executor.ts`.
	| { type: 'trace-span-insert'; span: SpanData }
	| { type: 'trace-span-end'; spanId: string; endTime: number; status: 'ok' | 'error'; statusMessage: string | null }
	| { type: 'trace-span-status'; spanId: string; status: 'ok' | 'error'; statusMessage: string | null }
	| { type: 'trace-span-attrs'; spanId: string; attrs: Record<string, unknown> }
	| { type: 'trace-span-event'; event: Omit<SpanEventData, 'id'> }
	| { type: 'trace-error'; error: TraceErrorPayload }
