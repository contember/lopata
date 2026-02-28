import type { Database } from 'bun:sqlite'
import type { SqliteWorkflowBinding, SqliteWorkflowInstance } from '../bindings/workflow'
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

const TERMINAL_STATUSES = new Set(['complete', 'errored', 'terminated'])
const DEFAULT_TIMEOUT = 5000

function timeoutError(what: string, ms: number): Error {
	return new Error(`${what} timed out after ${ms}ms`)
}

export class TestWorkflowInstance {
	private binding: SqliteWorkflowBinding
	private instance: SqliteWorkflowInstance
	private db: Database
	private unsubs: (() => void)[] = []
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

	/** Wait until the instance reaches one of the given statuses. */
	async waitForStatus(...statuses: string[]): Promise<{ status: string; output?: unknown; error?: { name: string; message: string } }> {
		const timeout = DEFAULT_TIMEOUT
		const targets = new Set(statuses)

		// Check current status first
		const current = await this.instance.status()
		if (targets.has(current.status)) return current

		return new Promise<{ status: string; output?: unknown; error?: { name: string; message: string } }>((resolve, reject) => {
			const timer = setTimeout(() => {
				unsub()
				reject(timeoutError(`waitForStatus(${statuses.join(', ')})`, timeout))
			}, timeout)

			const unsub = onStatusChange(this.instance.id, (status) => {
				if (targets.has(status)) {
					clearTimeout(timer)
					unsub()
					this.instance.status().then(resolve, reject)
				}
			})
			this.unsubs.push(unsub)
		})
	}

	/** Wait until a specific step completes. Returns its output. */
	async waitForStep(name: string): Promise<unknown> {
		const timeout = DEFAULT_TIMEOUT

		// Check if step already cached in DB
		const cached = this.db
			.query('SELECT output FROM workflow_steps WHERE instance_id = ? AND step_name = ?')
			.get(this.instance.id, name) as { output: string | null } | null
		if (cached) return JSON.parse(cached.output!)

		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				unsub()
				reject(timeoutError(`waitForStep("${name}")`, timeout))
			}, timeout)

			const unsub = onStepComplete(this.instance.id, name, (output) => {
				clearTimeout(timer)
				unsub()
				resolve(output)
			})
			this.unsubs.push(unsub)
		})
	}

	/** Wait until the instance is sleeping, then skip the sleep. */
	async skipSleep(): Promise<void> {
		const timeout = DEFAULT_TIMEOUT

		// Already sleeping — skip immediately
		if (isInstanceSleeping(this.instance.id)) {
			await this.instance.skipSleep()
			return
		}

		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				unsub()
				reject(timeoutError('skipSleep()', timeout))
			}, timeout)

			const unsub = onSleepRegistered(this.instance.id, () => {
				clearTimeout(timer)
				unsub()
				this.instance.skipSleep().then(resolve, reject)
			})
			this.unsubs.push(unsub)
		})
	}

	/** Wait until the instance is waiting for an event of the given type. */
	async waitForEvent(type: string): Promise<void> {
		const timeout = DEFAULT_TIMEOUT

		// Check if already waiting
		if (getWaitingEventTypes(this.instance.id).includes(type)) return

		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				unsub()
				reject(timeoutError(`waitForEvent("${type}")`, timeout))
			}, timeout)

			const unsub = onEventWaitRegistered(this.instance.id, type, () => {
				clearTimeout(timer)
				unsub()
				resolve()
			})
			this.unsubs.push(unsub)
		})
	}

	/** Send an event to the workflow instance. */
	async sendEvent(event: { type: string; payload?: unknown }): Promise<void> {
		await this.instance.sendEvent(event)
	}

	/** Get all completed steps as a Map<name, output>. */
	async steps(): Promise<Map<string, unknown>> {
		const rows = this.db
			.query('SELECT step_name, output FROM workflow_steps WHERE instance_id = ? ORDER BY completed_at ASC')
			.all(this.instance.id) as { step_name: string; output: string | null }[]
		const result = new Map<string, unknown>()
		for (const row of rows) {
			result.set(row.step_name, row.output !== null ? JSON.parse(row.output) : undefined)
		}
		return result
	}

	/** Get the output of a single step. */
	async stepResult(name: string): Promise<unknown> {
		const row = this.db
			.query('SELECT output FROM workflow_steps WHERE instance_id = ? AND step_name = ?')
			.get(this.instance.id, name) as { output: string | null } | null
		if (!row) throw new Error(`Step "${name}" not found in workflow instance ${this.instance.id}`)
		return row.output !== null ? JSON.parse(row.output) : undefined
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
	async terminate(): Promise<void> {
		await this.instance.terminate()
	}

	/** Get the current status. */
	async status(): Promise<{ status: string; output?: unknown; error?: { name: string; message: string } }> {
		return this.instance.status()
	}

	/** Mock a step to return the given result without running the callback. */
	mockStep(name: string, result: unknown): this {
		registerStepMock(this.instance.id, name, { type: 'result', value: result })
		return this
	}

	/** Mock a step to throw the given error. */
	mockStepError(name: string, error: Error, opts?: { times?: number }): this {
		registerStepMock(this.instance.id, name, { type: 'error', value: error, times: opts?.times })
		return this
	}

	/** Mock a step to time out. */
	mockStepTimeout(name: string): this {
		registerStepMock(this.instance.id, name, { type: 'timeout' })
		return this
	}

	/** Disable all sleeps for this instance — they resolve immediately. */
	disableSleeps(): this {
		registerSleepDisable(this.instance.id)
		return this
	}

	/** Pre-deliver an event so waitForEvent() resolves immediately. */
	mockEvent(event: { type: string; payload?: unknown }): this {
		registerEventMock(this.instance.id, event.type, event.payload)
		return this
	}

	/** Mock an event wait to time out immediately. */
	mockEventTimeout(eventType: string): this {
		registerEventTimeoutMock(this.instance.id, eventType)
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
		clearInstanceMocks(this.instance.id)
	}
}

export interface TestWorkflowRun {
	instance: TestWorkflowInstance
	result: Promise<{ status: string; output?: unknown; error?: { name: string; message: string } }>
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
				const unsub = onSleepRegistered(rawInstance.id, () => {
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
