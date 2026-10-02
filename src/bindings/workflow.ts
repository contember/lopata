import type { Database } from 'bun:sqlite'
import type { Clock } from '../testing/clock'
import { realClock } from '../testing/clock'
import { getActiveContext } from '../tracing/context'
import { addSpanEvent, persistError, startSpan } from '../tracing/span'
import type { WorkflowControlOp, WorkflowControlResult } from '../worker-thread/protocol'

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

interface StepHistory {
	step_name: string
	state: string
	attempt: number
	error: string | null
	error_name: string | null
	non_retryable: number
	rollback_state: string | null
	rollback_attempts: number
	rollback_error: string | null
	rollback_error_name: string | null
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

function decodeStepOutput<T>(serialized: string | null): T {
	return JSON.parse(serialized ?? 'null', (_key: string, value: unknown) => serialized === null ? undefined : value)
}

// --- Event waiting registry (in-memory, per-process) ---

type EventResolver = (payload: unknown) => void
const eventWaiters = new Map<string, Map<string, EventResolver>>()

function getWaitersForInstance(instanceId: string): Map<string, EventResolver> {
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
// Soft reload stops the engine, not user callbacks; replay must drain still-live attempts.
const runningForwardAttempts = new Map<string, Set<Promise<unknown>>>()
const ROLLBACK_REQUESTED = 'workflow rollback requested'
const WORKFLOW_TERMINATED = 'workflow terminated'

// --- Sleep skip registry (per-process) ---
// Allows skipSleep() to resolve the active sleep/sleepUntil delay immediately

const sleepResolvers = new Map<string, () => void>()

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

export function registerStepMock(instanceId: string, stepName: string, mock: StepMock): void {
	let instanceMocks = stepMocks.get(instanceId)
	if (!instanceMocks) {
		instanceMocks = new Map()
		stepMocks.set(instanceId, instanceMocks)
	}
	instanceMocks.set(stepName, { ...mock, _used: 0 })
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
	private knownStepNames = new Set<string>()
	private limits: Required<WorkflowLimits>
	private clock: Clock
	private replayRollback: boolean
	private pending = new Set<Promise<unknown>>()
	private forwardAttempts = new Set<Promise<unknown>>()
	private rollbacks = new Map<string, (error: Error, signal: AbortSignal) => Promise<void>>()
	private closed = false

	constructor(abortSignal: AbortSignal, db: Database, instanceId: string, limits: Required<WorkflowLimits>, clock?: Clock) {
		this.abortSignal = abortSignal
		this.db = db
		this.instanceId = instanceId
		this.limits = limits
		this.clock = clock ?? realClock
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

	private checkDuplicateStepName(name: string): void {
		if (this.knownStepNames.has(name)) {
			throw new Error(`Duplicate step name "${name}". Step names must be unique within a workflow execution.`)
		}
		this.knownStepNames.add(name)
	}

	private getCachedStep(name: string): { output: string | null } | null {
		return this.db
			.query('SELECT output FROM workflow_steps WHERE instance_id = ? AND step_name = ?')
			.get(this.instanceId, name) as { output: string | null } | null
	}

	private cacheStep(name: string, output: unknown): void {
		const serialized = JSON.stringify(output)
		if (serialized !== undefined && serialized.length > this.limits.maxStepOutputBytes) {
			throw new Error(`Step "${name}" output exceeds maximum size of 1 MiB`)
		}
		this.db
			.query('INSERT OR REPLACE INTO workflow_steps (instance_id, step_name, output, completed_at) VALUES (?, ?, ?, ?)')
			.run(this.instanceId, name, serialized ?? null, this.clock.now())
		fireStepCallbacks(this.instanceId, name, output)
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
		const promise = this.executeDo(name, config, callback, options).catch(err => {
			if (!this.abortSignal.aborted && !this.replayRollback) this.recordForwardFailure(name, workflowError(err))
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
		await this.waitForPromises(runningForwardAttempts.get(this.instanceId) ?? this.forwardAttempts, 'Forward attempts')
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
		const attempt = Promise.resolve().then(callback)
		const attempts = runningForwardAttempts.get(this.instanceId) ?? this.forwardAttempts
		this.forwardAttempts = attempts
		runningForwardAttempts.set(this.instanceId, attempts)
		attempts.add(attempt)
		const settled = () => {
			attempts.delete(attempt)
			if (attempts.size === 0 && runningForwardAttempts.get(this.instanceId) === attempts) runningForwardAttempts.delete(this.instanceId)
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
		name: string,
		config: WorkflowStepConfig | undefined,
		callback: (ctx: WorkflowStepContext) => Promise<T>,
		options?: WorkflowStepRollbackOptions<T>,
	): Promise<T> {
		if (name.length > this.limits.maxStepNameLength) {
			throw new Error(`Step name must be ${this.limits.maxStepNameLength} characters or fewer, got ${name.length}`)
		}
		await this.checkPaused()
		if (this.abortSignal.aborted) throw new Error('workflow terminated')
		this.checkStepLimit()
		this.checkDuplicateStepName(name)

		const resolvedConfig = this.resolveConfig(config)
		const previous = this.db.query<StepHistory, [string, string]>(
			'SELECT * FROM workflow_step_history WHERE instance_id = ? AND step_name = ?',
		).get(this.instanceId, name)
		if (!this.replayRollback) {
			this.db.query(
				'INSERT OR IGNORE INTO workflow_step_history (instance_id, step_name, rollback_registered) VALUES (?, ?, ?)',
			).run(this.instanceId, name, options ? 1 : 0)
		}
		if (options && (!this.replayRollback || previous)) {
			this.rollbacks.set(name, async (error, signal) => {
				const history = this.db.query<StepHistory, [string, string]>(
					'SELECT * FROM workflow_step_history WHERE instance_id = ? AND step_name = ?',
				).get(this.instanceId, name)
				if (!history) throw new Error(`Missing step history for "${name}"`)
				const cached = this.getCachedStep(name)
				const output = cached ? decodeStepOutput<T>(cached.output) : undefined
				await this.runRollback(name, history, options.rollbackConfig, signal, async () => {
					await options.rollback({ ctx: { step: { name, count: 1 }, attempt: history.attempt, config: resolvedConfig }, error, output })
				})
			})
		}

		// Check checkpoint
		const cached = this.getCachedStep(name)
		if (cached) {
			console.log(`  [workflow] step: ${name} (cached)`)
			this.db.query("UPDATE workflow_step_history SET state = 'completed' WHERE instance_id = ? AND step_name = ?").run(this.instanceId, name)
			return decodeStepOutput<T>(cached.output)
		}
		if (previous?.state === 'failed' || this.replayRollback) {
			throw restoredError(previous?.error ?? null, previous?.error_name ?? null, previous?.non_retryable === 1)
		}

		// Check step mocks
		const instanceMocks = stepMocks.get(this.instanceId)
		const mock = instanceMocks?.get(name)
		if (mock) {
			const shouldApply = mock.times === undefined || (mock._used ?? 0) < mock.times
			if (shouldApply) {
				mock._used = (mock._used ?? 0) + 1
				if (mock.type === 'result') {
					console.log(`  [workflow] step: ${name} (mocked)`)
					this.cacheStep(name, mock.value)
					this.db.query("UPDATE workflow_step_history SET state = 'completed' WHERE instance_id = ? AND step_name = ?").run(this.instanceId, name)
					return mock.value as T
				}
				if (mock.type === 'error') {
					console.log(`  [workflow] step: ${name} (mocked error)`)
					this.recordForwardFailure(name, workflowError(mock.value))
					throw mock.value
				}
				if (mock.type === 'timeout') {
					console.log(`  [workflow] step: ${name} (mocked timeout)`)
					const error = new Error(`Step "${name}" timed out (mocked)`)
					this.recordForwardFailure(name, error)
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
			const attemptRow = this.db
				.query<{ failed_attempts: number; last_error: string | null; last_error_name: string | null }, [string, string]>(
					'SELECT failed_attempts, last_error, last_error_name FROM workflow_step_attempts WHERE instance_id = ? AND step_name = ?',
				)
				.get(this.instanceId, name)
			const startAttempt = attemptRow?.failed_attempts ?? 0

			let lastError: unknown = restoredError(attemptRow?.last_error ?? null, attemptRow?.last_error_name ?? null)
			for (let attempt = startAttempt; attempt <= maxRetries; attempt++) {
				if (this.abortSignal.aborted) throw new Error('workflow terminated')
				const ctx: WorkflowStepContext = { step: { name, count: 1 }, attempt: attempt + 1, config: resolvedConfig }
				this.db.query('UPDATE workflow_step_history SET attempt = ? WHERE instance_id = ? AND step_name = ?').run(attempt + 1, this.instanceId, name)
				try {
					const result = await runWithTimeout(() => this.startForwardAttempt(() => callback(ctx)), timeoutMs, `Step "${name}"`, this.abortSignal)
					if (this.abortSignal.aborted) throw new Error('workflow terminated')
					this.cacheStep(name, result)
					this.db.query("UPDATE workflow_step_history SET state = 'completed' WHERE instance_id = ? AND step_name = ?").run(this.instanceId, name)
					// Clean up attempt counter on success
					this.db.query('DELETE FROM workflow_step_attempts WHERE instance_id = ? AND step_name = ?')
						.run(this.instanceId, name)
					return result
				} catch (err) {
					if (this.abortSignal.aborted) throw err
					if (err instanceof NonRetryableError) {
						this.recordForwardFailure(name, err)
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
					this.db.query(
						'INSERT OR REPLACE INTO workflow_step_attempts (instance_id, step_name, failed_attempts, last_error, last_error_name, last_error_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
					)
						.run(this.instanceId, name, attempt + 1, errMsg, errName, errorId, this.clock.now())
					if (attempt < maxRetries) {
						await this.retryDelay(resolvedConfig, ctx, workflowError(err), this.abortSignal)
					}
				}
			}
			this.recordForwardFailure(name, workflowError(lastError))
			throw lastError
		})
	}

	private recordForwardFailure(name: string, error: Error): void {
		this.db.query('UPDATE workflow_step_history SET state = ?, error = ?, error_name = ?, non_retryable = ? WHERE instance_id = ? AND step_name = ?')
			.run('failed', error.message, error.name, error instanceof NonRetryableError ? 1 : 0, this.instanceId, name)
	}

	private async runRollback(
		name: string,
		history: StepHistory,
		config: WorkflowStepConfig | undefined,
		signal: AbortSignal,
		callback: () => Promise<void>,
	): Promise<void> {
		const resolved = this.resolveConfig(config)
		const maxRetries = resolved.retries?.limit ?? this.limits.defaultRetryLimit
		const timeout = parseDuration(resolved.timeout ?? this.limits.defaultStepTimeoutMs)
		if (timeout > this.limits.maxStepDoTimeoutMs) throw new Error(`Step timeout ${timeout}ms exceeds maximum of ${this.limits.maxStepDoTimeoutMs}ms`)
		let error = restoredError(history.rollback_error, history.rollback_error_name)
		for (let attempt = history.rollback_attempts; attempt <= maxRetries; attempt++) {
			if (signal.aborted) throw new Error('workflow terminated')
			this.db.query("UPDATE workflow_step_history SET rollback_state = 'running' WHERE instance_id = ? AND step_name = ?").run(this.instanceId, name)
			try {
				await runWithTimeout(callback, timeout, `Rollback "${name}"`, signal)
				if (signal.aborted) throw new Error('workflow terminated')
				this.db.query("UPDATE workflow_step_history SET rollback_state = 'complete' WHERE instance_id = ? AND step_name = ?").run(this.instanceId, name)
				return
			} catch (err) {
				if (signal.aborted) throw err
				error = workflowError(err)
				this.db.query(
					'UPDATE workflow_step_history SET rollback_attempts = ?, rollback_error = ?, rollback_error_name = ? WHERE instance_id = ? AND step_name = ?',
				)
					.run(attempt + 1, error.message, error.name, this.instanceId, name)
				if (err instanceof NonRetryableError) break
				if (attempt < maxRetries) await this.retryDelay(resolved, { step: { name, count: 1 }, attempt: attempt + 1, config: resolved }, error, signal)
			}
		}
		this.db.query("UPDATE workflow_step_history SET rollback_state = 'failed' WHERE instance_id = ? AND step_name = ?").run(this.instanceId, name)
		throw error
	}

	async rollback(error: Error, signal: AbortSignal): Promise<void> {
		const eligible = this.db.query<StepHistory, [string]>(
			'SELECT * FROM workflow_step_history WHERE instance_id = ? AND rollback_registered = 1 ORDER BY start_order DESC',
		).all(this.instanceId)
		for (const history of eligible) {
			if (signal.aborted) throw new Error('workflow terminated')
			if (history.rollback_state === 'complete') continue
			if (history.rollback_state === 'failed') throw restoredError(history.rollback_error, history.rollback_error_name)
			const handler = this.rollbacks.get(history.step_name)
			if (!handler) throw new Error(`Rollback handler for step "${history.step_name}" was not recovered during replay`)
			await handler(error, signal)
		}
	}

	async sleep(name: string, duration: string | number) {
		await this.checkPaused()
		if (this.replayRollback) return
		if (this.abortSignal.aborted) throw new Error('workflow terminated')
		this.checkDuplicateStepName(`sleep:${name}`)

		// Check if sleeps are disabled for this instance
		if (sleepDisabledInstances.has(this.instanceId)) {
			console.log(`  [workflow] sleep: ${name} (disabled)`)
			this.cacheStep(`sleep:${name}`, { until: this.clock.now() })
			return
		}

		console.log(`  [workflow] sleep: ${name}`)
		return startSpan({
			name: `sleep ${name}`,
			kind: 'internal',
			attributes: { 'workflow.step.name': name, 'workflow.step.type': 'sleep', 'workflow.instance_id': this.instanceId },
		}, async () => {
			const cached = this.getCachedStep(`sleep:${name}`)
			if (cached) {
				const { until } = JSON.parse(cached.output!) as { until: number }
				const remaining = Math.max(0, until - this.clock.now())
				if (remaining > 0) {
					await skippableDelay(remaining, this.abortSignal, this.instanceId)
				}
				return
			}

			const ms = typeof duration === 'number' ? duration : parseDuration(duration)
			if (ms > this.limits.maxSleepMs) {
				throw new Error(`Sleep duration ${ms}ms exceeds maximum of ${this.limits.maxSleepMs}ms`)
			}
			const until = this.clock.now() + ms
			this.cacheStep(`sleep:${name}`, { until })

			if (ms > 0) {
				await skippableDelay(ms, this.abortSignal, this.instanceId)
			}
		})
	}

	async sleepUntil(name: string, timestamp: Date | number) {
		await this.checkPaused()
		if (this.replayRollback) return
		if (this.abortSignal.aborted) throw new Error('workflow terminated')
		this.checkDuplicateStepName(`sleepUntil:${name}`)

		// Check if sleeps are disabled for this instance
		if (sleepDisabledInstances.has(this.instanceId)) {
			console.log(`  [workflow] sleepUntil: ${name} (disabled)`)
			const ts = typeof timestamp === 'number' ? new Date(timestamp) : timestamp
			this.cacheStep(`sleepUntil:${name}`, { until: ts.toISOString() })
			return
		}

		const ts = typeof timestamp === 'number' ? new Date(timestamp) : timestamp

		console.log(`  [workflow] sleepUntil: ${name}`)
		return startSpan({
			name: `sleepUntil ${name}`,
			kind: 'internal',
			attributes: { 'workflow.step.name': name, 'workflow.step.type': 'sleepUntil', 'workflow.instance_id': this.instanceId },
		}, async () => {
			const cached = this.getCachedStep(`sleepUntil:${name}`)
			if (cached) {
				const remaining = Math.max(0, ts.getTime() - this.clock.now())
				if (remaining > 0) {
					await skippableDelay(remaining, this.abortSignal, this.instanceId)
				}
				return
			}

			const delay = Math.max(0, ts.getTime() - this.clock.now())
			if (delay > this.limits.maxSleepMs) {
				throw new Error(`Sleep duration ${delay}ms exceeds maximum of ${this.limits.maxSleepMs}ms`)
			}

			this.cacheStep(`sleepUntil:${name}`, { until: ts.toISOString() })

			if (delay > 0) {
				await skippableDelay(delay, this.abortSignal, this.instanceId)
			}
		})
	}

	async waitForEvent<T = unknown>(name: string, options: { type: string; timeout?: string }): Promise<{ payload: T; timestamp: Date; type: string }> {
		await this.checkPaused()
		if (this.abortSignal.aborted) throw new Error('workflow terminated')
		this.checkStepLimit()
		this.checkDuplicateStepName(`waitForEvent:${name}`)
		if (this.replayRollback && !this.getCachedStep(`waitForEvent:${name}`)) throw new Error('workflow terminated')

		// Validate event type
		if (!EVENT_TYPE_PATTERN.test(options.type)) {
			throw new Error(`Invalid event type "${options.type}". Must be 1-100 characters, only letters, digits, hyphens and underscores.`)
		}

		// Check event timeout mocks
		const timeoutMocks = eventTimeoutMocks.get(this.instanceId)
		if (timeoutMocks?.has(options.type)) {
			console.log(`  [workflow] waitForEvent: ${name} (mocked timeout)`)
			throw new Error(`waitForEvent timed out (mocked)`)
		}

		// Check event mocks — pre-insert into DB so existing flow picks them up
		const instanceEventMocks = eventMocks.get(this.instanceId)
		const eventMock = instanceEventMocks?.get(options.type)
		if (eventMock) {
			instanceEventMocks!.delete(options.type)
			this.db
				.query('INSERT INTO workflow_events (instance_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)')
				.run(this.instanceId, options.type, eventMock.payload !== undefined ? JSON.stringify(eventMock.payload) : null, this.clock.now())
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
			const cached = this.getCachedStep(`waitForEvent:${name}`)
			if (cached) {
				const parsed = JSON.parse(cached.output!) as { payload: T; timestamp: string; type: string }
				return { payload: parsed.payload, timestamp: new Date(parsed.timestamp), type: parsed.type }
			}

			// Update status to waiting
			this.db
				.query("UPDATE workflow_instances SET status = 'waiting', updated_at = ? WHERE id = ?")
				.run(this.clock.now(), this.instanceId)

			// Check if event already exists in DB
			const existing = this.db
				.query('SELECT payload, created_at FROM workflow_events WHERE instance_id = ? AND event_type = ? ORDER BY id ASC LIMIT 1')
				.get(this.instanceId, options.type) as { payload: string | null; created_at: number } | null

			if (existing) {
				this.db
					.query('DELETE FROM workflow_events WHERE instance_id = ? AND event_type = ? ORDER BY id ASC LIMIT 1')
					.run(this.instanceId, options.type)
				this.db
					.query("UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ?")
					.run(this.clock.now(), this.instanceId)
				const payload = (existing.payload !== null ? JSON.parse(existing.payload) : undefined) as T
				const event = { payload, timestamp: new Date(existing.created_at), type: options.type }
				this.cacheStep(`waitForEvent:${name}`, event)
				return event
			}

			// Wait for event to arrive via sendEvent()
			const timeoutMs = options.timeout ? parseDuration(options.timeout) : this.limits.defaultWaitForEventTimeoutMs
			if (timeoutMs < this.limits.minWaitForEventTimeoutMs) {
				throw new Error(`waitForEvent timeout ${timeoutMs}ms is below minimum of ${this.limits.minWaitForEventTimeoutMs}ms`)
			}
			if (timeoutMs > this.limits.maxWaitForEventTimeoutMs) {
				throw new Error(`waitForEvent timeout ${timeoutMs}ms exceeds maximum of ${this.limits.maxWaitForEventTimeoutMs}ms`)
			}

			const result = await new Promise<{ payload: T; timestamp: Date; type: string }>((resolve, reject) => {
				const waiters = getWaitersForInstance(this.instanceId)
				let timer: ReturnType<typeof setTimeout> | undefined
				let abortHandler: (() => void) | undefined

				const cleanup = () => {
					waiters.delete(options.type)
					if (timer) clearTimeout(timer)
					if (abortHandler) this.abortSignal.removeEventListener('abort', abortHandler)
				}

				waiters.set(options.type, (payload: unknown) => {
					cleanup()
					resolve({ payload: payload as T, timestamp: new Date(), type: options.type })
				})

				timer = setTimeout(() => {
					cleanup()
					reject(new Error(`waitForEvent timed out after ${options.timeout ?? '24 hours'}`))
				}, timeoutMs)

				abortHandler = () => {
					cleanup()
					reject(new Error('workflow terminated'))
				}
				this.abortSignal.addEventListener('abort', abortHandler)
				fireEventWaitCallbacks(this.instanceId, options.type)
			})

			// Restore running status
			this.db
				.query("UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ?")
				.run(this.clock.now(), this.instanceId)

			this.cacheStep(`waitForEvent:${name}`, result)
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
	let timer: ReturnType<typeof setTimeout> | undefined
	let onAbort: (() => void) | undefined
	try {
		return await Promise.race([
			Promise.resolve().then(callback),
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
function skippableDelay(ms: number, abortSignal: AbortSignal, instanceId: string): Promise<void> {
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
			sleepResolvers.delete(instanceId)
		}
		sleepResolvers.set(instanceId, () => {
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
	return Array.from(waiters.keys())
}

/** Check if an instance is currently sleeping (has a registered sleep resolver). */
export function isInstanceSleeping(instanceId: string): boolean {
	return sleepResolvers.has(instanceId)
}

// --- Notification hook registration (for testing) ---

function fireStepCallbacks(instanceId: string, stepName: string, output: unknown): void {
	const instanceCbs = stepCallbacks.get(instanceId)
	if (!instanceCbs) return
	const cbs = instanceCbs.get(stepName)
	if (!cbs) return
	for (const cb of cbs) cb(output)
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
export function onStepComplete(instanceId: string, stepName: string, cb: (output: unknown) => void): () => void {
	let instanceCbs = stepCallbacks.get(instanceId)
	if (!instanceCbs) {
		instanceCbs = new Map()
		stepCallbacks.set(instanceId, instanceCbs)
	}
	let cbs = instanceCbs.get(stepName)
	if (!cbs) {
		cbs = new Set()
		instanceCbs.set(stepName, cbs)
	}
	cbs.add(cb)
	return () => {
		cbs!.delete(cb)
		if (cbs!.size === 0) instanceCbs!.delete(stepName)
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
	ctx: { env: unknown; waitUntil(p: Promise<unknown>): void }
	env: unknown

	constructor(ctx: unknown, env: unknown) {
		this.env = env
		this.ctx = { env, waitUntil: () => {} }
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

	constructor(db: Database, instanceId: string, binding: SqliteWorkflowBinding | null) {
		this.db = db
		this.instanceId = instanceId
		this.binding = binding
	}

	get id(): string {
		return this.instanceId
	}

	async status(): Promise<WorkflowInstanceStatus> {
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
		this.db
			.query("UPDATE workflow_instances SET status = 'paused', updated_at = ? WHERE id = ? AND status IN ('running', 'waiting')")
			.run(Date.now(), this.instanceId)
	}

	async resume(): Promise<void> {
		// If workflow was waiting for an event before pause, restore 'waiting' status
		const waiters = eventWaiters.get(this.instanceId)
		const newStatus = (waiters && waiters.size > 0) ? 'waiting' : 'running'
		this.db
			.query("UPDATE workflow_instances SET status = ?, updated_at = ? WHERE id = ? AND status = 'paused'")
			.run(newStatus, Date.now(), this.instanceId)
	}

	async terminate(options?: { rollback?: boolean }): Promise<void> {
		if (options?.rollback) {
			const row = this.db.query<{ status: string }, [string]>('SELECT status FROM workflow_instances WHERE id = ?').get(this.instanceId)
			if (!row || ['complete', 'errored', 'terminated'].includes(row.status)) return
			this.db.transaction(() => {
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
			})()
			const rollback = this.db.query<RollbackState, [string]>('SELECT * FROM workflow_rollbacks WHERE instance_id = ?').get(this.instanceId)
			if (rollback?.phase === 'requested') abortControllers.get(this.instanceId)?.abort(ROLLBACK_REQUESTED)
			if (!executions.has(this.instanceId)) {
				if (!this.binding) throw new Error('Cannot roll back: instance not associated with a workflow binding')
				this.binding._executeInstance(this.instanceId)
			}
			await executions.get(this.instanceId)
			return
		}
		this.db
			.query("UPDATE workflow_instances SET status = 'terminated', updated_at = ? WHERE id = ? AND status IN ('running', 'paused', 'waiting', 'queued')")
			.run(Date.now(), this.instanceId)
		// Abort via global registry so get()-retrieved instances also work
		const ac = abortControllers.get(this.instanceId)
		ac?.abort(WORKFLOW_TERMINATED)
		fireStatusCallbacks(this.instanceId, 'terminated')
	}

	async restart(options?: { fromStep?: string }): Promise<void> {
		if (!this.binding) throw new Error("Cannot restart: instance not associated with a workflow binding. Use the binding's get() method.")
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

		// Abort existing execution
		const existingAc = abortControllers.get(this.instanceId)
		existingAc?.abort()
		await executions.get(this.instanceId)

		const abortController = new AbortController()
		abortControllers.set(this.instanceId, abortController)

		if (options?.fromStep) {
			// Partial restart: find the step and delete it + all subsequent steps
			const step = this.db
				.query('SELECT completed_at FROM workflow_steps WHERE instance_id = ? AND step_name = ?')
				.get(this.instanceId, options.fromStep) as { completed_at: number } | null
			if (!step) throw new Error(`Step "${options.fromStep}" not found in workflow instance ${this.instanceId}`)
			this.db
				.query('DELETE FROM workflow_steps WHERE instance_id = ? AND completed_at >= ?')
				.run(this.instanceId, step.completed_at)
		} else {
			// Full restart: clear all cached steps
			this.db.query('DELETE FROM workflow_steps WHERE instance_id = ?').run(this.instanceId)
		}
		// Clear step attempt counters
		this.db.query('DELETE FROM workflow_step_attempts WHERE instance_id = ?').run(this.instanceId)
		this.db.query('DELETE FROM workflow_rollbacks WHERE instance_id = ?').run(this.instanceId)
		if (options?.fromStep) {
			this.db.query(
				'DELETE FROM workflow_step_history WHERE instance_id = ? AND step_name NOT IN (SELECT step_name FROM workflow_steps WHERE instance_id = ?)',
			)
				.run(this.instanceId, this.instanceId)
			this.db.query(
				'UPDATE workflow_step_history SET rollback_state = NULL, rollback_attempts = 0, rollback_error = NULL, rollback_error_name = NULL WHERE instance_id = ?',
			)
				.run(this.instanceId)
		} else {
			this.db.query('DELETE FROM workflow_step_history WHERE instance_id = ?').run(this.instanceId)
		}

		this.db
			.query("UPDATE workflow_instances SET status = 'running', output = NULL, error = NULL, error_name = NULL, updated_at = ? WHERE id = ?")
			.run(Date.now(), this.instanceId)

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
		)
	}

	async skipSleep(): Promise<void> {
		const resolver = sleepResolvers.get(this.instanceId)
		if (resolver) {
			resolver()
		}
	}

	async sendEvent(event: { type: string; payload?: unknown }): Promise<void> {
		// Validate event type
		if (!EVENT_TYPE_PATTERN.test(event.type)) {
			throw new Error(`Invalid event type "${event.type}". Must be 1-100 characters, only letters, digits, hyphens and underscores.`)
		}

		// Validate instance state — cannot send events to finished instances
		const row = this.db
			.query('SELECT status FROM workflow_instances WHERE id = ?')
			.get(this.instanceId) as { status: string } | null
		if (row && ['complete', 'errored', 'terminated'].includes(row.status)) {
			throw new Error(`Cannot send event to workflow instance "${this.instanceId}" with status "${row.status}"`)
		}

		// Check if there's a waiter for this event type in-memory
		const waiters = eventWaiters.get(this.instanceId)
		const resolver = waiters?.get(event.type)

		if (resolver) {
			resolver(event.payload)
		} else {
			this.db
				.query('INSERT INTO workflow_events (instance_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)')
				.run(this.instanceId, event.type, event.payload !== undefined ? JSON.stringify(event.payload) : null, Date.now())
		}
	}
}

// --- Binding ---

export class SqliteWorkflowBinding {
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

	/** Abort all running/queued/waiting instances for this workflow */
	abortRunning(): void {
		const rows = this.db.query(
			"SELECT id FROM workflow_instances WHERE workflow_name = ? AND status IN ('running','queued','waiting')",
		).all(this.workflowName) as { id: string }[]
		for (const { id } of rows) {
			abortControllers.get(id)?.abort()
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
			this.db.query('DELETE FROM workflow_step_attempts WHERE instance_id = ?').run(id)
			this.db.query('DELETE FROM workflow_step_history WHERE instance_id = ?').run(id)
			this.db.query('DELETE FROM workflow_rollbacks WHERE instance_id = ?').run(id)
		}
		this.db
			.query("DELETE FROM workflow_instances WHERE workflow_name = ? AND status IN ('complete', 'errored') AND updated_at < ?")
			.run(this.workflowName, cutoff)
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
				'INSERT INTO workflow_instances (id, workflow_name, class_name, params, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
			)
			.run(id, this.workflowName, this.className, JSON.stringify(params), initialStatus, now, now)

		const abortController = new AbortController()
		abortControllers.set(id, abortController)
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
				'INSERT INTO workflow_instances (id, workflow_name, class_name, params, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
			)
			.run(id, this.workflowName, this.className, JSON.stringify(params), 'queued', now, now)

		const abortController = new AbortController()
		abortControllers.set(id, abortController)

		return new SqliteWorkflowInstance(this.db, id, this)
	}

	/** Start execution of a prepared (queued) workflow instance. */
	_executeInstance(id: string): void {
		if (!this._class) throw new Error('Workflow class not wired yet')

		const row = this.db
			.query('SELECT params, created_at FROM workflow_instances WHERE id = ?')
			.get(id) as { params: string | null; created_at: number } | null
		if (!row) throw new Error(`Workflow instance ${id} not found`)

		const params = row.params !== null ? JSON.parse(row.params) : {}

		this.db
			.query("UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ?")
			.run(this.clock.now(), id)

		let ac = abortControllers.get(id)
		if (!ac || ac.signal.aborted) {
			ac = new AbortController()
			abortControllers.set(id, ac)
		}

		console.log(`[workflow] started ${id}`)
		SqliteWorkflowBinding.executeWorkflow(this.db, id, this._class, this._env, params, ac, this.workflowName, this.limits, row.created_at, this.clock)
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
		const row = this.db
			.query('SELECT id FROM workflow_instances WHERE id = ?')
			.get(id) as { id: string } | null
		if (!row) throw new Error(`Workflow instance ${id} not found`)
		return new SqliteWorkflowInstance(this.db, id, this)
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
		switch (op.kind) {
			case 'create': {
				const instance = await this.create({ id: op.id, params: op.params })
				return { kind: 'create', id: instance.id }
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
				await (await this.get(op.instanceId)).restart(op.fromStep ? { fromStep: op.fromStep } : undefined)
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
				return { kind: 'isSleeping', value: isInstanceSleeping(op.instanceId) }
			case 'waitingEventTypes':
				return { kind: 'waitingEventTypes', value: getWaitingEventTypes(op.instanceId) }
		}
	}

	/** Resume any workflow instances that were running/waiting when the process last exited. */
	resumeInterrupted(): void {
		if (!this._class) return

		const rows = this.db
			.query("SELECT id, params, created_at FROM workflow_instances WHERE workflow_name = ? AND status IN ('running', 'waiting')")
			.all(this.workflowName) as { id: string; params: string | null; created_at: number }[]

		for (const row of rows) {
			if (executions.has(row.id)) continue
			const abortController = new AbortController()
			abortControllers.set(row.id, abortController)
			const params = row.params !== null ? JSON.parse(row.params) : {}
			console.log(`[workflow] resuming interrupted instance ${row.id}`)
			// Reset to running before re-executing (waiting status needs to restart from last checkpoint)
			this.db
				.query("UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ?")
				.run(this.clock.now(), row.id)
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

			this.db
				.query("UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ?")
				.run(this.clock.now(), queued.id)

			const abortController = new AbortController()
			abortControllers.set(queued.id, abortController)
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
	): void {
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
			db.query("UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ?").run(resolvedClock.now(), queued.id)
			const params = queued.params !== null ? JSON.parse(queued.params) : {}
			const controller = new AbortController()
			abortControllers.set(queued.id, controller)
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
			)
		}
		const execution = (async () => {
			await Promise.resolve()
			if (abortController.signal.aborted && abortController.signal.reason !== ROLLBACK_REQUESTED) {
				if (abortControllers.get(id) === abortController) abortControllers.delete(id)
				if (abortController.signal.reason === WORKFLOW_TERMINATED) startQueued()
				return
			}
			let workflowTraceId: string | undefined
			let step: WorkflowStepImpl | undefined
			const initialRollback = db.query<RollbackState, [string]>('SELECT * FROM workflow_rollbacks WHERE instance_id = ?').get(id)
			if (initialRollback?.phase === 'requested' && activeController.signal.aborted) {
				activeController = new AbortController()
				abortControllers.set(id, activeController)
			}
			// Rollback termination drains forward steps; reload and default termination abort them.
			const forwardController = new AbortController()
			const onControlAbort = () => {
				if (activeController.signal.reason === ROLLBACK_REQUESTED) {
					activeController = new AbortController()
					abortControllers.set(id, activeController)
					activeController.signal.addEventListener('abort', onControlAbort, { once: true })
				} else {
					forwardController.abort()
				}
			}
			activeController.signal.addEventListener('abort', onControlAbort, { once: true })
			const finishRollback = async (error: Error, state: RollbackState): Promise<void> => {
				if (!step) throw new Error('Workflow step handlers could not be recovered')
				if (activeController.signal.aborted) return
				db.query("UPDATE workflow_rollbacks SET phase = 'running' WHERE instance_id = ?").run(id)
				db.query("UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ?").run(resolvedClock.now(), id)
				let failure: Error | undefined
				try {
					await step.rollback(error, activeController.signal)
				} catch (err) {
					if (activeController.signal.aborted) return
					failure = workflowError(err)
				}
				if (activeController.signal.aborted) return
				db.transaction(() => {
					db.query('UPDATE workflow_rollbacks SET phase = ?, error = ?, error_name = ? WHERE instance_id = ?')
						.run(failure ? 'failed' : 'complete', failure?.message ?? null, failure?.name ?? null, id)
					db.query('UPDATE workflow_instances SET status = ?, updated_at = ? WHERE id = ?').run(state.target_status, resolvedClock.now(), id)
				})()
				fireStatusCallbacks(id, state.target_status)
			}
			try {
				step = new WorkflowStepImpl(forwardController.signal, db, id, resolvedLimits, resolvedClock)
				const instance = new workflowClass({ waitUntil: () => {} }, env)
				const event = { payload: params, timestamp: new Date(createdAt ?? resolvedClock.now()), instanceId: id }
				const result = await startSpan({
					name: `workflow ${workflowName ?? 'run'}`,
					kind: 'server',
					attributes: { 'workflow.name': workflowName ?? 'unknown', 'workflow.instance_id': id },
					workerName: workflowName,
					newTrace: true,
				}, () => {
					workflowTraceId = getActiveContext()?.traceId
					return runWithTimeout(() => instance.run(event, step), undefined, 'Workflow', activeController.signal)
				})
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
				db.query("UPDATE workflow_instances SET status = 'complete', output = ?, updated_at = ? WHERE id = ?")
					.run(JSON.stringify(result), resolvedClock.now(), id)
				// Clean up step attempts on successful completion
				db.query('DELETE FROM workflow_step_attempts WHERE instance_id = ?').run(id)
				console.log(`[workflow] completed ${id}:`, result)
				fireStatusCallbacks(id, 'complete')
			} catch (err) {
				await step?.settlePending()
				if (activeController.signal.aborted) return
				const rollback = db.query<RollbackState, [string]>('SELECT * FROM workflow_rollbacks WHERE instance_id = ?').get(id)
				if (rollback?.phase === 'running' || rollback?.phase === 'requested') {
					const original = db.query<{ error: string | null; error_name: string | null }, [string]>(
						'SELECT error, error_name FROM workflow_instances WHERE id = ?',
					).get(id)
					await step?.settleForwardAttempts()
					await finishRollback(restoredError(original?.error ?? null, original?.error_name ?? null, rollback.original_non_retryable === 1), rollback)
					return
				}
				const errorName = err instanceof Error ? (err.name || err.constructor.name || 'Error') : 'Error'
				const message = err instanceof Error ? err.message : String(err)

				const eligible = db.query<{ count: number }, [string]>(
					'SELECT COUNT(*) AS count FROM workflow_step_history WHERE instance_id = ? AND rollback_registered = 1',
				).get(id)
				if (step && eligible && eligible.count > 0) {
					db.transaction(() => {
						db.query("UPDATE workflow_instances SET status = 'running', error = ?, error_name = ?, updated_at = ? WHERE id = ?")
							.run(message, errorName, resolvedClock.now(), id)
						db.query("INSERT INTO workflow_rollbacks (instance_id, phase, target_status, original_non_retryable) VALUES (?, 'running', 'errored', ?)")
							.run(id, err instanceof NonRetryableError ? 1 : 0)
					})()
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
				db.query("UPDATE workflow_instances SET status = 'errored', error = ?, error_name = ?, updated_at = ? WHERE id = ?")
					.run(message, errorName, resolvedClock.now(), id)
				console.error(`[workflow] failed ${id}:`, err)
				persistError(err, 'workflow', workflowName, workflowTraceId)
				fireStatusCallbacks(id, 'errored')
			} finally {
				activeController.signal.removeEventListener('abort', onControlAbort)
				forwardController.abort()
				if (abortControllers.get(id) === activeController) {
					eventWaiters.delete(id)
					abortControllers.delete(id)
				}
				if (!activeController.signal.aborted || activeController.signal.reason === WORKFLOW_TERMINATED) startQueued()
			}
		})()
		executions.set(id, execution)
		execution.finally(() => {
			if (executions.get(id) === execution) executions.delete(id)
		}).catch(err => console.error(`[workflow] execution interrupted ${id}:`, err))
	}
}
