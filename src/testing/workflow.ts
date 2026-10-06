import type { Database } from 'bun:sqlite'
import type { SqliteWorkflowBinding, SqliteWorkflowInstance, WorkflowInstanceStatus } from '../bindings/workflow'
import {
	clearInstanceMocks,
	getWaitingEventTypes,
	isInstanceSleeping,
	onEventWaitRegistered,
	onSleepRegistered,
	onStatusChange,
	onStepComplete,
	registerEventMock,
	registerEventTimeoutMock,
	registerSleepDisable,
	registerStepMock,
} from '../bindings/workflow'
import { legacyStepName, WorkflowStore } from '../bindings/workflow-store'
import type { WorkflowOccurrenceRecord, WorkflowStepKey } from '../bindings/workflow-store'

const TERMINAL_STATUSES = new Set(['complete', 'errored', 'terminated'])
const DEFAULT_TIMEOUT = 5000

function timeoutError(what: string, ms: number): Error {
	return new Error(`${what} timed out after ${ms}ms`)
}

function stepOutput(row: WorkflowOccurrenceRecord, store: WorkflowStore): { output: unknown } | null {
	if (row.key.type === 'sleep' && row.deadline !== null) {
		return { output: { until: row.method === 'sleepUntil' ? new Date(row.deadline).toISOString() : row.deadline } }
	}
	if (!row.checkpoint) return null
	switch (row.checkpoint.kind) {
		case 'json':
			return { output: JSON.parse(row.checkpoint.serialized) }
		case 'stream':
			return { output: store.openStream(row.checkpoint.streamId) }
		case 'undefined':
			return { output: undefined }
	}
}

export class TestWorkflowInstance {
	private binding: SqliteWorkflowBinding
	private instance: SqliteWorkflowInstance
	private db: Database
	private unsubs: (() => void)[] = []
	private registryIds = new Set<string>()
	private started = true

	constructor(binding: SqliteWorkflowBinding, instance: SqliteWorkflowInstance, db: Database, prepared = false) {
		this.binding = binding
		this.instance = instance
		this.db = db
		this.started = !prepared
	}

	get id(): string {
		return this.instance.id
	}

	private registryId(): string {
		const key = this.instance._registryId()
		this.registryIds.add(key)
		return key
	}

	/** Wait until the instance reaches one of the given statuses. */
	async waitForStatus(...statuses: string[]): Promise<WorkflowInstanceStatus> {
		const timeout = DEFAULT_TIMEOUT
		const targets = new Set(statuses)

		// Check current status first
		const current = await this.instance.status()
		if (targets.has(current.status)) return current

		return new Promise<WorkflowInstanceStatus>((resolve, reject) => {
			const timer = setTimeout(() => {
				unsub()
				reject(timeoutError(`waitForStatus(${statuses.join(', ')})`, timeout))
			}, timeout)

			const unsub = onStatusChange(this.registryId(), (status) => {
				if (targets.has(status)) {
					clearTimeout(timer)
					unsub()
					this.instance.status().then(resolve, reject)
				}
			})
			this.unsubs.push(() => {
				clearTimeout(timer)
				unsub()
			})
		})
	}

	/** Wait until a specific step completes. Returns its output. */
	async waitForStep(name: string, selector?: Omit<WorkflowStepKey, 'name'>): Promise<unknown> {
		const timeout = DEFAULT_TIMEOUT

		// Check if step already cached in DB
		const cached = this.findStep(name, selector)
		if (cached) return cached.output

		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				unsub()
				reject(timeoutError(`waitForStep("${name}")`, timeout))
			}, timeout)

			const unsub = onStepComplete(
				this.registryId(),
				name,
				(output) => {
					clearTimeout(timer)
					unsub()
					resolve(output)
				},
				selector ? { ...selector, name } : undefined,
			)
			this.unsubs.push(() => {
				clearTimeout(timer)
				unsub()
			})
		})
	}

	/** Wait until the instance is sleeping, then skip the sleep. */
	async skipSleep(): Promise<void> {
		const timeout = DEFAULT_TIMEOUT

		// Already sleeping — skip immediately
		if (isInstanceSleeping(this.registryId())) {
			await this.instance.skipSleep()
			return
		}

		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				unsub()
				reject(timeoutError('skipSleep()', timeout))
			}, timeout)

			const unsub = onSleepRegistered(this.registryId(), () => {
				clearTimeout(timer)
				unsub()
				this.instance.skipSleep().then(resolve, reject)
			})
			this.unsubs.push(() => {
				clearTimeout(timer)
				unsub()
			})
		})
	}

	/** Wait until the instance is waiting for an event of the given type. */
	async waitForEvent(type: string): Promise<void> {
		const timeout = DEFAULT_TIMEOUT

		// Check if already waiting
		if (getWaitingEventTypes(this.registryId()).includes(type)) return

		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				unsub()
				reject(timeoutError(`waitForEvent("${type}")`, timeout))
			}, timeout)

			const unsub = onEventWaitRegistered(this.registryId(), type, () => {
				clearTimeout(timer)
				unsub()
				resolve()
			})
			this.unsubs.push(() => {
				clearTimeout(timer)
				unsub()
			})
		})
	}

	/** Send an event to the workflow instance. */
	async sendEvent(event: { type: string; payload?: unknown }): Promise<void> {
		await this.instance.sendEvent(event)
	}

	/** Get all completed steps as a Map<name, output>. */
	async steps(): Promise<Map<string, unknown>> {
		const store = new WorkflowStore(this.db)
		const { occurrences, legacy } = store.readDetail(this.id, this.binding._getWorkflowName())
		const result = new Map<string, unknown>()
		const seen = new Set<string>()
		for (const row of occurrences) {
			const name = legacyStepName(row.method, row.key.name)
			if (seen.has(name)) continue
			seen.add(name)
			const cached = stepOutput(row, store)
			if (cached && !result.has(name)) result.set(name, cached.output)
		}
		for (const row of legacy) {
			if (row.completed_at !== null && !result.has(row.step_name)) result.set(row.step_name, row.output === null ? undefined : JSON.parse(row.output))
		}
		return result
	}

	/** Get the output of a single step. */
	async stepResult(name: string, selector?: Omit<WorkflowStepKey, 'name'>): Promise<unknown> {
		const cached = this.findStep(name, selector)
		if (!cached) throw new Error(`Step "${name}" not found in workflow instance ${this.instance.id}`)
		return cached.output
	}

	private findStep(name: string, selector?: Omit<WorkflowStepKey, 'name'>) {
		const store = new WorkflowStore(this.db)
		const { occurrences, legacy } = store.readDetail(this.id, this.binding._getWorkflowName())
		const row = occurrences.find(row =>
			selector
				? row.key.name === name && row.key.type === selector.type && row.key.count === selector.count
				: legacyStepName(row.method, row.key.name) === name
		)
		if (row) return stepOutput(row, store)
		const unresolved = selector ? undefined : legacy.find(row => row.step_name === name && row.completed_at !== null)
		return unresolved ? { output: unresolved.output === null ? undefined : JSON.parse(unresolved.output) } : null
	}

	/** Pause the workflow. */
	async pause(): Promise<void> {
		await this.instance.pause()
	}

	/** Resume the workflow. */
	async resume(): Promise<void> {
		await this.instance.resume()
	}

	/** Terminate the workflow. */
	async terminate(options?: { rollback?: boolean }): Promise<void> {
		await this.instance.terminate(options)
	}
	async delete(): Promise<void> {
		await this.instance.delete()
		this.dispose()
	}

	/** Get the current status. */
	async status(): Promise<WorkflowInstanceStatus> {
		return this.instance.status()
	}

	/** Mock a step to return the given result without running the callback. */
	mockStep(name: string, result: unknown, selector?: Omit<WorkflowStepKey, 'name'>): this {
		registerStepMock(this.registryId(), name, {
			type: 'result',
			value: result,
		}, selector ? { ...selector, name } : undefined)
		return this
	}

	/** Mock a step to throw the given error. */
	mockStepError(name: string, error: Error, opts?: { times?: number }, selector?: Omit<WorkflowStepKey, 'name'>): this {
		registerStepMock(
			this.registryId(),
			name,
			{ type: 'error', value: error, times: opts?.times },
			selector ? { ...selector, name } : undefined,
		)
		return this
	}

	/** Mock a step to time out. */
	mockStepTimeout(name: string, selector?: Omit<WorkflowStepKey, 'name'>): this {
		registerStepMock(this.registryId(), name, { type: 'timeout' }, selector ? { ...selector, name } : undefined)
		return this
	}

	/** Disable all sleeps for this instance — they resolve immediately. */
	disableSleeps(): this {
		registerSleepDisable(this.registryId())
		return this
	}

	/** Pre-deliver an event so waitForEvent() resolves immediately. */
	mockEvent(event: { type: string; payload?: unknown }): this {
		registerEventMock(this.registryId(), event.type, event.payload)
		return this
	}

	/** Mock an event wait to time out immediately. */
	mockEventTimeout(eventType: string): this {
		registerEventTimeoutMock(this.registryId(), eventType)
		return this
	}

	/** Start a prepared instance (created via TestWorkflowBinding.prepare()). */
	async start(): Promise<void> {
		if (this.started) throw new Error('Instance already started')
		this.started = true
		this.binding._executeInstance(this.instance.id)
	}

	/** @internal Add an unsubscribe function to be cleaned up on dispose. */
	_addUnsub(unsub: () => void): void {
		this.unsubs.push(unsub)
	}

	/** Clean up all listeners and mocks. */
	dispose(): void {
		for (const unsub of this.unsubs) unsub()
		this.unsubs = []
		for (const key of this.registryIds) clearInstanceMocks(key)
		this.registryIds.clear()
	}
}

export interface TestWorkflowRun {
	instance: TestWorkflowInstance
	result: Promise<WorkflowInstanceStatus>
}

export class TestWorkflowBinding {
	private binding: SqliteWorkflowBinding
	private db: Database
	private instances: TestWorkflowInstance[] = []

	constructor(binding: SqliteWorkflowBinding, db: Database) {
		this.binding = binding
		this.db = db
	}

	/** Create a workflow instance with manual step-by-step control. */
	async create(opts?: { id?: string; params?: unknown }): Promise<TestWorkflowInstance> {
		const instance = await this.binding.create(opts)
		const testInstance = new TestWorkflowInstance(this.binding, instance, this.db)
		this.instances.push(testInstance)
		return testInstance
	}

	/** Create a workflow instance without starting it. Register mocks, then call instance.start(). */
	async prepare(opts?: { id?: string; params?: unknown }): Promise<TestWorkflowInstance> {
		const instance = await this.binding._createPrepared(opts)
		const testInstance = new TestWorkflowInstance(this.binding, instance, this.db, true)
		this.instances.push(testInstance)
		return testInstance
	}

	/** Get an existing workflow instance by ID. */
	async get(id: string): Promise<TestWorkflowInstance> {
		const instance = await this.binding.get(id)
		const testInstance = new TestWorkflowInstance(this.binding, instance, this.db)
		this.instances.push(testInstance)
		return testInstance
	}

	async deleteBatch(instanceIds: string[]) {
		const result = await this.binding.deleteBatch(instanceIds)
		const deleted = new Set(result.deleted.map(entry => entry.id))
		for (const instance of this.instances) if (deleted.has(instance.id)) instance.dispose()
		return result
	}

	/** Run a workflow with auto-sleep-skip. Returns a result promise that resolves on completion. */
	async run(opts?: { id?: string; params?: unknown; mocks?: (instance: TestWorkflowInstance) => void }): Promise<TestWorkflowRun> {
		let rawInstance: SqliteWorkflowInstance
		let testInstance: TestWorkflowInstance

		if (opts?.mocks) {
			// Use prepare+start to allow mocks to be registered before execution
			rawInstance = await this.binding._createPrepared(opts)
			testInstance = new TestWorkflowInstance(this.binding, rawInstance, this.db, true)
			this.instances.push(testInstance)
			testInstance.disableSleeps()
			opts.mocks(testInstance)
			testInstance.start()
		} else {
			rawInstance = await this.binding.create(opts)
			testInstance = new TestWorkflowInstance(this.binding, rawInstance, this.db)
			this.instances.push(testInstance)

			// Auto-skip sleeps
			const autoSkip = () => {
				const unsub = onSleepRegistered(rawInstance._registryId(), () => {
					rawInstance.skipSleep().then(() => {
						// Re-register for next sleep
						autoSkip()
					})
				})
				testInstance._addUnsub(unsub)
			}
			autoSkip()
		}

		// Result promise
		const result = testInstance.waitForStatus('complete', 'errored', 'terminated')

		return { instance: testInstance, result }
	}

	/** Clean up all tracked instances. */
	dispose(): void {
		for (const inst of this.instances) inst.dispose()
		this.instances = []
	}
}
