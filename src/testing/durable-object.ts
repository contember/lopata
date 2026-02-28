import type { InProcessExecutor } from '../bindings/do-executor-inprocess'
import type { DurableObjectNamespaceImpl, SqliteDurableObjectStorage } from '../bindings/durable-object'
import type { SqlStorage } from '../bindings/durable-object'

export class TestDurableObjectStorage {
	private storage: SqliteDurableObjectStorage

	constructor(storage: SqliteDurableObjectStorage) {
		this.storage = storage
	}

	async get<T = unknown>(key: string): Promise<T | undefined>
	async get<T = unknown>(keys: string[]): Promise<Map<string, T>>
	async get<T = unknown>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
		return this.storage.get(keyOrKeys as any)
	}

	async list(
		options?: { prefix?: string; start?: string; startAfter?: string; end?: string; limit?: number; reverse?: boolean },
	): Promise<Map<string, unknown>> {
		return this.storage.list(options)
	}

	async put(key: string, value: unknown): Promise<void>
	async put(entries: Record<string, unknown>): Promise<void>
	async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
		if (typeof keyOrEntries === 'string') {
			return this.storage.put(keyOrEntries, value)
		}
		return this.storage.put(keyOrEntries)
	}

	async delete(key: string): Promise<boolean>
	async delete(keys: string[]): Promise<number>
	async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
		return this.storage.delete(keyOrKeys as any)
	}

	async deleteAll(): Promise<void> {
		return this.storage.deleteAll()
	}

	async getAlarm(): Promise<number | null> {
		return this.storage.getAlarm()
	}

	async setAlarm(scheduledTime: number | Date): Promise<void> {
		return this.storage.setAlarm(scheduledTime)
	}

	async deleteAlarm(): Promise<void> {
		return this.storage.deleteAlarm()
	}
}

export class TestDurableObjectHandle {
	private namespace: DurableObjectNamespaceImpl
	private idStr: string
	private _stub: unknown | null = null

	constructor(namespace: DurableObjectNamespaceImpl, idStr: string) {
		this.namespace = namespace
		this.idStr = idStr
	}

	/** The DO instance ID. */
	get id(): string {
		return this.idStr
	}

	/** RPC proxy stub. Forces executor creation on first access. */
	get stub(): any {
		if (!this._stub) {
			const doId = this.namespace.idFromString(this.idStr)
			this._stub = this.namespace.get(doId)
		}
		return this._stub
	}

	private getExecutor(): InProcessExecutor {
		// Ensure executor exists by accessing the stub
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		this.stub
		const executor = this.namespace._getExecutor(this.idStr)
		if (!executor) throw new Error(`Durable Object executor not found for ${this.idStr}`)
		return executor as InProcessExecutor
	}

	/** Access KV-style storage for this DO instance. */
	get storage(): TestDurableObjectStorage {
		const executor = this.getExecutor()
		return new TestDurableObjectStorage(executor._rawState.storage)
	}

	/** Access SQL storage for this DO instance. */
	get sql(): SqlStorage {
		const executor = this.getExecutor()
		return executor._rawState.storage.sql
	}

	/** Get the scheduled alarm time, or null. */
	async getAlarm(): Promise<number | null> {
		const executor = this.getExecutor()
		return executor._rawState.storage.getAlarm()
	}

	/** Trigger the alarm handler immediately. */
	async triggerAlarm(): Promise<void> {
		return this.namespace.triggerAlarm(this.idStr)
	}

	/** Cancel a scheduled alarm without firing it. */
	async cancelAlarm(): Promise<void> {
		this.namespace.cancelAlarm(this.idStr)
	}

	/** Delete this DO instance and all its data. */
	async delete(): Promise<void> {
		this.namespace.deleteInstance(this.idStr)
		this._stub = null
	}
}

export class TestDurableObjectNamespace {
	private namespace: DurableObjectNamespaceImpl
	private handles: TestDurableObjectHandle[] = []

	constructor(namespace: DurableObjectNamespaceImpl) {
		this.namespace = namespace
	}

	/** Get a DO handle by name (uses idFromName). */
	get(name: string): TestDurableObjectHandle {
		const doId = this.namespace.idFromName(name)
		const handle = new TestDurableObjectHandle(this.namespace, doId.toString())
		this.handles.push(handle)
		return handle
	}

	/** Get a DO handle by raw ID string. */
	getById(idStr: string): TestDurableObjectHandle {
		const handle = new TestDurableObjectHandle(this.namespace, idStr)
		this.handles.push(handle)
		return handle
	}

	/** List all instance IDs in this namespace. */
	listIds(): string[] {
		return this.namespace._listInstanceIds()
	}

	dispose(): void {
		this.handles = []
	}
}
