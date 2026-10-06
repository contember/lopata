import type { Database } from 'bun:sqlite'
import { AsyncLocalStorage } from 'node:async_hooks'
import { realpathSync } from 'node:fs'
import { ExecutionContext, runWithExecutionContext } from '../execution-context'
import type { Clock } from '../testing/clock'
import { realClock } from '../testing/clock'
import { getActiveContext } from '../tracing/context'
import { createInvocationTrace, getActiveInvocation, type InvocationTrace, type TraceCompletion } from '../tracing/invocation'
import { addSpanEvent, persistError, setSpanAttribute, startSpan } from '../tracing/span'
import type { WorkflowControlOp, WorkflowControlResult } from '../worker-thread/protocol'
import { decodeWorkflowEvent, WorkflowInstanceNotFoundError, WorkflowStore } from './workflow-store'
import type {
	WorkflowCheckpoint,
	WorkflowExecutionToken,
	WorkflowOccurrenceRecord,
	WorkflowOccurrenceRef,
	WorkflowRestartOptions,
	WorkflowStepKey,
	WorkflowStepMethod,
} from './workflow-store'
export type { WorkflowCheckpoint, WorkflowExecutionToken, WorkflowRestartOptions, WorkflowStepKey } from './workflow-store'

// --- Limits ---

export interface WorkflowLimits {
	maxConcurrentInstances?: number // default: Infinity
	maxRetentionMs?: number // default: 0
	maxStepsPerWorkflow?: number // default: 1024
	maxStepOutputBytes?: number // default: 1 MiB
	maxInstanceIdLength?: number // default: 100
	maxStepNameLength?: number // default: 256
	maxSleepMs?: number // default: 365 days
	maxWaitForEventTimeoutMs?: number // default: 365 days
	minWaitForEventTimeoutMs?: number // default: 1s
	defaultWaitForEventTimeoutMs?: number // default: 24h
	maxStepDoTimeoutMs?: number // default: 30 min
	maxBatchSize?: number // default: 100
	defaultRetryLimit?: number // default: 5
	defaultRetryDelayMs?: number // default: 10_000
	defaultRetryBackoff?: 'constant' | 'linear' | 'exponential' // default: "exponential"
	defaultStepTimeoutMs?: number // default: 600_000 (10 min)
}

const WORKFLOW_DEFAULTS: Required<WorkflowLimits> = {
	maxConcurrentInstances: Infinity,
	maxRetentionMs: 0,
	maxStepsPerWorkflow: 1024,
	maxStepOutputBytes: 1024 * 1024,
	maxInstanceIdLength: 100,
	maxStepNameLength: 256,
	maxSleepMs: 365 * 86_400_000,
	maxWaitForEventTimeoutMs: 365 * 86_400_000,
	minWaitForEventTimeoutMs: 1_000,
	defaultWaitForEventTimeoutMs: 24 * 3_600_000,
	maxStepDoTimeoutMs: 30 * 60_000,
	maxBatchSize: 100,
	defaultRetryLimit: 5,
	defaultRetryDelayMs: 10_000,
	defaultRetryBackoff: 'exponential',
	defaultStepTimeoutMs: 600_000,
}

// --- Cloudflare-compatible limits ---

const EVENT_TYPE_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,99}$/

// --- NonRetryableError ---

export class NonRetryableError extends Error {
	constructor(message: string, name?: string) {
		super(message)
		this.name = name ?? 'NonRetryableError'
	}
}

// --- Step config ---

export interface WorkflowStepConfig {
	retries?: {
		limit?: number
		delay?: string | number | WorkflowDelayFunction
		backoff?: 'constant' | 'linear' | 'exponential'
	}
	timeout?: string | number
}

export interface WorkflowStepContext {
	step: { name: string; count: number }
	attempt: number
	config: WorkflowStepConfig
}

export type WorkflowDelayFunction = (input: { ctx: WorkflowStepContext; error: Error }) => string | number | Promise<string | number>

export interface WorkflowStepRollbackOptions<T = unknown> {
	rollback: (input: { ctx: WorkflowStepContext; error: Error; output: T | undefined }) => Promise<void>
	rollbackConfig?: WorkflowStepConfig
}

interface RollbackState {
	phase: string
	target_status: string
	original_non_retryable: number
	error: string | null
	error_name: string | null
}

export interface WorkflowInstanceStatus {
	status: string
	output?: unknown
	error?: { name: string; message: string }
	rollback: { outcome: 'complete' | 'failed'; error: { name: string; message: string } | null } | null
}

function workflowError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value))
}

const errorConstructors = new Map<string, new(message?: string) => Error>([
	['Error', Error],
	['TypeError', TypeError],
	['RangeError', RangeError],
	['ReferenceError', ReferenceError],
	['SyntaxError', SyntaxError],
	['URIError', URIError],
	['EvalError', EvalError],
])

function restoredError(message: string | null, name: string | null, nonRetryable = false): Error {
	const Constructor = errorConstructors.get(name ?? 'Error') ?? Error
	const error = nonRetryable ? new NonRetryableError(message ?? 'workflow terminated') : new Constructor(message ?? 'workflow terminated')
	error.name = name ?? 'Error'
	return error
}

function decodeStepOutput<T>(checkpoint: WorkflowCheckpoint, store: WorkflowStore): T
function decodeStepOutput(checkpoint: WorkflowCheckpoint, store: WorkflowStore): unknown {
	if (checkpoint.kind === 'stream') return store.openStream(checkpoint.streamId)
	return checkpoint.kind === 'json' ? JSON.parse(checkpoint.serialized) : undefined
}

function acceptWorkflowStream(source: ReadableStream<unknown>): ReadableStream<Uint8Array> {
	if (source.locked) throw new TypeError('Workflow stream must be unlocked')
	let byob: ReadableStreamBYOBReader | undefined
	try {
		byob = source.getReader({ mode: 'byob' })
	} catch (error) {
		if (!(error instanceof TypeError)) throw error
	}
	if (byob) {
		byob.releaseLock()
		throw new TypeError('BYOB workflow streams are not supported')
	}
	// Bun's isDisturbed misses Web streams; Response validates freshness and may transfer native body ownership.
	const body = new Response(source).body
	if (!body) throw new TypeError('Workflow stream has no body')
	return body
}

// --- Event waiting registry (in-memory, per-process) ---

interface EventWaiter {
	type: string
	wake: () => void
}
const eventWaiters = new Map<string, Map<number, EventWaiter>>()

function getWaitersForInstance(instanceId: string): Map<number, EventWaiter> {
	let map = eventWaiters.get(instanceId)
	if (!map) {
		map = new Map()
		eventWaiters.set(instanceId, map)
	}
	return map
}

// --- Global abort controller registry (per-process) ---
// Allows get() to retrieve a running instance's abort controller for terminate()

const abortControllers = new Map<string, AbortController>()
const executions = new Map<string, Promise<void>>()
const databaseIds = new WeakMap<Database, string>()

function registryKey(db: Database, token: WorkflowExecutionToken): string {
	let databaseId = databaseIds.get(db)
	if (!databaseId) {
		databaseId = !db.filename || db.filename === ':memory:' ? crypto.randomUUID() : realpathSync(db.filename)
		databaseIds.set(db, databaseId)
	}
	return JSON.stringify([databaseId, token.incarnation, token.run])
}

function instanceRegistryKey(db: Database, id: string): string {
	return registryKey(db, new WorkflowStore(db).currentToken(id))
}
// Soft reload stops the engine, not user callbacks; replay must drain still-live attempts.
const runningForwardAttempts = new Map<string, Set<Promise<unknown>>>()
const ROLLBACK_REQUESTED = 'workflow rollback requested'
const WORKFLOW_TERMINATED = 'workflow terminated'
const WORKFLOW_DELETED = 'workflow deleted'
const workflowExecution = new AsyncLocalStorage<WorkflowExecutionToken>()

export interface WorkflowBatchDeleteResult {
	deleted: { id: string }[]
	errors: { id: string; code: number; message: string }[]
}

// Addressable IDs and batch error codes follow miniflare@5.20261001.0-alpha (workflows-shared@0.15.0).
function validateDeleteId(id: unknown): void {
	if (typeof id !== 'string' || id.length === 0 || id.length > 271 || !/^[a-zA-Z0-9, */#_-]+$/.test(id)) {
		throw new Error('Instance ID is invalid (instance.invalid_id)')
	}
}

function isOwnExecution(token: WorkflowExecutionToken): boolean {
	const caller = workflowExecution.getStore()
	return caller?.incarnation === token.incarnation && caller.run === token.run && caller.epoch === token.epoch
}

function deleteWorkflowInstance(db: Database, token: WorkflowExecutionToken): void {
	const key = registryKey(db, token)
	new WorkflowStore(db).deleteInstance(token)
	abortControllers.get(key)?.abort(WORKFLOW_DELETED)
	runningForwardAttempts.get(key)?.clear()
	runningForwardAttempts.delete(key)
	executions.delete(key)
	abortControllers.delete(key)
	eventWaiters.delete(key)
	sleepResolvers.delete(key)
	clearInstanceMocks(key)
	try {
		fireStatusCallbacks(key, 'deleted')
	} catch (error) {
		console.error('[workflow] deletion listener failed:', error)
	}
	statusCallbacks.delete(key)
	stepCallbacks.delete(key)
	sleepCallbacks.delete(key)
	eventWaitCallbacks.delete(key)
}

// --- Sleep skip registry (per-process) ---
// Allows skipSleep() to resolve the active sleep/sleepUntil delay immediately

const sleepResolvers = new Map<string, Map<number, () => void>>()

// --- Notification hooks (per-process, for testing) ---

const stepCallbacks = new Map<string, Map<string, Set<(output: unknown) => void>>>()
const sleepCallbacks = new Map<string, Set<() => void>>()
const eventWaitCallbacks = new Map<string, Map<string, Set<() => void>>>()
const statusCallbacks = new Map<string, Set<(status: string) => void>>()

// --- Mock registry (per-process, for testing) ---

export interface StepMock {
	type: 'result' | 'error' | 'timeout'
	value?: unknown // result value or Error for error type
	times?: number // how many times to apply (undefined = forever)
	_used?: number // internal counter
}

const stepMocks = new Map<string, Map<string, StepMock>>()
const sleepDisabledInstances = new Set<string>()
const eventMocks = new Map<string, Map<string, { payload: unknown }>>()
const eventTimeoutMocks = new Map<string, Set<string>>()

function stepSelectorKey(name: string, selector?: WorkflowStepKey): string {
	return JSON.stringify(selector ? [selector.type, selector.name, selector.count] : [name])
}

export function registerStepMock(instanceId: string, stepName: string, mock: StepMock, selector?: WorkflowStepKey): void {
	let instanceMocks = stepMocks.get(instanceId)
	if (!instanceMocks) {
		instanceMocks = new Map()
		stepMocks.set(instanceId, instanceMocks)
	}
	instanceMocks.set(stepSelectorKey(stepName, selector), { ...mock, _used: 0 })
}

export function registerSleepDisable(instanceId: string): void {
	sleepDisabledInstances.add(instanceId)
}

export function registerEventMock(instanceId: string, eventType: string, payload: unknown): void {
	let instanceMocks = eventMocks.get(instanceId)
	if (!instanceMocks) {
		instanceMocks = new Map()
		eventMocks.set(instanceId, instanceMocks)
	}
	instanceMocks.set(eventType, { payload })
}

export function registerEventTimeoutMock(instanceId: string, eventType: string): void {
	let instanceMocks = eventTimeoutMocks.get(instanceId)
	if (!instanceMocks) {
		instanceMocks = new Set()
		eventTimeoutMocks.set(instanceId, instanceMocks)
	}
	instanceMocks.add(eventType)
}

export function clearInstanceMocks(instanceId: string): void {
	stepMocks.delete(instanceId)
	sleepDisabledInstances.delete(instanceId)
	eventMocks.delete(instanceId)
	eventTimeoutMocks.delete(instanceId)
}

// --- Step ---

export class WorkflowStepImpl {
	private abortSignal: AbortSignal
	private db: Database
	private instanceId: string
	private stepCount = 0
	private occurrenceCounts = new Map<string, number>()
	private startOrder = 0
	private store: WorkflowStore
	readonly token: WorkflowExecutionToken
	private registryId: string
	private limits: Required<WorkflowLimits>
	private clock: Clock
	private replayRollback: boolean
	private pending = new Set<Promise<unknown>>()
	private forwardAttempts = new Set<Promise<unknown>>()
	private rollbacks = new Map<number, (error: Error, signal: AbortSignal) => Promise<void>>()
	private closed = false

	constructor(
		abortSignal: AbortSignal,
		db: Database,
		instanceId: string,
		limits: Required<WorkflowLimits>,
		clock?: Clock,
		token?: WorkflowExecutionToken,
	) {
		this.abortSignal = abortSignal
		this.db = db
		this.instanceId = instanceId
		this.limits = limits
		this.clock = clock ?? realClock
		this.store = new WorkflowStore(db)
		this.token = token ?? this.store.acquireExecution(instanceId, this.store.currentToken(instanceId).workflowName)
		this.registryId = registryKey(db, this.token)
		const rollback = db.query<RollbackState, [string]>('SELECT * FROM workflow_rollbacks WHERE instance_id = ?').get(instanceId)
		this.replayRollback = rollback?.phase === 'running' || rollback?.phase === 'requested'
	}

	private async checkPaused(): Promise<void> {
		if (this.closed) throw new Error('Workflow forward execution has ended')
		while (true) {
			if (this.abortSignal.aborted) throw new Error('workflow terminated')
			const row = this.db
				.query('SELECT status FROM workflow_instances WHERE id = ?')
				.get(this.instanceId) as { status: string } | null
			if (!row || row.status !== 'paused') break
			await interruptibleDelay(50, this.abortSignal)
		}
	}

	private checkStepLimit(): void {
		this.stepCount++
		if (this.stepCount > this.limits.maxStepsPerWorkflow) {
			throw new Error(`Workflow exceeded maximum of ${this.limits.maxStepsPerWorkflow} steps`)
		}
	}

	private allocate(name: string, method: WorkflowStepMethod, rollbackRegistered = false): WorkflowOccurrenceRecord {
		if (this.closed || this.abortSignal.aborted) throw new Error('Workflow forward execution has ended')
		if (method === 'do' && name.length > this.limits.maxStepNameLength) {
			throw new Error(`Step name must be ${this.limits.maxStepNameLength} characters or fewer, got ${name.length}`)
		}
		const type = method === 'sleepUntil' ? 'sleep' : method
		const identity = JSON.stringify([type, name])
		const count = (this.occurrenceCounts.get(identity) ?? 0) + 1
		this.occurrenceCounts.set(identity, count)
		if (type !== 'sleep') this.checkStepLimit()
		return this.store.openOccurrence(this.token, { key: { type, name, count }, method, startOrder: ++this.startOrder, rollbackRegistered })
	}

	private ref(record: WorkflowOccurrenceRecord): WorkflowOccurrenceRef {
		return { token: this.token, occurrenceId: record.id }
	}

	private getCachedStep(record: WorkflowOccurrenceRecord): WorkflowCheckpoint | null {
		return this.store.readCheckpoint(this.ref(record))
	}

	private async persistStream(
		record: WorkflowOccurrenceRecord,
		source: ReadableStream<unknown>,
		attemptToken: string,
		signal: AbortSignal,
	): Promise<void> {
		const body = acceptWorkflowStream(source)
		const reader = body.getReader()
		let committed = false
		let released = false
		const release = () => {
			if (released) return
			released = true
			reader.releaseLock()
		}
		const cancel = () => {
			if (released) return
			try {
				void reader.cancel(signal.reason).catch(() => {})
			} finally {
				release()
			}
		}
		signal.addEventListener('abort', cancel, { once: true })
		try {
			signal.throwIfAborted()
			const attempt = this.store.beginStream(this.ref(record), attemptToken)
			let writes = 0
			while (true) {
				signal.throwIfAborted()
				const chunk = await reader.read()
				signal.throwIfAborted()
				if (chunk.done) break
				if (!(chunk.value instanceof Uint8Array)) throw new TypeError('Workflow stream chunks must be Uint8Array')
				for (let offset = 0; offset < chunk.value.byteLength; offset += 65536) {
					signal.throwIfAborted()
					this.store.appendStreamChunk(attempt, chunk.value.subarray(offset, offset + 65536))
					if (++writes % 16 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0))
				}
				// Empty and synchronously ready producer chunks must not starve cancellation.
				if (chunk.value.byteLength === 0) await new Promise<void>(resolve => setTimeout(resolve, 0))
			}
			this.store.commitStream(attempt, this.clock.now())
			committed = true
		} finally {
			if (!committed) {
				this.store.invalidateStreamAttempt(this.ref(record), attemptToken)
				cancel()
			}
			signal.removeEventListener('abort', cancel)
			release()
		}
	}

	private cacheStep(record: WorkflowOccurrenceRecord, output: unknown): void {
		const name = record.key.name
		const serialized = JSON.stringify(output)
		if (serialized !== undefined && serialized.length > this.limits.maxStepOutputBytes) {
			throw new Error(`Step "${name}" output exceeds maximum size of 1 MiB`)
		}
		this.store.commitCheckpoint(this.ref(record), serialized === undefined ? { kind: 'undefined' } : { kind: 'json', serialized }, this.clock.now())
		if (record.key.count === 1) fireStepCallbacks(this.registryId, name, output)
		fireStepCallbacks(this.registryId, name, output, record.key)
	}

	do<T>(name: string, callback: (ctx: WorkflowStepContext) => Promise<T>, rollbackOptions?: WorkflowStepRollbackOptions<T>): Promise<T>
	do<T>(
		name: string,
		config: WorkflowStepConfig,
		callback: (ctx: WorkflowStepContext) => Promise<T>,
		rollbackOptions?: WorkflowStepRollbackOptions<T>,
	): Promise<T>
	do<T>(
		name: string,
		callbackOrConfig: ((ctx: WorkflowStepContext) => Promise<T>) | WorkflowStepConfig,
		callbackOrRollback?: ((ctx: WorkflowStepContext) => Promise<T>) | WorkflowStepRollbackOptions<T>,
		rollbackOptions?: WorkflowStepRollbackOptions<T>,
	): Promise<T> {
		const callback = typeof callbackOrConfig === 'function' ? callbackOrConfig : callbackOrRollback
		const options = typeof callbackOrConfig === 'function' && typeof callbackOrRollback !== 'function' ? callbackOrRollback : rollbackOptions
		if (typeof callback !== 'function') return Promise.reject(new Error('Workflow step callback is required'))
		const config = typeof callbackOrConfig === 'function' ? undefined : callbackOrConfig
		let record: WorkflowOccurrenceRecord
		try {
			record = this.allocate(name, 'do', options !== undefined)
		} catch (error) {
			return Promise.reject(error)
		}
		const promise = this.executeDo(record, config, callback, options).catch(err => {
			if (this.abortSignal.reason === WORKFLOW_DELETED) return new Promise<never>(() => {})
			if (!this.abortSignal.aborted && !this.replayRollback) this.recordForwardFailure(record, workflowError(err))
			throw err
		})
		this.pending.add(promise)
		promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise))
		return promise
	}

	async settlePending(): Promise<void> {
		this.closed = true
		await this.waitForPromises(this.pending, 'Forward steps')
	}

	async settleForwardAttempts(): Promise<void> {
		await this.waitForPromises(runningForwardAttempts.get(this.registryId) ?? this.forwardAttempts, 'Forward attempts')
	}

	private async waitForPromises(promises: Set<Promise<unknown>>, label: string): Promise<void> {
		if (this.abortSignal.aborted) return
		try {
			while (promises.size) {
				await runWithTimeout(
					async () => {
						await Promise.allSettled([...promises])
					},
					undefined,
					label,
					this.abortSignal,
				)
			}
		} catch (error) {
			if (!this.abortSignal.aborted) throw error
		}
	}

	private startForwardAttempt<T>(callback: () => Promise<T>): Promise<T> {
		const attempt = Promise.resolve().then(() => workflowExecution.run(this.token, callback))
		const attempts = runningForwardAttempts.get(this.registryId) ?? this.forwardAttempts
		this.forwardAttempts = attempts
		runningForwardAttempts.set(this.registryId, attempts)
		attempts.add(attempt)
		const settled = () => {
			attempts.delete(attempt)
			if (attempts.size === 0 && runningForwardAttempts.get(this.registryId) === attempts) runningForwardAttempts.delete(this.registryId)
		}
		attempt.then(settled, settled)
		return attempt
	}

	private resolveConfig(config?: WorkflowStepConfig): WorkflowStepConfig {
		return {
			retries: {
				limit: config?.retries?.limit ?? this.limits.defaultRetryLimit,
				delay: config?.retries?.delay ?? this.limits.defaultRetryDelayMs,
				backoff: config?.retries?.backoff ?? this.limits.defaultRetryBackoff,
			},
			timeout: config?.timeout ?? this.limits.defaultStepTimeoutMs,
		}
	}

	private async retryDelay(config: WorkflowStepConfig, ctx: WorkflowStepContext, error: Error, signal: AbortSignal): Promise<void> {
		const delay = config.retries?.delay ?? this.limits.defaultRetryDelayMs
		const duration = typeof delay === 'function'
			? await runWithTimeout(async () => delay({ ctx, error }), undefined, 'Retry delay calculation', signal)
			: delay
		const ms = typeof delay === 'function'
			? parseDuration(duration)
			: computeDelay(parseDuration(duration), ctx.attempt - 1, config.retries?.backoff ?? this.limits.defaultRetryBackoff)
		await interruptibleDelay(ms, signal)
	}

	private async executeDo<T>(
		record: WorkflowOccurrenceRecord,
		config: WorkflowStepConfig | undefined,
		callback: (ctx: WorkflowStepContext) => Promise<T>,
		options?: WorkflowStepRollbackOptions<T>,
	): Promise<T> {
		const { name, count } = record.key
		await this.checkPaused()
		if (this.abortSignal.aborted) throw new Error('workflow terminated')

		const resolvedConfig = this.resolveConfig(config)
		const previous = record
		if (options && record.rollbackRegistered) {
			this.rollbacks.set(record.id, async (error, signal) => {
				const history = this.store.readOccurrence(this.ref(record))
				await this.runRollback(history, options.rollbackConfig, signal, async () => {
					const cached = this.getCachedStep(record)
					const output = cached ? decodeStepOutput<T>(cached, this.store) : undefined
					await options.rollback({ ctx: { step: { name, count }, attempt: history.attempt, config: resolvedConfig }, error, output })
				})
			})
		}

		// Check checkpoint
		const cached = this.getCachedStep(record)
		if (cached) {
			console.log(`  [workflow] step: ${name} (cached)`)
			return decodeStepOutput<T>(cached, this.store)
		}
		if (previous?.state === 'failed' || this.replayRollback) {
			throw restoredError(previous.error?.message ?? null, previous.error?.name ?? null, previous.error?.nonRetryable)
		}

		// Check step mocks
		const instanceMocks = stepMocks.get(this.registryId)
		const mock = instanceMocks?.get(stepSelectorKey(name, record.key)) ?? (count === 1 ? instanceMocks?.get(stepSelectorKey(name)) : undefined)
		if (mock) {
			const shouldApply = mock.times === undefined || (mock._used ?? 0) < mock.times
			if (shouldApply) {
				mock._used = (mock._used ?? 0) + 1
				if (mock.type === 'result') {
					console.log(`  [workflow] step: ${name} (mocked)`)
					this.cacheStep(record, mock.value)
					return mock.value as T
				}
				if (mock.type === 'error') {
					console.log(`  [workflow] step: ${name} (mocked error)`)
					this.recordForwardFailure(record, workflowError(mock.value))
					throw mock.value
				}
				if (mock.type === 'timeout') {
					console.log(`  [workflow] step: ${name} (mocked timeout)`)
					const error = new Error(`Step "${name}" timed out (mocked)`)
					this.recordForwardFailure(record, error)
					throw error
				}
			}
		}

		console.log(`  [workflow] step: ${name}`)

		return startSpan({
			name: `step ${name}`,
			kind: 'internal',
			attributes: { 'workflow.step.name': name, 'workflow.instance_id': this.instanceId },
		}, async () => {
			const maxRetries = resolvedConfig.retries?.limit ?? this.limits.defaultRetryLimit
			const timeoutMs = parseDuration(resolvedConfig.timeout ?? this.limits.defaultStepTimeoutMs)

			if (timeoutMs > this.limits.maxStepDoTimeoutMs) {
				throw new Error(`Step timeout ${timeoutMs}ms exceeds maximum of ${this.limits.maxStepDoTimeoutMs}ms`)
			}

			// Load persisted failed attempts so retries survive server restarts
			const attemptRow = this.store.readOccurrence(this.ref(record))
			const startAttempt = attemptRow.failedAttempts

			let lastError: unknown = restoredError(attemptRow.error?.message ?? null, attemptRow.error?.name ?? null)
			for (let attempt = startAttempt; attempt <= maxRetries; attempt++) {
				if (this.abortSignal.aborted) throw new Error('workflow terminated')
				const ctx: WorkflowStepContext = { step: { name, count }, attempt: attempt + 1, config: resolvedConfig }
				const attemptToken = this.store.startAttempt(this.ref(record), attempt + 1)
				const streamController = new AbortController()
				const stopAttempt = (reason: unknown) => {
					if (streamController.signal.aborted) return
					this.store.invalidateStreamAttempt(this.ref(record), attemptToken)
					streamController.abort(reason)
				}
				const onAbort = () => stopAttempt(this.abortSignal.reason)
				this.abortSignal.addEventListener('abort', onAbort, { once: true })
				try {
					return await runWithTimeout(
						async () => {
							const result = await this.startForwardAttempt(() => callback(ctx))
							if (result instanceof ReadableStream) {
								await this.persistStream(record, result, attemptToken, streamController.signal)
								const checkpoint = this.getCachedStep(record)
								if (!checkpoint) throw new Error('Missing committed workflow stream checkpoint')
								const output = decodeStepOutput<T>(checkpoint, this.store)
								const readOutput = () => decodeStepOutput(checkpoint, this.store)
								if (count === 1) fireStepCallbacks(this.registryId, name, undefined, undefined, readOutput)
								fireStepCallbacks(this.registryId, name, undefined, record.key, readOutput)
								return output
							}
							streamController.signal.throwIfAborted()
							if (this.abortSignal.aborted) throw new Error('workflow terminated')
							this.cacheStep(record, result)
							return result
						},
						timeoutMs,
						`Step "${name}"`,
						this.abortSignal,
					)
				} catch (err) {
					stopAttempt(err)
					if (this.abortSignal.aborted) throw err
					if (this.getCachedStep(record)?.kind === 'stream') throw err
					if (err instanceof NonRetryableError) {
						this.recordForwardFailure(record, err)
						throw err
					}
					lastError = err
					const errName = err instanceof Error ? (err.name || 'Error') : 'Error'
					const errMsg = err instanceof Error ? err.message : String(err)
					// Record error as span event so it appears in trace detail
					addSpanEvent('step.retry_error', 'error', `Attempt ${attempt + 1}/${maxRetries + 1} failed: ${errMsg}`, {
						'error.name': errName,
						'error.message': errMsg,
						'error.stack': err instanceof Error ? err.stack : undefined,
						'step.attempt': attempt + 1,
						'step.max_retries': maxRetries,
					})
					// Persist to errors view (ALS context is active inside startSpan)
					const errorId = persistError(err, 'workflow.step')
					// Persist failed attempt count, error, and link to error detail
					this.store.recordAttemptFailure(
						this.ref(record),
						attempt + 1,
						{ message: errMsg, name: errName, nonRetryable: false, errorId: errorId ?? null },
						this.clock.now(),
					)
					if (attempt < maxRetries) {
						await this.retryDelay(resolvedConfig, ctx, workflowError(err), this.abortSignal)
					}
				} finally {
					this.abortSignal.removeEventListener('abort', onAbort)
				}
			}
			this.recordForwardFailure(record, workflowError(lastError))
			throw lastError
		})
	}

	private recordForwardFailure(record: WorkflowOccurrenceRecord, error: Error): void {
		this.store.failOccurrence(this.ref(record), {
			message: error.message,
			name: error.name,
			nonRetryable: error instanceof NonRetryableError,
			errorId: null,
		}, this.clock.now())
	}

	private async runRollback(
		history: WorkflowOccurrenceRecord,
		config: WorkflowStepConfig | undefined,
		signal: AbortSignal,
		callback: () => Promise<void>,
	): Promise<void> {
		const { name, count } = history.key
		const resolved = this.resolveConfig(config)
		const maxRetries = resolved.retries?.limit ?? this.limits.defaultRetryLimit
		const timeout = parseDuration(resolved.timeout ?? this.limits.defaultStepTimeoutMs)
		if (timeout > this.limits.maxStepDoTimeoutMs) throw new Error(`Step timeout ${timeout}ms exceeds maximum of ${this.limits.maxStepDoTimeoutMs}ms`)
		let error = restoredError(history.rollbackError?.message ?? null, history.rollbackError?.name ?? null)
		for (let attempt = history.rollbackAttempts; attempt <= maxRetries; attempt++) {
			if (signal.aborted) throw new Error('workflow terminated')
			this.store.startRollbackAttempt(this.ref(history))
			try {
				await runWithTimeout(() => workflowExecution.run(this.token, callback), timeout, `Rollback "${name}"`, signal)
				if (signal.aborted) throw new Error('workflow terminated')
				this.store.finishRollback(this.ref(history), 'complete')
				return
			} catch (err) {
				if (signal.aborted) throw err
				error = workflowError(err)
				this.store.recordRollbackFailure(this.ref(history), attempt + 1, {
					message: error.message,
					name: error.name,
					nonRetryable: error instanceof NonRetryableError,
					errorId: null,
				})
				if (err instanceof NonRetryableError) break
				if (attempt < maxRetries) await this.retryDelay(resolved, { step: { name, count }, attempt: attempt + 1, config: resolved }, error, signal)
			}
		}
		this.store.finishRollback(this.ref(history), 'failed')
		throw error
	}

	async rollback(error: Error, signal: AbortSignal): Promise<void> {
		const eligible = this.store.listRollbackOccurrences(this.token)
		for (const history of eligible) {
			if (signal.aborted) throw new Error('workflow terminated')
			if (history.rollbackState === 'complete') continue
			if (history.rollbackState === 'failed') throw restoredError(history.rollbackError?.message ?? null, history.rollbackError?.name ?? null)
			const handler = this.rollbacks.get(history.id)
			if (!handler) throw new Error(`Rollback handler for step "${history.key.name}" was not recovered during replay`)
			await handler(error, signal)
		}
	}

	async sleep(name: string, duration: string | number) {
		const record = this.allocate(name, 'sleep')
		const ms = typeof duration === 'number' ? duration : parseDuration(duration)
		if (!record.checkpoint && record.deadline === null && ms > this.limits.maxSleepMs) {
			throw new Error(`Sleep duration ${ms}ms exceeds maximum of ${this.limits.maxSleepMs}ms`)
		}
		return this.executeSleep(record, this.clock.now() + ms)
	}

	async sleepUntil(name: string, timestamp: Date | number) {
		const record = this.allocate(name, 'sleepUntil')
		return this.executeSleep(record, typeof timestamp === 'number' ? timestamp : timestamp.getTime())
	}

	private async executeSleep(record: WorkflowOccurrenceRecord, requestedDeadline: number): Promise<void> {
		const delay = Math.max(0, (record.deadline ?? requestedDeadline) - this.clock.now())
		if (!record.checkpoint && record.deadline === null && delay > this.limits.maxSleepMs) {
			throw new Error(`Sleep duration ${delay}ms exceeds maximum of ${this.limits.maxSleepMs}ms`)
		}
		const deadline = record.checkpoint ? record.deadline : this.store.setDeadline(this.ref(record), requestedDeadline, null)
		await this.checkPaused()
		if (this.replayRollback) return
		if (this.abortSignal.aborted) throw new Error('workflow terminated')
		return startSpan({
			name: `${record.method} ${record.key.name}`,
			kind: 'internal',
			attributes: { 'workflow.step.name': record.key.name, 'workflow.step.type': record.method, 'workflow.instance_id': this.instanceId },
		}, async () => {
			if (record.checkpoint) return
			if (deadline === null) throw new Error('Missing workflow sleep deadline')
			const output = { until: record.method === 'sleepUntil' ? new Date(deadline).toISOString() : deadline }
			fireStepCallbacks(this.registryId, `${record.method}:${record.key.name}`, output)
			fireStepCallbacks(this.registryId, record.key.name, output, record.key)
			if (!sleepDisabledInstances.has(this.registryId)) {
				await skippableDelay(Math.max(0, deadline - this.clock.now()), this.abortSignal, this.registryId, record.id)
			}
			this.store.completeSleep(this.ref(record), this.clock.now())
		})
	}

	async waitForEvent<T = unknown>(name: string, options: { type: string; timeout?: string }): Promise<{ payload: T; timestamp: Date; type: string }> {
		const record = this.allocate(name, 'waitForEvent')
		if (!EVENT_TYPE_PATTERN.test(options.type)) {
			throw new Error(`Invalid event type "${options.type}". Must be 1-100 characters, only letters, digits, hyphens and underscores.`)
		}
		const timeoutMs = options.timeout ? parseDuration(options.timeout) : this.limits.defaultWaitForEventTimeoutMs
		if (!record.checkpoint && timeoutMs < this.limits.minWaitForEventTimeoutMs) {
			throw new Error(`waitForEvent timeout ${timeoutMs}ms is below minimum of ${this.limits.minWaitForEventTimeoutMs}ms`)
		}
		if (!record.checkpoint && timeoutMs > this.limits.maxWaitForEventTimeoutMs) {
			throw new Error(`waitForEvent timeout ${timeoutMs}ms exceeds maximum of ${this.limits.maxWaitForEventTimeoutMs}ms`)
		}
		const deadline = record.checkpoint ? record.deadline : this.store.setDeadline(this.ref(record), this.clock.now() + timeoutMs, options.type)
		await this.checkPaused()
		if (this.abortSignal.aborted) throw new Error('workflow terminated')
		if (record.state === 'failed') throw restoredError(record.error?.message ?? null, record.error?.name ?? null)
		if (this.replayRollback && !record.checkpoint) throw new Error('workflow terminated')

		// Check event timeout mocks
		const timeoutMocks = eventTimeoutMocks.get(this.registryId)
		if (timeoutMocks?.has(options.type)) {
			console.log(`  [workflow] waitForEvent: ${name} (mocked timeout)`)
			throw new Error(`waitForEvent timed out (mocked)`)
		}

		// Check event mocks — pre-insert into DB so existing flow picks them up
		const instanceEventMocks = eventMocks.get(this.registryId)
		const eventMock = instanceEventMocks?.get(options.type)
		if (eventMock) {
			instanceEventMocks!.delete(options.type)
			this.store.enqueueEvent(this.token, options.type, eventMock.payload !== undefined ? JSON.stringify(eventMock.payload) : null, this.clock.now())
		}

		console.log(`  [workflow] waitForEvent: ${name} (type: ${options.type})`)
		return startSpan({
			name: `waitForEvent ${name}`,
			kind: 'internal',
			attributes: {
				'workflow.step.name': name,
				'workflow.step.type': 'waitForEvent',
				'workflow.event.type': options.type,
				'workflow.instance_id': this.instanceId,
			},
		}, async () => {
			// Check checkpoint
			const cached = this.store.readCheckpoint(this.ref(record))
			if (cached) {
				return decodeWorkflowEvent<T>(cached)
			}

			// Update status to waiting
			this.store.transaction(this.token, () =>
				this.db
					.query("UPDATE workflow_instances SET status = 'waiting', updated_at = ? WHERE id = ?")
					.run(this.clock.now(), this.instanceId))

			if (deadline === null) throw new Error('Missing workflow wait deadline')

			const result = await new Promise<{ payload: T; timestamp: Date; type: string }>((resolve, reject) => {
				const waiters = getWaitersForInstance(this.registryId)
				let timer: ReturnType<typeof setTimeout> | undefined
				let abortHandler: (() => void) | undefined

				const cleanup = () => {
					waiters.delete(record.id)
					if (timer) clearTimeout(timer)
					if (abortHandler) this.abortSignal.removeEventListener('abort', abortHandler)
				}

				const wake = () => {
					try {
						const checkpoint = this.store.transaction(this.token, () => {
							const checkpoint = this.store.consumeEvent(this.ref(record), this.clock.now())
							if (checkpoint?.kind === 'json' && checkpoint.serialized.length > this.limits.maxStepOutputBytes) {
								throw new Error(`Step "${name}" output exceeds maximum size of 1 MiB`)
							}
							return checkpoint
						})
						if (!checkpoint) return
						const event = decodeWorkflowEvent<T>(checkpoint)
						cleanup()
						resolve(event)
					} catch (error) {
						cleanup()
						reject(error)
					}
				}
				waiters.set(record.id, { type: options.type, wake })

				timer = setTimeout(() => {
					cleanup()
					const error = new Error(`waitForEvent timed out after ${options.timeout ?? '24 hours'}`)
					try {
						this.recordForwardFailure(record, error)
					} catch (failure) {
						reject(failure)
						return
					}
					for (const waiter of waiters.values()) waiter.wake()
					reject(error)
				}, Math.max(0, deadline - this.clock.now()))

				abortHandler = () => {
					cleanup()
					reject(new Error('workflow terminated'))
				}
				this.abortSignal.addEventListener('abort', abortHandler)
				wake()
				fireEventWaitCallbacks(this.registryId, options.type)
			})

			const status = eventWaiters.get(this.registryId)?.size ? 'waiting' : 'running'
			this.store.transaction(this.token, () =>
				this.db
					.query('UPDATE workflow_instances SET status = ?, updated_at = ? WHERE id = ?')
					.run(status, this.clock.now(), this.instanceId))

			if (record.key.count === 1) fireStepCallbacks(this.registryId, `waitForEvent:${name}`, result)
			fireStepCallbacks(this.registryId, name, result, record.key)
			return result
		})
	}
}

async function runWithTimeout<T>(
	callback: () => Promise<T>,
	timeoutMs: number | undefined,
	label: string,
	signal: AbortSignal,
): Promise<T> {
	if (signal.aborted) throw new Error('workflow terminated')
	const release = getActiveInvocation()?.retain('handler')
	const actual = Promise.resolve().then(callback)
	// A raced callback may outlive the engine; retries make its rejection a liveness event, not the root outcome.
	actual.then(() => release?.(), () => release?.())
	let timer: ReturnType<typeof setTimeout> | undefined
	let onAbort: (() => void) | undefined
	try {
		return await Promise.race([
			actual,
			new Promise<never>((_, reject) => {
				if (timeoutMs !== undefined) timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
				onAbort = () => reject(new Error('workflow terminated'))
				signal.addEventListener('abort', onAbort, { once: true })
			}),
		])
	} finally {
		if (timer !== undefined) clearTimeout(timer)
		if (onAbort) signal.removeEventListener('abort', onAbort)
	}
}

function computeDelay(baseMs: number, attempt: number, backoff: 'constant' | 'linear' | 'exponential'): number {
	switch (backoff) {
		case 'constant':
			return baseMs
		case 'linear':
			return baseMs * (attempt + 1)
		case 'exponential':
			return baseMs * Math.pow(2, attempt)
	}
}

function interruptibleDelay(ms: number, abortSignal: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve()
	if (abortSignal.aborted) return Promise.reject(new Error('workflow terminated'))
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup()
			resolve()
		}, ms)
		const abortHandler = () => {
			cleanup()
			reject(new Error('workflow terminated'))
		}
		const cleanup = () => {
			clearTimeout(timer)
			abortSignal.removeEventListener('abort', abortHandler)
		}
		abortSignal.addEventListener('abort', abortHandler)
	})
}

/** Like interruptibleDelay, but also resolves when skipSleep() is called for the instance. */
function skippableDelay(ms: number, abortSignal: AbortSignal, instanceId: string, occurrenceId: number): Promise<void> {
	if (ms <= 0) return Promise.resolve()
	if (abortSignal.aborted) return Promise.reject(new Error('workflow terminated'))
	return new Promise((resolve, reject) => {
		const resolvers = sleepResolvers.get(instanceId) ?? new Map<number, () => void>()
		sleepResolvers.set(instanceId, resolvers)
		const timer = setTimeout(() => {
			cleanup()
			resolve()
		}, ms)
		const abortHandler = () => {
			cleanup()
			reject(new Error('workflow terminated'))
		}
		const cleanup = () => {
			clearTimeout(timer)
			abortSignal.removeEventListener('abort', abortHandler)
			resolvers.delete(occurrenceId)
			if (resolvers.size === 0) sleepResolvers.delete(instanceId)
		}
		resolvers.set(occurrenceId, () => {
			cleanup()
			resolve()
		})
		abortSignal.addEventListener('abort', abortHandler)
		fireSleepCallbacks(instanceId)
	})
}

/** Get the event types an instance is currently waiting for (in-memory). */
export function getWaitingEventTypes(instanceId: string): string[] {
	const waiters = eventWaiters.get(instanceId)
	if (!waiters) return []
	return [...new Set([...waiters.values()].map(waiter => waiter.type))]
}

/** Check if an instance is currently sleeping (has a registered sleep resolver). */
export function isInstanceSleeping(instanceId: string): boolean {
	return sleepResolvers.has(instanceId)
}

// --- Notification hook registration (for testing) ---

function fireStepCallbacks(instanceId: string, stepName: string, output: unknown, selector?: WorkflowStepKey, readOutput?: () => unknown): void {
	const instanceCbs = stepCallbacks.get(instanceId)
	if (!instanceCbs) return
	const cbs = instanceCbs.get(stepSelectorKey(stepName, selector))
	if (!cbs) return
	for (const cb of cbs) cb(readOutput ? readOutput() : output)
}

function fireSleepCallbacks(instanceId: string): void {
	const cbs = sleepCallbacks.get(instanceId)
	if (!cbs) return
	for (const cb of cbs) cb()
}

function fireEventWaitCallbacks(instanceId: string, eventType: string): void {
	const instanceCbs = eventWaitCallbacks.get(instanceId)
	if (!instanceCbs) return
	const cbs = instanceCbs.get(eventType)
	if (!cbs) return
	for (const cb of cbs) cb()
}

function fireStatusCallbacks(instanceId: string, status: string): void {
	const cbs = statusCallbacks.get(instanceId)
	if (!cbs) return
	for (const cb of cbs) cb(status)
}

/** Register a callback for when a step completes. Returns an unsubscribe function. */
export function onStepComplete(instanceId: string, stepName: string, cb: (output: unknown) => void, selector?: WorkflowStepKey): () => void {
	const key = stepSelectorKey(stepName, selector)
	let instanceCbs = stepCallbacks.get(instanceId)
	if (!instanceCbs) {
		instanceCbs = new Map()
		stepCallbacks.set(instanceId, instanceCbs)
	}
	let cbs = instanceCbs.get(key)
	if (!cbs) {
		cbs = new Set()
		instanceCbs.set(key, cbs)
	}
	cbs.add(cb)
	return () => {
		cbs!.delete(cb)
		if (cbs!.size === 0) instanceCbs!.delete(key)
		if (instanceCbs!.size === 0) stepCallbacks.delete(instanceId)
	}
}

/** Register a callback for when the instance starts sleeping. Returns an unsubscribe function. */
export function onSleepRegistered(instanceId: string, cb: () => void): () => void {
	let cbs = sleepCallbacks.get(instanceId)
	if (!cbs) {
		cbs = new Set()
		sleepCallbacks.set(instanceId, cbs)
	}
	cbs.add(cb)
	return () => {
		cbs!.delete(cb)
		if (cbs!.size === 0) sleepCallbacks.delete(instanceId)
	}
}

/** Register a callback for when the instance starts waiting for an event. Returns an unsubscribe function. */
export function onEventWaitRegistered(instanceId: string, eventType: string, cb: () => void): () => void {
	let instanceCbs = eventWaitCallbacks.get(instanceId)
	if (!instanceCbs) {
		instanceCbs = new Map()
		eventWaitCallbacks.set(instanceId, instanceCbs)
	}
	let cbs = instanceCbs.get(eventType)
	if (!cbs) {
		cbs = new Set()
		instanceCbs.set(eventType, cbs)
	}
	cbs.add(cb)
	return () => {
		cbs!.delete(cb)
		if (cbs!.size === 0) instanceCbs!.delete(eventType)
		if (instanceCbs!.size === 0) eventWaitCallbacks.delete(instanceId)
	}
}

/** Register a callback for when the instance status changes. Returns an unsubscribe function. */
export function onStatusChange(instanceId: string, cb: (status: string) => void): () => void {
	let cbs = statusCallbacks.get(instanceId)
	if (!cbs) {
		cbs = new Set()
		statusCallbacks.set(instanceId, cbs)
	}
	cbs.add(cb)
	return () => {
		cbs!.delete(cb)
		if (cbs!.size === 0) statusCallbacks.delete(instanceId)
	}
}

export function parseDuration(duration: string | number): number {
	if (typeof duration === 'number') return duration
	const match = duration.match(/^(\d+)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?|d|days?|w|weeks?|months?|y|years?)$/i)
	if (!match) throw new Error(`Invalid duration: "${duration}"`)
	const value = parseInt(match[1]!, 10)
	const unit = match[2]!.toLowerCase()
	if (unit.startsWith('ms') || unit.startsWith('millisecond')) return value
	if (unit.startsWith('s')) return value * 1000
	if (unit === 'm' || unit.startsWith('minute')) return value * 60_000
	if (unit.startsWith('h')) return value * 3_600_000
	if (unit.startsWith('d')) return value * 86_400_000
	if (unit.startsWith('w')) return value * 7 * 86_400_000
	if (unit.startsWith('month')) return value * 30 * 86_400_000
	if (unit.startsWith('y')) return value * 365 * 86_400_000
	throw new Error(`Invalid duration: "${duration}"`)
}

// --- Base class ---

/**
 * Wire a workflow class from the user module onto a `SqliteWorkflowBinding`.
 * Both the in-process `wireClassRefs` and the worker-thread entry use this
 * — keeps the lookup-throw-setClass-resumeInterrupted contract in one place.
 */
export function wireWorkflowClass(
	binding: SqliteWorkflowBinding,
	className: string,
	workerModule: Record<string, unknown>,
	env: Record<string, unknown>,
): void {
	const cls = workerModule[className]
	if (!cls) throw new Error(`Workflow class "${className}" not exported from worker module`)
	binding._setClass(cls as new(ctx: unknown, env: unknown) => WorkflowEntrypointBase, env)
	// NOTE: resumeInterrupted() is deliberately NOT called here. Resuming during
	// worker init would re-execute running/waiting instances while the previous
	// generation's worker (terminated only after drain) is still running them —
	// duplicate side effects. Main drives resume via a `resumeInterrupted` control
	// op once the old generation's worker is disposed (see GenerationManager).
}

export class WorkflowEntrypointBase {
	ctx: Pick<ExecutionContext, 'waitUntil' | 'tracing'> & { env: unknown }
	env: unknown

	constructor(ctx: unknown, env: unknown) {
		this.env = env
		const executionContext = ctx instanceof ExecutionContext ? ctx : new ExecutionContext()
		this.ctx = { env, waitUntil: executionContext.waitUntil.bind(executionContext), tracing: executionContext.tracing }
	}

	async run(_event: unknown, _step: unknown): Promise<unknown> {
		throw new Error('run() must be implemented by subclass')
	}
}

// --- Instance handle ---

export class SqliteWorkflowInstance {
	private db: Database
	private instanceId: string
	private binding: SqliteWorkflowBinding | null
	private clock: Clock
	private incarnation: string | undefined
	private workflowName: string | undefined

	constructor(db: Database, instanceId: string, binding: SqliteWorkflowBinding | null) {
		this.db = db
		this.instanceId = instanceId
		this.binding = binding
		this.clock = binding?._getClock() ?? realClock
		if (db.query('SELECT id FROM workflow_instances WHERE id = ?').get(instanceId)) {
			const token = new WorkflowStore(db).currentToken(instanceId, binding?._getWorkflowName())
			this.incarnation = token.incarnation
			this.workflowName = token.workflowName
		}
	}

	private currentToken(): WorkflowExecutionToken {
		const token = new WorkflowStore(this.db).currentToken(this.instanceId, this.workflowName)
		if (token.incarnation !== this.incarnation) throw new Error(`Workflow instance ${this.instanceId} no longer exists`)
		return token
	}

	_registryId(): string {
		return registryKey(this.db, this.currentToken())
	}

	get id(): string {
		return this.instanceId
	}

	async status(): Promise<WorkflowInstanceStatus> {
		this.currentToken()
		const row = this.db
			.query('SELECT status, output, error, error_name FROM workflow_instances WHERE id = ?')
			.get(this.instanceId) as { status: string; output: string | null; error: string | null; error_name: string | null } | null

		if (!row) throw new Error(`Workflow instance ${this.instanceId} not found`)

		const rollback = this.db.query<RollbackState, [string]>('SELECT * FROM workflow_rollbacks WHERE instance_id = ?').get(this.instanceId)
		const result: WorkflowInstanceStatus = { status: row.status, rollback: null }
		if (rollback?.phase === 'complete' || rollback?.phase === 'failed') {
			result.rollback = {
				outcome: rollback.phase,
				error: rollback.error === null ? null : { name: rollback.error_name ?? 'Error', message: rollback.error },
			}
		}
		if (row.output !== null) result.output = JSON.parse(row.output)
		if (row.error !== null) result.error = { name: row.error_name ?? 'Error', message: row.error }
		return result
	}

	async pause(): Promise<void> {
		new WorkflowStore(this.db).transaction(this.currentToken(), () =>
			this.db
				.query("UPDATE workflow_instances SET status = 'paused', updated_at = ? WHERE id = ? AND status IN ('running', 'waiting')")
				.run(Date.now(), this.instanceId))
	}

	async resume(): Promise<void> {
		// If workflow was waiting for an event before pause, restore 'waiting' status
		const waiters = eventWaiters.get(this._registryId())
		const newStatus = (waiters && waiters.size > 0) ? 'waiting' : 'running'
		new WorkflowStore(this.db).transaction(this.currentToken(), () =>
			this.db
				.query("UPDATE workflow_instances SET status = ?, updated_at = ? WHERE id = ? AND status = 'paused'")
				.run(newStatus, Date.now(), this.instanceId))
	}

	async terminate(options?: { rollback?: boolean }): Promise<void> {
		const registryId = this._registryId()
		if (options?.rollback) {
			const row = this.db.query<{ status: string }, [string]>('SELECT status FROM workflow_instances WHERE id = ?').get(this.instanceId)
			if (!row || ['complete', 'errored', 'terminated'].includes(row.status)) return
			new WorkflowStore(this.db).transaction(this.currentToken(), () => {
				const inserted = this.db.query(
					"INSERT OR IGNORE INTO workflow_rollbacks (instance_id, phase, target_status) VALUES (?, 'requested', 'terminated')",
				)
					.run(this.instanceId)
				if (inserted.changes > 0) {
					this.db.query(
						"UPDATE workflow_instances SET status = 'running', error = 'workflow terminated', error_name = 'Error', updated_at = ? WHERE id = ?",
					)
						.run(Date.now(), this.instanceId)
				}
			})
			const rollback = this.db.query<RollbackState, [string]>('SELECT * FROM workflow_rollbacks WHERE instance_id = ?').get(this.instanceId)
			if (rollback?.phase === 'requested') abortControllers.get(registryId)?.abort(ROLLBACK_REQUESTED)
			if (!executions.has(registryId)) {
				if (!this.binding) throw new Error('Cannot roll back: instance not associated with a workflow binding')
				this.binding._executeInstance(this.instanceId)
			}
			await executions.get(registryId)
			return
		}
		const store = new WorkflowStore(this.db)
		const token = store.fenceExecution(this.currentToken())
		store.transaction(token, () =>
			this.db
				.query(
					"UPDATE workflow_instances SET status = 'terminated', updated_at = ? WHERE id = ? AND status IN ('running', 'paused', 'waiting', 'queued')",
				)
				.run(Date.now(), this.instanceId))
		// Abort via global registry so get()-retrieved instances also work
		const ac = abortControllers.get(registryId)
		ac?.abort(WORKFLOW_TERMINATED)
		store.cleanupAbandonedStreams(token)
		fireStatusCallbacks(registryId, 'terminated')
	}

	async delete(): Promise<void> {
		validateDeleteId(this.instanceId)
		const token = this.currentToken()
		if (this.binding) return this.binding._deleteInstance(token)
		deleteWorkflowInstance(this.db, token)
		if (isOwnExecution(token)) return new Promise<never>(() => {})
	}

	async restart(options?: WorkflowRestartOptions): Promise<void> {
		if (!this.binding) throw new Error("Cannot restart: instance not associated with a workflow binding. Use the binding's get() method.")
		const registryId = this._registryId()
		const cls = this.binding._getClass()
		const env = this.binding._getEnv()
		const db = this.binding._getDb()
		const workflowName = this.binding._getWorkflowName()
		const limits = this.binding._getLimits()
		if (!cls) throw new Error('Cannot restart: workflow class not wired yet')

		const row = this.db
			.query('SELECT params, created_at FROM workflow_instances WHERE id = ?')
			.get(this.instanceId) as { params: string | null; created_at: number } | null
		if (!row) throw new Error(`Workflow instance ${this.instanceId} not found`)

		const store = new WorkflowStore(db)
		const current = store.currentToken(this.instanceId, workflowName)
		let from = options?.from
		if (!from && options?.fromStep) {
			const matches = store.readDetail(this.instanceId, workflowName).occurrences.filter(row =>
				(row.method === 'do' ? row.key.name : `${row.method}:${row.key.name}`) === options.fromStep
			)
			if (matches.length > 1) throw new Error('Ambiguous fromStep selector; use from with name, type and count')
			from = matches[0]?.key ?? { name: options.fromStep }
		}
		if (from && (!Number.isSafeInteger(from.count ?? 1) || (from.count ?? 1) < 1)) {
			throw new Error('Restart occurrence count must be a positive integer')
		}
		if (
			from && (typeof from.name !== 'string' || (from.type !== undefined && from.type !== 'do' && from.type !== 'sleep' && from.type !== 'waitForEvent'))
		) {
			throw new Error('Restart requires a step name and a valid step type')
		}
		const fromOrder = from ? store.resolveRestartTarget(current, { name: from.name, count: from.count ?? 1, type: from.type ?? 'do' }) : null
		const control = store.fenceExecution(current)
		const existingAc = abortControllers.get(registryId)
		existingAc?.abort()
		await executions.get(registryId)
		while (runningForwardAttempts.get(registryId)?.size) await Promise.allSettled([...runningForwardAttempts.get(registryId)!])
		store.replaceRun(control, fromOrder)

		const abortController = new AbortController()
		abortControllers.set(this._registryId(), abortController)

		const params = row.params !== null ? JSON.parse(row.params) : {}
		SqliteWorkflowBinding.executeWorkflow(
			db,
			this.instanceId,
			cls,
			env,
			params,
			abortController,
			workflowName,
			limits,
			row.created_at,
			this.binding._getClock(),
			this.binding,
		)
	}

	async skipSleep(): Promise<void> {
		for (const resolver of sleepResolvers.get(this._registryId())?.values() ?? []) resolver()
	}

	async sendEvent(event: { type: string; payload?: unknown }): Promise<void> {
		const registryId = this._registryId()
		// Validate event type
		if (!EVENT_TYPE_PATTERN.test(event.type)) {
			throw new Error(`Invalid event type "${event.type}". Must be 1-100 characters, only letters, digits, hyphens and underscores.`)
		}

		new WorkflowStore(this.db).enqueueEvent(
			this.currentToken(),
			event.type,
			event.payload !== undefined ? JSON.stringify(event.payload) : null,
			this.clock.now(),
		)
		for (const waiter of eventWaiters.get(registryId)?.values() ?? []) {
			if (waiter.type === event.type) waiter.wake()
		}
	}
}

// --- Binding ---

export class SqliteWorkflowBinding {
	private readonly traceInvocations = new Set<InvocationTrace>()
	private traceTerminationReason: string | undefined
	private db: Database
	private workflowName: string
	private className: string
	private _class?: new(ctx: unknown, env: unknown) => WorkflowEntrypointBase
	private _env?: unknown
	private counter = 0
	private limits: Required<WorkflowLimits>
	private clock: Clock
	/**
	 * Thread-mode router for dashboard control ops. The real state machine lives
	 * in the worker thread, so when this is set `executeControl` forwards there
	 * instead of running against this (hollow) main-side binding. `null`/unset =
	 * in-process: run locally. Installed by `GenerationManager` on each reload.
	 */
	private _threadRouter?: (op: WorkflowControlOp) => Promise<WorkflowControlResult>

	constructor(db: Database, workflowName: string, className: string, limits?: WorkflowLimits, clock?: Clock) {
		this.db = db
		this.workflowName = workflowName
		this.className = className
		this.limits = { ...WORKFLOW_DEFAULTS, ...limits }
		this.clock = clock ?? realClock
	}

	_setClass(cls: new(ctx: unknown, env: unknown) => WorkflowEntrypointBase, env: unknown) {
		this._class = cls
		this._env = env
	}

	_getClass() {
		return this._class
	}
	_getEnv() {
		return this._env
	}
	_getDb() {
		return this.db
	}
	_getWorkflowName() {
		return this.workflowName
	}
	_getLimits() {
		return this.limits
	}
	_getClock() {
		return this.clock
	}

	terminateTracing(reason: string): void {
		this.traceTerminationReason = reason
		for (const invocation of this.traceInvocations) invocation.terminate(reason)
		this.traceInvocations.clear()
	}

	private trackTracing(invocation: InvocationTrace): void {
		if (this.traceTerminationReason !== undefined) {
			invocation.terminate(this.traceTerminationReason)
			return
		}
		this.traceInvocations.add(invocation)
		void invocation.completed.then(() => this.traceInvocations.delete(invocation))
	}

	/** Abort all running/queued/waiting instances for this workflow */
	abortRunning(): void {
		const rows = this.db.query(
			"SELECT id FROM workflow_instances WHERE workflow_name = ? AND status IN ('running','queued','waiting')",
		).all(this.workflowName) as { id: string }[]
		for (const { id } of rows) {
			abortControllers.get(instanceRegistryKey(this.db, id))?.abort()
		}
	}

	private cleanupRetentionExpired(): void {
		if (this.limits.maxRetentionMs <= 0) return
		const cutoff = this.clock.now() - this.limits.maxRetentionMs
		// Clean up step attempts for instances being deleted
		const expiredIds = this.db
			.query("SELECT id FROM workflow_instances WHERE workflow_name = ? AND status IN ('complete', 'errored') AND updated_at < ?")
			.all(this.workflowName, cutoff) as { id: string }[]
		for (const { id } of expiredIds) {
			new WorkflowStore(this.db).removeOwnedState(id, this.workflowName)
		}
	}

	private countRunning(): number {
		const row = this.db
			.query("SELECT COUNT(*) as cnt FROM workflow_instances WHERE workflow_name = ? AND status IN ('running', 'waiting')")
			.get(this.workflowName) as { cnt: number }
		return row.cnt
	}

	async create(options?: { id?: string; params?: unknown; retention?: string }): Promise<SqliteWorkflowInstance> {
		if (!this._class) throw new Error('Workflow class not wired yet')

		this.cleanupRetentionExpired()

		const id = options?.id ?? `wf-${++this.counter}-${this.clock.now()}`
		if (id.length > this.limits.maxInstanceIdLength) {
			throw new Error(`Workflow instance ID must be ${this.limits.maxInstanceIdLength} characters or fewer, got ${id.length}`)
		}

		// Check for duplicate ID
		const existing = this.db.query('SELECT id FROM workflow_instances WHERE id = ?').get(id)
		if (existing) throw new Error(`Workflow instance with ID "${id}" already exists`)

		const params = options?.params ?? {}
		const now = this.clock.now()

		// Check concurrency
		const isQueued = this.limits.maxConcurrentInstances !== Infinity && this.countRunning() >= this.limits.maxConcurrentInstances
		const initialStatus = isQueued ? 'queued' : 'running'

		this.db
			.query(
				'INSERT INTO workflow_instances (id, workflow_name, class_name, params, status, created_at, updated_at, incarnation, persistence_version) VALUES (?, ?, ?, ?, ?, ?, ?, lower(hex(randomblob(16))), 1)',
			)
			.run(id, this.workflowName, this.className, JSON.stringify(params), initialStatus, now, now)

		const abortController = new AbortController()
		abortControllers.set(instanceRegistryKey(this.db, id), abortController)
		const handle = new SqliteWorkflowInstance(this.db, id, this)

		if (!isQueued) {
			console.log(`[workflow] started ${id}`)
			SqliteWorkflowBinding.executeWorkflow(
				this.db,
				id,
				this._class,
				this._env,
				params,
				abortController,
				this.workflowName,
				this.limits,
				now,
				this.clock,
				this,
			)
		} else {
			console.log(`[workflow] queued ${id} (concurrency limit: ${this.limits.maxConcurrentInstances})`)
		}

		return handle
	}

	/** Create a workflow instance without starting execution. Call _executeInstance() to start it. */
	async _createPrepared(options?: { id?: string; params?: unknown }): Promise<SqliteWorkflowInstance> {
		if (!this._class) throw new Error('Workflow class not wired yet')

		this.cleanupRetentionExpired()

		const id = options?.id ?? `wf-${++this.counter}-${this.clock.now()}`
		if (id.length > this.limits.maxInstanceIdLength) {
			throw new Error(`Workflow instance ID must be ${this.limits.maxInstanceIdLength} characters or fewer, got ${id.length}`)
		}

		const existing = this.db.query('SELECT id FROM workflow_instances WHERE id = ?').get(id)
		if (existing) throw new Error(`Workflow instance with ID "${id}" already exists`)

		const params = options?.params ?? {}
		const now = this.clock.now()

		this.db
			.query(
				'INSERT INTO workflow_instances (id, workflow_name, class_name, params, status, created_at, updated_at, incarnation, persistence_version) VALUES (?, ?, ?, ?, ?, ?, ?, lower(hex(randomblob(16))), 1)',
			)
			.run(id, this.workflowName, this.className, JSON.stringify(params), 'queued', now, now)

		const abortController = new AbortController()
		abortControllers.set(instanceRegistryKey(this.db, id), abortController)

		return new SqliteWorkflowInstance(this.db, id, this)
	}

	/** Start execution of a prepared (queued) workflow instance. */
	_executeInstance(id: string): void {
		if (!this._class) throw new Error('Workflow class not wired yet')
		const store = new WorkflowStore(this.db)
		const token = store.currentToken(id, this.workflowName)
		const registryId = instanceRegistryKey(this.db, id)
		if (executions.has(registryId)) return

		const row = this.db
			.query('SELECT params, created_at FROM workflow_instances WHERE id = ?')
			.get(id) as { params: string | null; created_at: number } | null
		if (!row) throw new Error(`Workflow instance ${id} not found`)

		const params = row.params !== null ? JSON.parse(row.params) : {}

		store.transaction(token, () =>
			this.db
				.query("UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ?")
				.run(this.clock.now(), id))

		let ac = abortControllers.get(registryId)
		if (!ac || ac.signal.aborted) {
			ac = new AbortController()
			abortControllers.set(registryId, ac)
		}

		console.log(`[workflow] started ${id}`)
		SqliteWorkflowBinding.executeWorkflow(
			this.db,
			id,
			this._class,
			this._env,
			params,
			ac,
			this.workflowName,
			this.limits,
			row.created_at,
			this.clock,
			this,
		)
	}

	async createBatch(batch: { id?: string; params?: unknown }[]): Promise<SqliteWorkflowInstance[]> {
		if (batch.length > this.limits.maxBatchSize) {
			throw new Error(`Batch size ${batch.length} exceeds maximum of ${this.limits.maxBatchSize}`)
		}
		const results: SqliteWorkflowInstance[] = []
		for (const item of batch) {
			const instance = await this.create({ id: item.id, params: item.params })
			results.push(instance)
		}
		return results
	}

	async get(id: string): Promise<SqliteWorkflowInstance> {
		new WorkflowStore(this.db).currentToken(id, this.workflowName)
		return new SqliteWorkflowInstance(this.db, id, this)
	}

	async deleteBatch(instanceIds: string[]): Promise<WorkflowBatchDeleteResult> {
		if (!Array.isArray(instanceIds)) throw new Error('Provided argument is invalid (body)')
		const ids = [...instanceIds]
		if (ids.length < 1 || ids.length > 100) {
			throw new Error('deleteBatch requires between 1 and 100 instance IDs (body)')
		}
		for (const id of ids) validateDeleteId(id)
		if (this._threadRouter) {
			const result = await this._threadRouter({ kind: 'deleteBatch', instanceIds: ids })
			if (result.kind !== 'deleteBatch') throw new Error('Unexpected workflow batch deletion result')
			return result.value
		}
		const results = new Map<string, { id: string; code: number; message: string } | null>()
		let deletedSelf = false
		for (const id of new Set(ids)) {
			try {
				const token = new WorkflowStore(this.db).currentToken(id, this.workflowName)
				deleteWorkflowInstance(this.db, token)
				deletedSelf ||= isOwnExecution(token)
				results.set(id, null)
			} catch (error) {
				const missing = error instanceof WorkflowInstanceNotFoundError
				results.set(id, {
					id,
					code: missing ? 10400 : 10001,
					message: missing ? 'workflows.api.error.instance.not_found' : 'workflows.api.error.internal_server',
				})
			}
		}
		this.startQueuedAfterDeletion()
		// Local cooperative contract: finish all unique attempts, including failures, before parking the self-caller.
		if (deletedSelf) return new Promise<never>(() => {})
		const result: WorkflowBatchDeleteResult = { deleted: [], errors: [] }
		for (const id of ids) {
			const error = results.get(id)
			if (error === undefined) throw new Error('Missing batch deletion result')
			if (error) result.errors.push(error)
			else result.deleted.push({ id })
		}
		return result
	}

	async _deleteInstance(token: WorkflowExecutionToken): Promise<void> {
		if (token.workflowName !== this.workflowName) throw new WorkflowInstanceNotFoundError('Workflow instance not found')
		if (this._threadRouter) {
			await this._threadRouter({ kind: 'delete', instanceId: token.instanceId, incarnation: token.incarnation })
			return
		}
		deleteWorkflowInstance(this.db, token)
		this.startQueuedAfterDeletion()
		if (isOwnExecution(token)) return new Promise<never>(() => {})
	}

	private startQueuedAfterDeletion(): void {
		try {
			this.tryStartQueued()
		} catch (error) {
			console.error('[workflow] could not start queued instance after deletion:', error)
		}
	}

	/**
	 * Install the thread-mode router (see {@link _threadRouter}). Called by
	 * `GenerationManager` on each reload so the dashboard's control ops reach the
	 * live worker-side binding. Mirrors the DO namespace's `_setExternalClass`.
	 */
	_setThreadRouter(router: (op: WorkflowControlOp) => Promise<WorkflowControlResult>): void {
		this._threadRouter = router
	}

	/**
	 * Execute a dashboard control operation. In thread mode the real state
	 * machine (abort controllers, event waiters, sleep resolvers, the wired
	 * class) lives in the worker, so when a thread router is installed this
	 * forwards there; otherwise (in-process / worker-side binding) it runs
	 * locally. Mutating ops resolve to `{ kind: 'ok' }`; `create` reports the new
	 * id; the introspection reads report their value.
	 */
	async executeControl(op: WorkflowControlOp): Promise<WorkflowControlResult> {
		if (this._threadRouter) return this._threadRouter(op)
		if (op.incarnation !== undefined && 'instanceId' in op) {
			const token = new WorkflowStore(this.db).currentToken(op.instanceId, this.workflowName)
			if (token.incarnation !== op.incarnation) throw new WorkflowInstanceNotFoundError('Workflow instance no longer exists')
		}
		switch (op.kind) {
			case 'getHandle': {
				const token = new WorkflowStore(this.db).currentToken(op.instanceId, this.workflowName)
				return { kind: 'getHandle', id: token.instanceId, incarnation: token.incarnation }
			}
			case 'delete': {
				validateDeleteId(op.instanceId)
				await (await this.get(op.instanceId)).delete()
				return { kind: 'ok' }
			}
			case 'deleteBatch':
				return { kind: 'deleteBatch', value: await this.deleteBatch(op.instanceIds) }
			case 'create': {
				const instance = await this.create({ id: op.id, params: op.params })
				return { kind: 'create', id: instance.id, incarnation: new WorkflowStore(this.db).currentToken(instance.id, this.workflowName).incarnation }
			}
			case 'status': {
				return { kind: 'status', value: await (await this.get(op.instanceId)).status() }
			}
			case 'resumeInterrupted': {
				this.resumeInterrupted()
				return { kind: 'ok' }
			}
			case 'terminate': {
				await (await this.get(op.instanceId)).terminate({ rollback: 'rollback' in op && op.rollback === true })
				return { kind: 'ok' }
			}
			case 'pause': {
				await (await this.get(op.instanceId)).pause()
				return { kind: 'ok' }
			}
			case 'resume': {
				await (await this.get(op.instanceId)).resume()
				return { kind: 'ok' }
			}
			case 'restart': {
				await (await this.get(op.instanceId)).restart({ from: op.from, fromStep: op.fromStep })
				return { kind: 'ok' }
			}
			case 'skipSleep': {
				await (await this.get(op.instanceId)).skipSleep()
				return { kind: 'ok' }
			}
			case 'sendEvent': {
				await (await this.get(op.instanceId)).sendEvent({ type: op.eventType, payload: op.payload })
				return { kind: 'ok' }
			}
			case 'isSleeping':
				return { kind: 'isSleeping', value: isInstanceSleeping((await this.get(op.instanceId))._registryId()) }
			case 'waitingEventTypes':
				return { kind: 'waitingEventTypes', value: getWaitingEventTypes((await this.get(op.instanceId))._registryId()) }
		}
	}

	/** Resume any workflow instances that were running/waiting when the process last exited. */
	resumeInterrupted(): void {
		if (!this._class) return
		new WorkflowStore(this.db).cleanupTerminalStreams(this.workflowName)

		const rows = this.db
			.query("SELECT id, params, created_at FROM workflow_instances WHERE workflow_name = ? AND status IN ('running', 'waiting')")
			.all(this.workflowName) as { id: string; params: string | null; created_at: number }[]

		for (const row of rows) {
			const registryId = instanceRegistryKey(this.db, row.id)
			if (executions.has(registryId)) continue
			const abortController = new AbortController()
			abortControllers.set(registryId, abortController)
			const params = row.params !== null ? JSON.parse(row.params) : {}
			console.log(`[workflow] resuming interrupted instance ${row.id}`)
			// Reset to running before re-executing (waiting status needs to restart from last checkpoint)
			const store = new WorkflowStore(this.db)
			store.transaction(store.currentToken(row.id, this.workflowName), () =>
				this.db
					.query("UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ?")
					.run(this.clock.now(), row.id))
			SqliteWorkflowBinding.executeWorkflow(
				this.db,
				row.id,
				this._class,
				this._env,
				params,
				abortController,
				this.workflowName,
				this.limits,
				row.created_at,
				this.clock,
				this,
			)
		}
	}

	/** Try to start any queued instances for this workflow (called after an instance completes). */
	private tryStartQueued(): void {
		if (this.limits.maxConcurrentInstances === Infinity) return
		if (!this._class) return

		while (this.countRunning() < this.limits.maxConcurrentInstances) {
			const queued = this.db
				.query("SELECT id, params, created_at FROM workflow_instances WHERE workflow_name = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1")
				.get(this.workflowName) as { id: string; params: string | null; created_at: number } | null
			if (!queued) break

			const store = new WorkflowStore(this.db)
			store.transaction(store.currentToken(queued.id, this.workflowName), () =>
				this.db
					.query("UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ?")
					.run(this.clock.now(), queued.id))

			const abortController = new AbortController()
			abortControllers.set(instanceRegistryKey(this.db, queued.id), abortController)
			const params = queued.params !== null ? JSON.parse(queued.params) : {}
			console.log(`[workflow] starting queued instance ${queued.id}`)
			SqliteWorkflowBinding.executeWorkflow(
				this.db,
				queued.id,
				this._class,
				this._env,
				params,
				abortController,
				this.workflowName,
				this.limits,
				queued.created_at,
				this.clock,
				this,
			)
		}
	}

	static executeWorkflow(
		db: Database,
		id: string,
		workflowClass: new(ctx: unknown, env: unknown) => WorkflowEntrypointBase,
		env: unknown,
		params: unknown,
		abortController: AbortController,
		workflowName?: string,
		limits?: Required<WorkflowLimits>,
		createdAt?: number,
		clock?: Clock,
		traceOwner?: SqliteWorkflowBinding,
	): void {
		const store = new WorkflowStore(db)
		const initialToken = store.currentToken(id, workflowName)
		const registryId = registryKey(db, initialToken)
		const resolvedLimits = limits ?? WORKFLOW_DEFAULTS
		const resolvedClock = clock ?? realClock
		let activeController = abortController
		const startQueued = () => {
			if (!workflowName) return
			const running = db.query<{ count: number }, [string]>(
				"SELECT COUNT(*) AS count FROM workflow_instances WHERE workflow_name = ? AND status IN ('running', 'waiting')",
			).get(workflowName)
			if (running && running.count >= resolvedLimits.maxConcurrentInstances) return
			const queued = db.query<{ id: string; params: string | null; created_at: number }, [string]>(
				"SELECT id, params, created_at FROM workflow_instances WHERE workflow_name = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1",
			).get(workflowName)
			if (!queued) return
			store.transaction(
				store.currentToken(queued.id, workflowName),
				() => db.query("UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ?").run(resolvedClock.now(), queued.id),
			)
			const params = queued.params !== null ? JSON.parse(queued.params) : {}
			const controller = new AbortController()
			abortControllers.set(instanceRegistryKey(db, queued.id), controller)
			SqliteWorkflowBinding.executeWorkflow(
				db,
				queued.id,
				workflowClass,
				env,
				params,
				controller,
				workflowName,
				resolvedLimits,
				queued.created_at,
				resolvedClock,
				traceOwner,
			)
		}
		const execution = (async () => {
			await Promise.resolve()
			if (abortController.signal.aborted && abortController.signal.reason !== ROLLBACK_REQUESTED) {
				if (abortControllers.get(registryId) === abortController) abortControllers.delete(registryId)
				if (abortController.signal.reason === WORKFLOW_TERMINATED || abortController.signal.reason === WORKFLOW_DELETED) startQueued()
				return
			}
			try {
				while (runningForwardAttempts.get(registryId)?.size) {
					await runWithTimeout(
						async () => {
							await Promise.allSettled([...runningForwardAttempts.get(registryId) ?? []])
						},
						undefined,
						'Forward attempts',
						abortController.signal,
					)
				}
			} catch (error) {
				if (!abortController.signal.aborted) throw error
				if (abortController.signal.reason === WORKFLOW_DELETED) startQueued()
				return
			}
			if (abortController.signal.aborted && abortController.signal.reason !== ROLLBACK_REQUESTED) return
			const token = store.transaction(initialToken, () => store.acquireExecution(id, initialToken.workflowName))
			const invocation = createInvocationTrace({
				name: `workflow ${workflowName ?? 'run'}`,
				kind: 'server',
				attributes: { 'workflow.name': workflowName ?? 'unknown', 'workflow.instance_id': id },
				workerName: workflowName,
				newTrace: true,
			})
			traceOwner?.trackTracing(invocation)
			let completion: TraceCompletion = { kind: 'complete' }
			try {
				await invocation.run(() => {
					const ctx = new ExecutionContext()
					return runWithExecutionContext(ctx, async () => {
						const workflowTraceId = getActiveContext()?.traceId
						let step: WorkflowStepImpl | undefined
						const initialRollback = db.query<RollbackState, [string]>('SELECT * FROM workflow_rollbacks WHERE instance_id = ?').get(id)
						if (initialRollback?.target_status === 'terminated') completion = { kind: 'cancelled', reason: WORKFLOW_TERMINATED }
						if (initialRollback?.phase === 'requested' && activeController.signal.aborted) {
							activeController = new AbortController()
							abortControllers.set(registryId, activeController)
						}
						// Rollback termination drains forward steps; reload and default termination abort them.
						const forwardController = new AbortController()
						const onControlAbort = () => {
							if (activeController.signal.reason === WORKFLOW_DELETED) invocation.terminate(WORKFLOW_DELETED)
							if (completion.kind !== 'error') {
								completion = {
									kind: 'cancelled',
									reason: activeController.signal.reason === WORKFLOW_TERMINATED || activeController.signal.reason === ROLLBACK_REQUESTED
										? WORKFLOW_TERMINATED
										: 'Workflow interrupted',
								}
							}
							if (activeController.signal.reason === ROLLBACK_REQUESTED) {
								activeController = new AbortController()
								abortControllers.set(registryId, activeController)
								activeController.signal.addEventListener('abort', onControlAbort, { once: true })
							} else {
								forwardController.abort(activeController.signal.reason)
							}
						}
						activeController.signal.addEventListener('abort', onControlAbort, { once: true })
						const finishRollback = async (error: Error, state: RollbackState): Promise<void> => {
							if (state.target_status === 'errored') completion = { kind: 'error', error }
							if (!step) throw new Error('Workflow step handlers could not be recovered')
							if (activeController.signal.aborted) return
							store.transaction(token, () => {
								db.query("UPDATE workflow_rollbacks SET phase = 'running' WHERE instance_id = ?").run(id)
								db.query("UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ?").run(resolvedClock.now(), id)
							})
							let failure: Error | undefined
							try {
								await step.rollback(error, activeController.signal)
							} catch (err) {
								if (activeController.signal.aborted) return
								failure = workflowError(err)
								addSpanEvent('exception', 'error', failure.message, { 'exception.type': failure.name, 'exception.stacktrace': failure.stack })
								if (completion.kind !== 'error') completion = { kind: 'error', error: failure }
							}
							if (activeController.signal.aborted) return
							setSpanAttribute('workflow.rollback.outcome', failure ? 'failed' : 'complete')
							store.transaction(token, () => {
								db.query('UPDATE workflow_rollbacks SET phase = ?, error = ?, error_name = ? WHERE instance_id = ?')
									.run(failure ? 'failed' : 'complete', failure?.message ?? null, failure?.name ?? null, id)
								db.query('UPDATE workflow_instances SET status = ?, updated_at = ? WHERE id = ?').run(state.target_status, resolvedClock.now(), id)
							})
							fireStatusCallbacks(registryId, state.target_status)
						}
						try {
							step = new WorkflowStepImpl(forwardController.signal, db, id, resolvedLimits, resolvedClock, token)
							const instance = new workflowClass(ctx, env)
							const event = { payload: params, timestamp: new Date(createdAt ?? resolvedClock.now()), instanceId: id }
							const result = await runWithTimeout(
								() => workflowExecution.run(token, () => instance.run(event, step)),
								undefined,
								'Workflow',
								activeController.signal,
							)
							await step.settlePending()
							if (activeController.signal.aborted) return
							const rollback = db.query<RollbackState, [string]>('SELECT * FROM workflow_rollbacks WHERE instance_id = ?').get(id)
							if (rollback?.phase === 'running' || rollback?.phase === 'requested') {
								const original = db.query<{ error: string | null; error_name: string | null }, [string]>(
									'SELECT error, error_name FROM workflow_instances WHERE id = ?',
								).get(id)
								await step.settleForwardAttempts()
								await finishRollback(restoredError(original?.error ?? null, original?.error_name ?? null, rollback.original_non_retryable === 1), rollback)
								return
							}
							store.transaction(token, () =>
								db.query("UPDATE workflow_instances SET status = 'complete', output = ?, updated_at = ? WHERE id = ?")
									.run(JSON.stringify(result), resolvedClock.now(), id))
							console.log(`[workflow] completed ${id}:`, result)
							fireStatusCallbacks(registryId, 'complete')
						} catch (err) {
							if (completion.kind !== 'cancelled') completion = { kind: 'error', error: err }
							await step?.settlePending()
							if (activeController.signal.aborted) return
							store.assertCurrent(token)
							const rollback = db.query<RollbackState, [string]>('SELECT * FROM workflow_rollbacks WHERE instance_id = ?').get(id)
							if (rollback?.phase === 'running' || rollback?.phase === 'requested') {
								const original = db.query<{ error: string | null; error_name: string | null }, [string]>(
									'SELECT error, error_name FROM workflow_instances WHERE id = ?',
								).get(id)
								await step?.settleForwardAttempts()
								await finishRollback(restoredError(original?.error ?? null, original?.error_name ?? null, rollback.original_non_retryable === 1), rollback)
								return
							}
							let failure = workflowError(err)
							let eligible: WorkflowOccurrenceRecord[] = []
							try {
								eligible = step ? store.listRollbackOccurrences(step.token) : []
							} catch (storageError) {
								const storageFailure = workflowError(storageError)
								failure = new AggregateError(
									[failure, storageFailure],
									`Workflow "${id}" cannot recover compensation safely. Original failure: ${failure.name}: ${failure.message}. Storage failure: ${storageFailure.name}: ${storageFailure.message}`,
								)
								failure.name = 'WorkflowRecoveryError'
							}
							const errorName = failure.name || 'Error'
							const message = failure.message
							completion = { kind: 'error', error: failure }
							if (step && eligible.length > 0) {
								store.transaction(token, () => {
									db.query("UPDATE workflow_instances SET status = 'running', error = ?, error_name = ?, updated_at = ? WHERE id = ?")
										.run(message, errorName, resolvedClock.now(), id)
									db.query("INSERT INTO workflow_rollbacks (instance_id, phase, target_status, original_non_retryable) VALUES (?, 'running', 'errored', ?)")
										.run(id, err instanceof NonRetryableError ? 1 : 0)
								})
								persistError(err, 'workflow', workflowName, workflowTraceId)
								await step.settleForwardAttempts()
								await finishRollback(workflowError(err), {
									phase: 'running',
									target_status: 'errored',
									original_non_retryable: err instanceof NonRetryableError ? 1 : 0,
									error: null,
									error_name: null,
								})
								return
							}
							store.transaction(
								token,
								() =>
									db.query("UPDATE workflow_instances SET status = 'errored', error = ?, error_name = ?, updated_at = ? WHERE id = ?")
										.run(message, errorName, resolvedClock.now(), id),
							)
							console.error(`[workflow] failed ${id}:`, failure)
							persistError(failure, 'workflow', workflowName, workflowTraceId)
							fireStatusCallbacks(registryId, 'errored')
						} finally {
							activeController.signal.removeEventListener('abort', onControlAbort)
							forwardController.abort()
							if (abortControllers.get(registryId) === activeController) {
								eventWaiters.delete(registryId)
								abortControllers.delete(registryId)
							}
							if (
								!activeController.signal.aborted || activeController.signal.reason === WORKFLOW_TERMINATED
								|| activeController.signal.reason === WORKFLOW_DELETED
							) startQueued()
						}
					})
				})
			} catch (error) {
				completion = { kind: 'error', error }
				throw error
			} finally {
				invocation.finishHandler(completion)
			}
		})()
		executions.set(registryId, execution)
		execution.finally(() => {
			if (executions.get(registryId) === execution) executions.delete(registryId)
		}).catch(err => console.error(`[workflow] execution interrupted ${id}:`, err))
	}
}
