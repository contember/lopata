// ─── Shared data types ───────────────────────────────────────────────

export type { GenerationInfo } from '../../generation'
import type { GenerationInfo } from '../../generation'

export interface Paginated<T> {
	items: T[]
	cursor: string | null
}

export interface OkResponse {
	ok: true
}

// Overview
export interface OverviewData {
	kv: number
	r2: number
	queue: number
	do: number
	workflows: number
	d1: number
	containers: number
	cache: number
	errors: number
	scheduled: number
	email: number
	ai: number
	analyticsEngine: number
	generations: GenerationInfo[]
	runtime: {
		bunVersion: string
		platform: string
		arch: string
		pid: number
		cwd: string
		uptime: number
		startedAt: number
		memory: {
			rss: number
			heapUsed: number
			heapTotal: number
			external: number
		}
		cpuUsage: {
			user: number
			system: number
		}
		env: Record<string, string>
	}
	workerErrors: Record<string, number>
}

// Containers
export interface ContainerSummary {
	className: string
	image: string
	maxInstances: number | null
	bindingName: string
	instanceCount: number
	runningCount: number
}

export interface ContainerInstance {
	id: string
	doName: string | null
	containerName: string
	state: string
	ports: Record<string, string>
}

export interface ContainerDetail {
	id: string
	doName: string | null
	containerName: string
	image: string
	state: string
	exitCode: number | null
	ports: Record<string, string>
	created: string | null
	config: {
		defaultPort: number
		sleepAfter: string | number | null
		enableInternet: boolean
		pingEndpoint: string
	}
}

// KV
export interface KvNamespace {
	namespace: string
	count: number
}

export interface KvKey {
	key: string
	size: number
	metadata: string | null
	expiration: number | null
}

export interface KvValue {
	key: string
	value: string
	metadata: unknown
	expiration: number | null
}

// R2
export interface R2Bucket {
	bucket: string
	count: number
	total_size: number
}

export interface R2Object {
	key: string
	size: number
	etag: string
	uploaded: string
	http_metadata: string | null
	custom_metadata: string | null
}

// Queue
export interface QueueInfo {
	queue: string
	pending: number
	acked: number
	failed: number
}

export interface QueueMessage {
	id: string
	body: string
	content_type: string
	status: string
	attempts: number
	visible_at: number
	created_at: number
	completed_at: number | null
}

// Durable Objects
export interface DoNamespace {
	namespace: string
	count: number
}

export interface DoInstance {
	id: string
	name?: string | null
	key_count: number
	alarm: number | null
}

export interface DoDetail {
	entries: { key: string; value: string }[]
	alarm: number | null
	hasAlarmHandler: boolean
}

// Workflows
export interface WorkflowSummary {
	name: string
	total: number
	byStatus: Record<string, number>
}

export interface WorkflowInstance {
	id: string
	status: string
	params: string | null
	output: string | null
	error: string | null
	created_at: number
	updated_at: number
}

export interface WorkflowStepAttempt {
	step_name: string
	failed_attempts: number
	last_error: string | null
	last_error_name: string | null
	last_error_id: string | null
	updated_at: number | null
}

export interface WorkflowDetail extends WorkflowInstance {
	steps: { step_name: string; output: string | null; completed_at: number }[]
	stepAttempts: WorkflowStepAttempt[]
	events: { id: number; event_type: string; payload: string | null; created_at: number }[]
	activeSleep: { stepName: string; until: number } | null
	waitingForEvents: string[]
}

// D1
export interface D1Database {
	name: string
	tables: number
}

export interface D1Table {
	name: string
	sql: string
	rows: number
}

export interface QueryResult {
	columns: string[]
	rows: Record<string, unknown>[]
	count: number
	message?: string
	error?: string
}

// Cache
export interface CacheName {
	cache_name: string
	count: number
}

export interface CacheEntry {
	url: string
	status: number
	headers: string
	expires_at: number | null
}

// Generations
export interface WorkerGenerations {
	workerName: string
	generations: GenerationInfo[]
	gracePeriodMs: number
}

export interface GenerationsData {
	generations: GenerationInfo[]
	gracePeriodMs: number
	workers?: WorkerGenerations[]
}

// Workers
export interface WorkerBinding {
	type: string
	name: string
	target: string
	href: string | null
}

export interface WorkerInfo {
	name: string
	isMain: boolean
	bindings: WorkerBinding[]
}

// Errors
export interface ErrorSummary {
	id: string
	timestamp: number
	errorName: string
	errorMessage: string
	requestMethod: string | null
	requestUrl: string | null
	workerName: string | null
	traceId: string | null
	spanId: string | null
	source: string | null
}

export interface ErrorDetail {
	id: string
	timestamp: number
	traceId: string | null
	spanId: string | null
	source: string | null
	data: {
		error: {
			name: string
			message: string
			stack: string
			frames: Array<{
				file: string
				line: number
				column: number
				function: string
				source?: string[]
				sourceLine?: number
			}>
		}
		request: {
			method: string
			url: string
			headers: Record<string, string>
		}
		env: Record<string, string>
		bindings: Array<{ name: string; type: string }>
		runtime: {
			bunVersion: string
			platform: string
			arch: string
			workerName?: string
			configName?: string
		}
	}
}

export interface TraceErrorSummary {
	id: string
	timestamp: number
	errorName: string
	errorMessage: string
	source: string | null
}

// AI
export interface AiRequest {
	id: string
	model: string
	input_summary: string | null
	output_summary: string | null
	duration_ms: number
	status: string
	error: string | null
	is_streaming: number
	created_at: number
}

// Analytics Engine
export interface AnalyticsEngineDataPoint {
	id: string
	dataset: string
	timestamp: number
	_sample_interval: number
	index1: string | null
	blob1: string | null
	blob2: string | null
	blob3: string | null
	blob4: string | null
	blob5: string | null
	double1: number | null
	double2: number | null
	double3: number | null
	double4: number | null
	double5: number | null
}

// Email
export interface EmailRecord {
	id: string
	binding: string
	from_addr: string
	to_addr: string
	raw_size: number
	status: string
	reject_reason: string | null
	created_at: number
}

// Traces (re-export from tracing module)
export type { SpanData, SpanEventData, TraceDetail, TraceEvent, TraceSummary } from '../../tracing/types'

// ─── Handler context ─────────────────────────────────────────────────

import type { WranglerConfig } from '../../config'
import type { GenerationManager } from '../../generation-manager'
import type { WorkerRegistry } from '../../worker-registry'

export interface HandlerContext {
	config: WranglerConfig | null
	manager: GenerationManager | null
	registry: WorkerRegistry | null
}

/** Collect configs from all workers (registry) or fall back to single config. */
export function getAllConfigs(ctx: HandlerContext): WranglerConfig[] {
	if (ctx.registry) {
		return Array.from(ctx.registry.listManagers().values()).map(m => m.config)
	}
	return ctx.config ? [ctx.config] : []
}

/** Find a DO namespace by class name across all active generations. */
export function getDoNamespace(ctx: HandlerContext, ns: string) {
	if (ctx.registry) {
		for (const manager of ctx.registry.listManagers().values()) {
			const entry = manager.active?.registry.durableObjects.find(d => d.className === ns)
			if (entry) return entry.namespace
		}
	}
	if (ctx.manager) {
		const entry = ctx.manager.active?.registry.durableObjects.find(d => d.className === ns)
		if (entry) return entry.namespace
	}
	return null
}
